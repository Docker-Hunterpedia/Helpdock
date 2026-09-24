import type { DbTransaction } from '@helpdock/db';
import { currentDepartmentScope } from '@helpdock/db';
import type {
  AssignableAgentList,
  AssignmentAgent,
  AssignmentAgentList,
  AssignmentAgentUpdateRequest,
  BrandRole,
  DepartmentAssignment,
  DepartmentAssignmentList,
  DepartmentAssignmentUpdateRequest,
  PresenceMap,
  PresenceStatus,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { canManageMember, leadsDepartment } from '../brands/department-scope.js';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { writeTicketingAudit } from '../ticketing/audit.js';
import type { TagsService } from '../ticketing/tags.service.js';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import type { AssignmentRepository, DepartmentAssignmentRow } from './assignment.repository.js';
import { canWorkDepartment, isInRotation, mayAssignTo } from './rotation.js';

/**
 * The request half of M1-07: the Assignment tab of `Admin/Ticketing`, and the
 * assignee picker of the ticket workspace.
 *
 * **Two permissions, for two audiences.** The tab is `ticketing:manage`, as
 * M1-06 and M1-08's tabs are, and a Team Leader sees and edits only the
 * departments they lead — and, inside them, only the people DOMAIN-RULES §1.2
 * lets them act on (Agents and Viewers; Viewers never work tickets, so in
 * practice Agents). The picker is `ticket:write`, which every Agent holds,
 * because the person choosing an assignee is usually an Agent — which is also
 * why it answers with a name, a presence and a count and nothing else.
 */

/** Who presence says is where. Absent from the map is offline (M0-13). */
export interface PresenceMapReader {
  map(brandId: string): Promise<PresenceMap>;
}

const presenceOf = (map: PresenceMap, userId: string): PresenceStatus => map[userId] ?? 'offline';

const toDepartmentAssignment = (
  row: DepartmentAssignmentRow,
  counts: { agentsOnline: number; agentsInRotation: number },
): DepartmentAssignment => ({
  departmentId: row.id,
  name: row.name,
  nameAr: row.nameAr,
  mode: row.assignmentMode,
  loadCap: row.loadCap,
  autoUnassignOffline: row.autoUnassignOffline,
  autoUnassignAfterMinutes: row.autoUnassignAfterMinutes,
  onUnassign: row.onUnassign,
  ...counts,
});

export class AssignmentService {
  readonly #repository: AssignmentRepository;
  readonly #tags: TagsService;
  readonly #presence: PresenceMapReader;

  constructor(repository: AssignmentRepository, tags: TagsService, presence: PresenceMapReader) {
    this.#repository = repository;
    this.#tags = tags;
    this.#presence = presence;
  }

  // ------------------------------------------------------------ the tab

  async list(context: TicketingContext): Promise<DepartmentAssignmentList> {
    const { tx, brandId, actor } = context;
    const [departments, members, rows, presence] = await Promise.all([
      this.#repository.departments(tx, brandId),
      this.#repository.members(tx, brandId),
      this.#repository.rotationRows(tx, brandId),
      this.#presence.map(brandId),
    ]);
    const stored = new Map(
      rows.map((row) => [`${row.departmentId}:${row.userId}`, row.inRotation]),
    );

    return {
      departments: departments
        .filter((department) => leadsDepartment(actor, department.id))
        .map((department) => {
          const inRotation = members.filter(
            (member) =>
              canWorkDepartment(member, department.id) &&
              isInRotation({
                role: member.role,
                inRotation: stored.get(`${department.id}:${member.userId}`) ?? null,
              }),
          );

          return toDepartmentAssignment(department, {
            agentsInRotation: inRotation.length,
            agentsOnline: inRotation.filter(
              (member) => presenceOf(presence, member.userId) === 'online',
            ).length,
          });
        }),
    };
  }

  async update(
    context: TicketingContext,
    departmentId: string,
    request: DepartmentAssignmentUpdateRequest,
  ): Promise<DepartmentAssignment> {
    const before = await this.#requireLed(context, departmentId);

    const values = {
      ...(request.mode === undefined ? {} : { assignmentMode: request.mode }),
      ...(request.loadCap === undefined ? {} : { loadCap: request.loadCap }),
      ...(request.autoUnassignOffline === undefined
        ? {}
        : { autoUnassignOffline: request.autoUnassignOffline }),
      ...(request.autoUnassignAfterMinutes === undefined
        ? {}
        : { autoUnassignAfterMinutes: request.autoUnassignAfterMinutes }),
      ...(request.onUnassign === undefined ? {} : { onUnassign: request.onUnassign }),
    };
    await this.#repository.updateDepartment(context.tx, departmentId, values);

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'assignment.updated',
      targetType: 'department',
      targetId: departmentId,
      meta: { name: before.name, changes: request },
    });

    const updated = (await this.list(context)).departments.find(
      (department) => department.departmentId === departmentId,
    );
    /* c8 ignore next 3 -- `#requireLed` has just proved the row exists and is led. */
    if (updated === undefined) {
      throw new NotFoundException('No such department');
    }

    return updated;
  }

  async agents(context: TicketingContext, departmentId: string): Promise<AssignmentAgentList> {
    const department = await this.#requireLed(context, departmentId);

    return {
      departmentId,
      loadCap: department.loadCap,
      agents: await this.#agentRows(context, departmentId),
    };
  }

  async updateAgent(
    context: TicketingContext,
    departmentId: string,
    userId: string,
    request: AssignmentAgentUpdateRequest,
  ): Promise<AssignmentAgent> {
    const { tx, brandId, actor } = context;
    await this.#requireLed(context, departmentId);

    const member = await this.#repository.member(tx, brandId, userId);
    if (member === undefined || !canWorkDepartment(member, departmentId)) {
      throw new TicketingFailure('not-eligible');
    }
    // A Team Leader moves Agents in and out of rotation, never somebody above
    // them: taking an Admin off a rota is reaching past the same line as
    // putting one on it (`department-scope.ts`).
    if (!canManageMember(actor, member)) {
      throw new TicketingFailure('out-of-scope');
    }

    if (request.inRotation !== undefined) {
      await this.#repository.setRotation(tx, {
        brandId,
        departmentId,
        userId,
        inRotation: request.inRotation,
      });
    }

    if (request.skillTagIds !== undefined) {
      const tagIds = [...new Set(request.skillTagIds)];
      if ((await this.#tags.unknownIds(tx, tagIds)).length > 0) {
        throw new NotFoundException('No such tag in this brand');
      }
      await this.#repository.replaceSkills(tx, { brandId, departmentId, userId, tagIds });
    }

    await writeTicketingAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'assignment.agent.updated',
      targetType: 'department',
      targetId: departmentId,
      meta: { userId, changes: request },
    });

    const row = (await this.#agentRows(context, departmentId)).find(
      (agent) => agent.userId === userId,
    );
    /* c8 ignore next 3 -- the member was eligible a moment ago in this transaction. */
    if (row === undefined) {
      throw new TicketingFailure('not-eligible');
    }

    return row;
  }

  // ---------------------------------------------------------- the picker

  /**
   * Who may be given a ticket in this department by this person: everyone who
   * can work it, minus anybody above the actor's ceiling. Agents at cap are
   * included — a person may still choose them — and the count says so.
   *
   * A department outside the actor's own scope answers 404, as a ticket there
   * would: the actor cannot assign inside it, and "not found" and "not yours"
   * are deliberately the same answer (DOMAIN-RULES §1.2).
   */
  async assignable(
    tx: DbTransaction,
    brandId: string,
    actorRole: BrandRole | undefined,
    departmentId: string,
  ): Promise<AssignableAgentList> {
    const department = await this.#repository.department(tx, departmentId);
    const scope = await currentDepartmentScope(tx);
    if (department === undefined || (scope !== 'all' && !scope.includes(departmentId))) {
      throw new NotFoundException('No such department');
    }

    const [members, presence, openCounts] = await Promise.all([
      this.#repository.members(tx, brandId),
      this.#presence.map(brandId),
      this.#repository.openCounts(tx, departmentId),
    ]);

    return {
      departmentId,
      loadCap: department.loadCap,
      agents: members
        .filter(
          (member) =>
            canWorkDepartment(member, departmentId) &&
            (actorRole === undefined || mayAssignTo(actorRole, member.role)),
        )
        .map((member) => ({
          userId: member.userId,
          name: member.name,
          presence: presenceOf(presence, member.userId),
          openCount: openCounts.get(member.userId) ?? 0,
        })),
    };
  }

  // ------------------------------------------------------------ internals

  async #agentRows(context: TicketingContext, departmentId: string): Promise<AssignmentAgent[]> {
    const { tx, brandId, actor } = context;
    const [candidates, skills, openCounts, presence] = await Promise.all([
      this.#repository.candidates(tx, brandId, departmentId),
      this.#repository.skills(tx, departmentId),
      this.#repository.openCounts(tx, departmentId),
      this.#presence.map(brandId),
    ]);

    return candidates
      .filter((candidate) => canWorkDepartment(candidate, departmentId))
      .map((candidate) => ({
        userId: candidate.userId,
        name: candidate.name,
        role: candidate.role,
        presence: presenceOf(presence, candidate.userId),
        openCount: openCounts.get(candidate.userId) ?? 0,
        inRotation: isInRotation(candidate),
        skills: skills.get(candidate.userId) ?? [],
        editable: canManageMember(actor, candidate),
      }));
  }

  /** The department, if the actor leads it; otherwise the same refusal every tab gives. */
  async #requireLed(
    context: TicketingContext,
    departmentId: string,
  ): Promise<DepartmentAssignmentRow> {
    const department = await this.#repository.department(context.tx, departmentId);
    if (department === undefined) {
      throw new NotFoundException('No such department');
    }
    if (!leadsDepartment(context.actor, departmentId)) {
      throw new TicketingFailure('out-of-scope');
    }

    return department;
  }
}
