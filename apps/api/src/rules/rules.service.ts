import {
  accounts,
  customFieldDefs,
  type DbTransaction,
  departments,
  tags,
  teams,
  ticketStatuses,
  userBrandRoles,
  users,
  type WorkflowRuleRow,
} from '@helpdock/db';
import {
  evaluateConditions,
  MAX_RULES_PER_BRAND,
  RULE_OPTIONS_ACCOUNTS_MAX,
  RULE_RUNS_PAGE_SIZE,
  type RuleAction,
  type RuleBuilderOptions,
  type RuleConditions,
  type RuleDraft,
  type RuleKind,
  type RuleReorderRequest,
  type RuleRunQuery,
  type RuleTestRunResult,
  type RuleTrigger,
  ruleActionSchema,
  ruleConditionsSchema,
  ruleDraftSchema,
  type WorkflowRule,
  type WorkflowRuleList,
  type WorkflowRun,
  type WorkflowRunList,
} from '@helpdock/schemas';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { writeTicketingAudit } from '../ticketing/audit.js';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import type { BusinessHoursProbe, CannedResponseCatalog } from './ports.js';
import type { RulesRepository, RunRow } from './rules.repository.js';
import { followOnsOf, previewActions, ticketNumberOf } from './test-run.js';
import { loadTicketFacts } from './ticket-facts.js';

/**
 * The builder's half of M3-03 to M3-05: a brand's rules, their order, their
 * log, and the test run. Every route is `ticketing:manage`, which DOMAIN-RULES
 * §1.2 gives the Admin and the Team Leader ("rules").
 *
 * **A rule is brand-wide**, so changing one is refused to a Team Leader whose
 * scope is narrower than the brand: a rule saved by the lead of Billing would
 * act on Returns' tickets too. Reading the rules and the log is not refused —
 * the log's rows are department-scoped, so each reader sees the runs on the
 * tickets they can see.
 */

const storedSchema = z.object({
  conditions: ruleConditionsSchema,
  actions: z.array(ruleActionSchema),
});

