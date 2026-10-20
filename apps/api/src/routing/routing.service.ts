import {
  type RoutingOverview,
  type RoutingOverviewRule,
  type RoutingTestInput,
  type RoutingTestResult,
  ruleActionSchema,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { canWorkDepartment, isInRotation } from '../assignment/rotation.js';
import { reachesDepartment } from '../brands/department-scope.js';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { allEntries, resolveEntry, toEntryPoint } from './entry-points.js';
import { withDryRun } from './read-only.js';
import { type RoutingTestDeps, walkRouting } from './routing-test.js';

/**
 * The Routing tab and Test routing (M14-09), both `ticketing:manage`.
 *
 * **Department scope.** Mailboxes, bots, accounts and the form are brand-wide
 * configuration, but each files into one department. A Team Leader whose scope
 * is some departments sees and tests only the doors that file into them, and a
 * door outside it answers 404 as an unknown one does. A rule that moves the
 * sample into a department outside the scope is still shown (rules are
 * brand-wide to read, DOMAIN-RULES §1.2), but the rotation of that department
 * is not: the assignment step says the reader's scope ends there.
 */

const actionsSchema = z.array(ruleActionSchema);

export class RoutingService {
  readonly #deps: RoutingTestDeps;

  constructor(deps: RoutingTestDeps) {
    this.#deps = deps;
  }

  async overview(context: TicketingContext): Promise<RoutingOverview> {
    const { tx, brandId, actor } = context;
    const { repository, assignment } = this.#deps;
    const reaches = (departmentId: string): boolean => reachesDepartment(actor, departmentId);

    const [entries, ruleRows, departmentRows] = await Promise.all([
      allEntries(repository, tx, brandId),
      repository.createdRules(tx),
      assignment.departments(tx, brandId),
    ]);
    const visible = entries.filter(
      (entry) => entry.departmentId === null || reaches(entry.departmentId),
    );
    const names = await repository.departments(
      tx,
      brandId,
      visible.flatMap((entry) => (entry.departmentId === null ? [] : [entry.departmentId])),
    );

    const overviewRules: RoutingOverviewRule[] = ruleRows.map((row) => {
      const actions = actionsSchema.safeParse(row.actions);
      return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        actions: actions.success ? actions.data : [],
      };
    });

    const inScope = departmentRows.filter((department) => reaches(department.id));
    const assignments = await Promise.all(
      inScope.map(async (department) => {
        const candidates = await assignment.candidates(tx, brandId, department.id);
        return {
          department: { id: department.id, name: department.name, nameAr: department.nameAr },
          mode: department.assignmentMode,
          loadCap: department.loadCap,
          peopleInRotation: candidates.filter(
            (candidate) => canWorkDepartment(candidate, department.id) && isInRotation(candidate),
          ).length,
        };
      }),
    );

    return {
      entryPoints: visible.map((entry) =>
        toEntryPoint(
          entry,
          entry.departmentId === null ? null : (names.get(entry.departmentId) ?? null),
        ),
      ),
      rules: overviewRules,
      triageRules: overviewRules
        .filter(
          (rule) => rule.enabled && rule.actions.some((action) => action.type === 'ai_triage'),
        )
        .map((rule) => ({ id: rule.id, name: rule.name })),
      assignment: assignments,
    };
  }

  /** Nothing is created, sent or logged: the walk runs in a read-only savepoint that is rolled back. */
  async test(context: TicketingContext, request: RoutingTestInput): Promise<RoutingTestResult> {
    const { tx, brandId, actor } = context;
    const entry = await resolveEntry(this.#deps.repository, tx, brandId, request);
    const reaches = (departmentId: string): boolean => reachesDepartment(actor, departmentId);
    if (entry.departmentId === null || !reaches(entry.departmentId)) {
      throw new NotFoundException('No such entry point');
    }
    const resolved = { ...entry, departmentId: entry.departmentId };

    const result = await withDryRun(tx, (savepoint) =>
      walkRouting(this.#deps, savepoint, { brandId, reaches }, request, resolved),
    );
    /* c8 ignore next 3 -- the department was read a moment ago in the same transaction. */
    if (result === undefined) {
      throw new NotFoundException('No such entry point');
    }

    return result;
  }
}