const toRule = (
  row: WorkflowRuleRow,
  stats: { lastAppliedAt: Date | null; appliedLast30Days: number },
): WorkflowRule => {
  const stored = storedSchema.parse({ conditions: row.conditions, actions: row.actions });

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    trigger: row.trigger as RuleTrigger | null,
    intervalMinutes: row.intervalMinutes as WorkflowRule['intervalMinutes'],
    conditions: stored.conditions,
    actions: stored.actions,
    position: row.position,
    enabled: row.enabled,
    lastAppliedAt: stats.lastAppliedAt?.toISOString() ?? null,
    appliedLast30Days: stats.appliedLast30Days,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

const NO_STATS = { lastAppliedAt: null, appliedLast30Days: 0 };

/** The ids a rule names, by what they name, so each can be checked against the brand. */
const referencesOf = (conditions: RuleConditions, actions: readonly RuleAction[]) => {
  const ids = {
    statuses: new Set<string>(),
    departments: new Set<string>(),
    teams: new Set<string>(),
    tags: new Set<string>(),
    users: new Set<string>(),
  };
  const byField: Partial<Record<string, Set<string>>> = {
    status: ids.statuses,
    department: ids.departments,
    team: ids.teams,
    tag: ids.tags,
    assignee: ids.users,
  };

  for (const condition of conditions.groups.flatMap((group) => group.conditions)) {
    for (const value of condition.values) {
      byField[condition.field]?.add(value);
    }
  }
  for (const action of actions) {
    if (action.type === 'set_status') ids.statuses.add(action.statusId);
    if (action.type === 'assign_team') ids.teams.add(action.teamId);
    if (action.type === 'assign_agent') ids.users.add(action.userId);
    if (action.type === 'add_tag' || action.type === 'remove_tag') ids.tags.add(action.tagId);
    if (action.type === 'notify' && action.recipient.kind === 'team') {
      ids.teams.add(action.recipient.teamId);
    }
    if (action.type === 'notify' && action.recipient.kind === 'user') {
      ids.users.add(action.recipient.userId);
    }
  }

  return ids;
};

export interface RulesServiceDeps {
  readonly rules: RulesRepository;
  readonly assignment: AssignmentRepository;
  readonly businessHours: BusinessHoursProbe;
  readonly cannedResponses: CannedResponseCatalog;
}

export class RulesService {
  readonly #deps: RulesServiceDeps;

  constructor(deps: RulesServiceDeps) {
    this.#deps = deps;
  }

  get #rules(): RulesRepository {
    return this.#deps.rules;
  }

  async list(context: TicketingContext, kind?: RuleKind): Promise<WorkflowRuleList> {
    const rows = await this.#rules.list(context.tx, kind);
    return { rules: rows.map(({ rule, ...stats }) => toRule(rule, stats)) };
  }

  async create(context: TicketingContext, draft: RuleDraft): Promise<WorkflowRule> {
    requireBrandWide(context);
    const { tx } = context;

    if ((await this.#rules.countAll(tx)) >= MAX_RULES_PER_BRAND) {
      throw new ConflictException(`A brand holds at most ${MAX_RULES_PER_BRAND} rules`);
    }
    await this.#requireReferences(tx, context.brandId, draft);

    const row = await this.#rules.insert(tx, {
      brandId: context.brandId,
      ...columnsOf(draft),
      position: await this.#rules.nextPosition(tx, draft.kind),
      createdById: context.actor.userId,
    });
    await this.#audit(context, 'workflow_rule.created', row.id, { name: row.name });

    return toRule(row, NO_STATS);
  }

  async update(context: TicketingContext, ruleId: string, draft: RuleDraft): Promise<WorkflowRule> {
    requireBrandWide(context);
    const { tx } = context;
    const current = await this.#require(tx, ruleId);
    await this.#requireReferences(tx, context.brandId, draft);

    const row = await this.#rules.update(tx, ruleId, {
      ...columnsOf(draft),
      // A rule that changes kind joins the end of the other list.
      ...(current.kind === draft.kind
        ? {}
        : { position: await this.#rules.nextPosition(tx, draft.kind) }),
    });
    /* c8 ignore next 3 -- read through the same transaction a moment ago. */
    if (row === undefined) {
      throw new NotFoundException('No such rule');
    }
    await this.#audit(context, 'workflow_rule.updated', row.id, { name: row.name });

    return this.#withStats(tx, row);
  }

  async setEnabled(
    context: TicketingContext,
    ruleId: string,
    enabled: boolean,
  ): Promise<WorkflowRule> {
    requireBrandWide(context);
    await this.#require(context.tx, ruleId);

    const row = await this.#rules.update(context.tx, ruleId, { enabled });
    /* c8 ignore next 3 -- as above. */
    if (row === undefined) {
      throw new NotFoundException('No such rule');
    }
    await this.#audit(context, 'workflow_rule.updated', row.id, { enabled });

    return this.#withStats(context.tx, row);
  }

  async remove(context: TicketingContext, ruleId: string): Promise<void> {
    requireBrandWide(context);
    const current = await this.#require(context.tx, ruleId);

    await this.#rules.remove(context.tx, ruleId);
    await this.#audit(context, 'workflow_rule.deleted', ruleId, { name: current.name });
  }

  async reorder(
    context: TicketingContext,
    { kind, ruleIds }: RuleReorderRequest,
  ): Promise<WorkflowRuleList> {
    requireBrandWide(context);
    const existing = await this.#rules.idsOfKind(context.tx, kind);

    const unique = new Set(ruleIds);
    if (
      unique.size !== ruleIds.length ||
      unique.size !== existing.length ||
      existing.some((id) => !unique.has(id))
    ) {
      throw new BadRequestException(`The new order must name every ${kind} rule exactly once`);
    }

    await this.#rules.setPositions(context.tx, ruleIds);
    await this.#audit(context, 'workflow_rule.reordered', context.brandId, { kind, ruleIds });

    return this.list(context, kind);
  }

  async runs(context: TicketingContext, query: RuleRunQuery): Promise<WorkflowRunList> {
    const number = query.q === undefined ? undefined : ticketNumberOf(query.q);
    const rows = await this.#rules.runs(context.tx, {
      result: query.result,
      ruleId: query.ruleId,
      ticketNumber: number,
      ruleName: query.q === undefined || query.q === '' ? undefined : query.q,
      limit: RULE_RUNS_PAGE_SIZE,
    });
    const names = await this.#rules.names(context.tx, [
      ...new Set(rows.flatMap((row) => row.chain)),
    ]);

    return { runs: rows.map((row) => toRun(row, names)) };
  }

  async options(context: TicketingContext): Promise<RuleBuilderOptions> {
    const { tx, brandId } = context;
    const [statuses, departmentRows, teamRows, tagRows, members, accountRows, fields, canned] =
      await Promise.all([
        tx
          .select({
            id: ticketStatuses.id,
            name: ticketStatuses.name,
            nameAr: ticketStatuses.nameAr,
          })
          .from(ticketStatuses)
          .orderBy(asc(ticketStatuses.sortOrder)),
        tx
          .select({ id: departments.id, name: departments.name, nameAr: departments.nameAr })
          .from(departments)
          .orderBy(asc(departments.sortOrder), asc(departments.name)),
        tx
          .select({ id: teams.id, name: teams.name, departmentId: teams.departmentId })
          .from(teams)
          .orderBy(asc(teams.sortOrder), asc(teams.name)),
        tx
          .select({ id: tags.id, name: tags.name, nameAr: tags.nameAr })
          .from(tags)
          .orderBy(asc(tags.sortOrder), asc(tags.name)),
        tx
          .select({ id: users.id, name: users.name })
          .from(userBrandRoles)
          .innerJoin(users, eq(users.id, userBrandRoles.userId))
          .where(and(eq(userBrandRoles.brandId, brandId), isNull(users.deactivatedAt)))
          .orderBy(asc(users.name)),
        tx
          .select({ id: accounts.id, name: accounts.name })
          .from(accounts)
          .orderBy(asc(accounts.name))
          .limit(RULE_OPTIONS_ACCOUNTS_MAX),
        tx
          .select({
            key: customFieldDefs.key,
            label: customFieldDefs.label,
            labelAr: customFieldDefs.labelAr,
          })
          .from(customFieldDefs)
          .where(eq(customFieldDefs.target, 'ticket'))
          .orderBy(asc(customFieldDefs.sortOrder)),
        this.#deps.cannedResponses.list(tx),
      ]);

    return {
      statuses,
      departments: departmentRows,
      teams: teamRows,
      tags: tagRows,
      members,
      accounts: accountRows,
      customFields: fields,
      cannedResponses: canned,
    };
  }

  /** M3-05. Reads only: nothing is changed, sent or logged. */
  async testRun(
    context: TicketingContext,
    request: {
      rule: RuleDraft;
      ticket: string;
      ruleId?: string | undefined;
    },
  ): Promise<RuleTestRunResult> {
    const { tx, brandId } = context;
    const number = ticketNumberOf(request.ticket);
    const ticketId =
      number === undefined ? undefined : await this.#rules.ticketIdByNumber(tx, brandId, number);
    const facts = ticketId === undefined ? undefined : await loadTicketFacts(tx, ticketId);
    if (facts === undefined) {
      return { outcome: null };
    }

    const now = new Date();
    const evaluation = {
      now,
      withinBusinessHours: await this.#deps.businessHours.isOpen(tx, {
        brandId,
        departmentId: facts.departmentId,
        at: now,
      }),
      includeText: true,
    };
    const outcome = evaluateConditions(request.rule.conditions, facts, evaluation);
    const summary = await this.#rules.testTicketSummary(tx, facts);

    if (!outcome.matched || facts.inert) {
      return {
        outcome: {
          ticket: summary,
          wouldRun: false,
          groups: [...outcome.groups],
          actions: [],
          followOns: [],
        },
      };
    }

    const { outcomes, simulation } = await previewActions(
      tx,
      brandId,
      this.#deps,
      facts,
      request.rule.actions,
    );

    return {
      outcome: {
        ticket: summary,
        wouldRun: true,
        groups: [...outcome.groups],
        actions: outcomes,
        followOns: await followOnsOf(tx, this.#deps, simulation, request.ruleId, evaluation),
      },
    };
  }

  async #require(tx: DbTransaction, ruleId: string): Promise<WorkflowRuleRow> {
    const row = await this.#rules.find(tx, ruleId);
    if (row === undefined) {
      throw new NotFoundException('No such rule');
    }
    return row;
  }

  async #withStats(tx: DbTransaction, row: WorkflowRuleRow): Promise<WorkflowRule> {
    const listed = (await this.#rules.list(tx, row.kind)).find((entry) => entry.rule.id === row.id);
    return toRule(row, listed ?? NO_STATS);
  }

  /**
   * Every id the rule names has to be this brand's. The transaction cannot see
   * another brand's rows, so "not found" answers both "no such id" and "not
   * yours", as it does everywhere else.
   */
  async #requireReferences(tx: DbTransaction, brandId: string, draft: RuleDraft): Promise<void> {
    const ids = referencesOf(draft.conditions, draft.actions);
    const checks = [
      ['status', ids.statuses],
      ['department', ids.departments],
      ['team', ids.teams],
      ['tag', ids.tags],
    ] as const;

    for (const [what, wanted] of checks) {
      if (
        wanted.size > 0 &&
        (await this.#rules.countExisting(tx, what, [...wanted])) !== wanted.size
      ) {
        throw new BadRequestException(`The rule names a ${what} that is not in this brand`);
      }
    }
    if (
      ids.users.size > 0 &&
      (await this.#rules.countMembers(tx, brandId, [...ids.users])) !== ids.users.size
    ) {
      throw new BadRequestException('The rule names a person who is not in this brand');
    }
  }

  #audit(
    context: TicketingContext,
    action:
      | 'workflow_rule.created'
      | 'workflow_rule.updated'
      | 'workflow_rule.deleted'
      | 'workflow_rule.reordered',
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    return writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action,
      targetType: 'workflow_rule',
      targetId,
      meta,
    });
  }
}

/** A Team Leader restricted to some departments may read rules, not change them. */
const requireBrandWide = (context: TicketingContext): void => {
  if (context.actor.departmentIds !== 'all') {
    throw new ForbiddenException(
      'Workflow rules act on every department, so only someone whose scope is the whole brand may change them',
    );
  }
};

const columnsOf = (draft: RuleDraft) => {
  const parsed = ruleDraftSchema.parse(draft);
  return {
    name: parsed.name,
    description: parsed.description ?? null,
    kind: parsed.kind,
    trigger: parsed.kind === 'event' ? (parsed.trigger ?? null) : null,
    intervalMinutes: parsed.kind === 'scheduled' ? (parsed.intervalMinutes ?? null) : null,
    conditions: parsed.conditions as unknown as Record<string, unknown>,
    actions: parsed.actions as unknown as Record<string, unknown>[],
    enabled: parsed.enabled,
  };
};

const runDetailsSchema = z.object({
  failedGroup: z.unknown().optional(),
  actions: z.array(z.unknown()).optional(),
});

const toRun = (row: RunRow, names: ReadonlyMap<string, string>): WorkflowRun => {
  const details = runDetailsSchema.parse(row.details);

  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    ticketId: row.ticketId,
    ticketReference: row.ticketReference,
    trigger: row.trigger as WorkflowRun['trigger'],
    result: row.result,
    stopReason: row.stopReason as WorkflowRun['stopReason'],
    depth: row.depth,
    chain: row.chain.map((ruleId) => ({ ruleId, ruleName: names.get(ruleId) ?? '' })),
    failedGroup: (details.failedGroup ?? null) as WorkflowRun['failedGroup'],
    actions: (details.actions ?? []) as WorkflowRun['actions'],
    createdAt: row.createdAt.toISOString(),
  };
};
