import type { DbTransaction, Department as DepartmentRow, Team as TeamRow } from '@helpdock/db';
import type {
  DepartmentCreateRequest,
  DepartmentReorderRequest,
  DepartmentSummary,
  DepartmentSummaryList,
  DepartmentUpdateRequest,
  EligibleMemberList,
  TeamCreateRequest,
  TeamList,
  TeamUpdateRequest,
  TicketingRefusal,
} from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { writeBrandAudit } from './audit.js';
import { assertDepartmentDeletable } from './department-deletion.js';
import {
  brandDepartmentsRefusal,
  canManageMember,
  type DepartmentActor,
  departmentEditRefusal,
  isEligibleMember,
  reachesDepartment,
  type TeamCandidate,
} from './department-scope.js';
import type { DepartmentsRepository, DepartmentWithCounts } from './departments.repository.js';
import { TicketingFailure } from './ticketing-failure.js';

/**
 * Departments and teams inside one brand (M1-01), the first tab of the
 * Ticketing settings screen.
 *
 * Three things hold across all of it.
 *
 * **The transaction is the caller's.** Every method takes the request's `tx`,
 * so the reads are already narrowed to this brand by row-level security and the
 * audit row rolls back with whatever it was about.
 *
 * **Who may do it is decided in one place.** `department-scope.ts` is the rule;
 * nothing here re-derives it, so a route cannot accidentally be more permissive
 * than DOMAIN-RULES §1.2.
 *
 * **A refusal is a code, never a sentence.** The screen turns
 * {@link TicketingRefusal} into translated copy; the api never sends English a
 * person reads.
 */

export interface DepartmentContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actor: DepartmentActor;
}

export class DepartmentsService {
  readonly #repository: DepartmentsRepository;

  constructor(repository: DepartmentsRepository) {
    this.#repository = repository;
  }

  /**
   * Readable by anybody who can read the brand: an Agent's chip picker and the
   * Ticketing tab are the same list, and hiding it would only mean two
   * endpoints answering the same question.
   */
  async list(tx: DbTransaction): Promise<DepartmentSummaryList> {
    const rows = await this.#repository.list(tx);

    return { departments: rows.map(toSummary) };
  }

  async create(
    context: DepartmentContext,
    request: DepartmentCreateRequest,
  ): Promise<DepartmentSummary> {
    this.#refuse(brandDepartmentsRefusal(context.actor));
    await this.#assertNameFree(context.tx, request.name);

    const department = await this.#repository.create(context.tx, {
      brandId: context.brandId,
      name: request.name,
      nameAr: request.nameAr ?? null,
      sortOrder: await this.#repository.nextSortOrder(context.tx),
    });

    await writeBrandAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'department.created',
      targetType: 'department',
      targetId: department.id,
      meta: { name: department.name },
    });

    return toSummary({ department, teamCount: 0, memberCount: 0, defaultTeamName: null });
  }

  async update(
    context: DepartmentContext,
    departmentId: string,
    request: DepartmentUpdateRequest,
  ): Promise<DepartmentSummary> {
    const department = await this.#require(context.tx, departmentId);
    this.#refuse(departmentEditRefusal(context.actor, departmentId));

    if (
      request.name !== undefined &&
      request.name.toLowerCase() !== department.name.toLowerCase()
    ) {
      await this.#assertNameFree(context.tx, request.name, departmentId);
    }

    if (request.defaultTeamId !== undefined && request.defaultTeamId !== null) {
      // A department's default team has to be one of its own, or a ticket would
      // fall to a team that never sees it (M1-07).
      const team = await this.#repository.findTeam(context.tx, {
        departmentId,
        teamId: request.defaultTeamId,
      });
      if (team === undefined) {
        throw new NotFoundException('No such team in this department');
      }
    }

    await this.#repository.update(context.tx, departmentId, request);

    await writeBrandAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'department.updated',
      targetType: 'department',
      targetId: departmentId,
      meta: {
        ...(request.name === undefined ? {} : { name: request.name, wasNamed: department.name }),
        ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
        ...(request.defaultTeamId === undefined
          ? {}
          : { defaultTeamId: request.defaultTeamId, wasDefaultTeamId: department.defaultTeamId }),
      },
    });

    return this.#summaryOf(context.tx, departmentId);
  }

  async remove(context: DepartmentContext, departmentId: string): Promise<void> {
    const department = await this.#require(context.tx, departmentId);
    this.#refuse(brandDepartmentsRefusal(context.actor));

    await assertDepartmentDeletable(
      { tx: context.tx, brandId: context.brandId, departmentId },
      { remainingDepartments: (await this.#repository.countDepartments(context.tx)) - 1 },
    );

    await this.#repository.delete(context.tx, departmentId);

    await writeBrandAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'department.deleted',
      targetType: 'department',
      targetId: departmentId,
      meta: { name: department.name },
    });
  }

  /**
   * The whole list in its new order. Ids the brand does not have are refused
   * rather than ignored: a client that sends a stale list would otherwise get a
   * silent partial reorder and no way to tell.
   */
  async reorder(
    context: DepartmentContext,
    request: DepartmentReorderRequest,
  ): Promise<DepartmentSummaryList> {
    this.#refuse(brandDepartmentsRefusal(context.actor));

    const known = new Set(
      (await this.#repository.list(context.tx)).map((row) => row.department.id),
    );
    const unique = new Set(request.departmentIds);

    if (unique.size !== request.departmentIds.length) {
      throw new BadRequestException('The order names a department twice');
    }
    if (unique.size !== known.size || request.departmentIds.some((id) => !known.has(id))) {
      throw new BadRequestException(
        'The order must name every department of this brand exactly once',
      );
    }

    await this.#repository.reorder(context.tx, request.departmentIds);

    await writeBrandAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'department.reordered',
      targetType: 'brand',
      targetId: context.brandId,
      meta: { order: request.departmentIds },
    });

    return this.list(context.tx);
  }

  // ------------------------------------------------------------------
  // Teams
  // ------------------------------------------------------------------

  async teams(tx: DbTransaction, departmentId: string): Promise<TeamList> {
    await this.#require(tx, departmentId);
    const rows = await this.#repository.teamsOf(tx, departmentId);

    return {
      teams: rows.map(({ team, members }) => ({
        id: team.id,
        departmentId: team.departmentId,
        name: team.name,
        sortOrder: team.sortOrder,
        members: members.map(({ id, name, role }) => ({ userId: id, name, role })),
      })),
    };
  }

  async createTeam(
    context: DepartmentContext,
    departmentId: string,
    request: TeamCreateRequest,
  ): Promise<TeamList> {
    await this.#require(context.tx, departmentId);
    this.#refuse(departmentEditRefusal(context.actor, departmentId));

    if (await this.#repository.teamNameTaken(context.tx, departmentId, request.name)) {
      throw new TicketingFailure('name-taken');
    }

    const team = await this.#repository.createTeam(context.tx, {
      brandId: context.brandId,
      departmentId,
      name: request.name,
      sortOrder: await this.#repository.nextTeamSortOrder(context.tx, departmentId),
    });

    await writeBrandAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'team.created',
      targetType: 'team',
      targetId: team.id,
      meta: { departmentId, name: team.name },
    });

    return this.teams(context.tx, departmentId);
  }

  async renameTeam(
    context: DepartmentContext,
    { departmentId, teamId }: { readonly departmentId: string; readonly teamId: string },
    request: TeamUpdateRequest,
  ): Promise<TeamList> {
    const team = await this.#requireTeam(context.tx, { departmentId, teamId });
    this.#refuse(departmentEditRefusal(context.actor, departmentId));

    if (
      await this.#repository.teamNameTaken(context.tx, departmentId, request.name, {
        exceptId: teamId,
      })
    ) {
      throw new TicketingFailure('name-taken');
    }

    await this.#repository.renameTeam(context.tx, teamId, request.name);

    await writeBrandAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'team.updated',
      targetType: 'team',
      targetId: teamId,
      meta: { departmentId, name: request.name, wasNamed: team.name },
    });

    return this.teams(context.tx, departmentId);
  }

  async deleteTeam(
    context: DepartmentContext,
    { departmentId, teamId }: { readonly departmentId: string; readonly teamId: string },
  ): Promise<TeamList> {
    const team = await this.#requireTeam(context.tx, { departmentId, teamId });
    this.#refuse(departmentEditRefusal(context.actor, departmentId));

    // Its members go with it, and a department whose default team this was is
    // left with none: both are the `on delete` behaviour declared on the
    // columns, so there is nothing to undo by hand here.
    await this.#repository.deleteTeam(context.tx, teamId);

    await writeBrandAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'team.deleted',
      targetType: 'team',
      targetId: teamId,
      meta: { departmentId, name: team.name },
    });

    return this.teams(context.tx, departmentId);
  }

  // ------------------------------------------------------------------
  // Membership
  // ------------------------------------------------------------------

  /**
   * Who the people picker may offer for this department.
   *
   * Scoped like every other editing call, and for the same reason: it answers
   * with addresses, and a Team Leader has no business reading the people of a
   * department they do not lead. It is the only route here that could have been
   * left open by accident, because reading feels harmless.
   *
   * It is narrowed by the *actor*, not only by the department, so a Team Leader
   * is never shown an Admin the write would then refuse (DOMAIN-RULES §1.2).
   */
  async eligibleMembers(
    context: DepartmentContext,
    departmentId: string,
  ): Promise<EligibleMemberList> {
    await this.#require(context.tx, departmentId);
    this.#refuse(departmentEditRefusal(context.actor, departmentId));

    const rows = await this.#repository.brandRoles(context.tx);

    return {
      members: rows
        .filter((row) =>
          isEligibleMember(
            context.actor,
            { role: row.role, departmentIds: row.departmentIds ?? 'all' },
            departmentId,
          ),
        )
        .map(({ id, name, email, role }) => ({ userId: id, name, email, role })),
    };
  }

  async addMember(
    context: DepartmentContext,
    { departmentId, teamId }: { readonly departmentId: string; readonly teamId: string },
    userId: string,
  ): Promise<TeamList> {
    await this.#requireTeam(context.tx, { departmentId, teamId });
    this.#refuse(departmentEditRefusal(context.actor, departmentId));

    const person = await this.#repository.brandRoleOf(context.tx, userId);
    if (person === undefined) {
      // Deliberately one answer for "no role in this brand" and "deactivated":
      // both mean the same thing to the person adding them, and telling them
      // apart would say who works where.
      throw new TicketingFailure('not-eligible');
    }

    const candidate: TeamCandidate = {
      role: person.role,
      departmentIds: person.departmentIds ?? 'all',
    };
    // The ceiling is a permission answer (403), the reach is a fact about the
    // person (409), so the two are refused apart rather than as one "no".
    this.#refuse(canManageMember(context.actor, candidate) ? null : 'out-of-scope');
    if (!reachesDepartment(candidate, departmentId)) {
      throw new TicketingFailure('not-eligible');
    }

    await this.#repository.addMember(context.tx, {
      brandId: context.brandId,
      teamId,
      userId,
    });

    await writeBrandAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'team.member.added',
      targetType: 'team_member',
      targetId: userId,
      meta: { departmentId, teamId },
    });

    return this.teams(context.tx, departmentId);
  }

  async removeMember(
    context: DepartmentContext,
    { departmentId, teamId }: { readonly departmentId: string; readonly teamId: string },
    userId: string,
  ): Promise<TeamList> {
    await this.#requireTeam(context.tx, { departmentId, teamId });
    this.#refuse(departmentEditRefusal(context.actor, departmentId));

    // The same ceiling as adding: a Team Leader who could take an Admin off a
    // rota would be reaching past the same line in the other direction. Somebody
    // whose role in the brand is already gone is removable by anyone who leads
    // the department — there is no standing left to protect.
    const person = await this.#repository.brandRoleOf(context.tx, userId);
    if (person !== undefined) {
      this.#refuse(
        canManageMember(context.actor, {
          role: person.role,
          departmentIds: person.departmentIds ?? 'all',
        })
          ? null
          : 'out-of-scope',
      );
    }

    await this.#repository.removeMember(context.tx, { teamId, userId });

    await writeBrandAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'team.member.removed',
      targetType: 'team_member',
      targetId: userId,
      meta: { departmentId, teamId },
    });

    return this.teams(context.tx, departmentId);
  }

  // ------------------------------------------------------------------

  #refuse(reason: TicketingRefusal | null): void {
    if (reason !== null) {
      throw new TicketingFailure(reason);
    }
  }

  /**
   * The department, or 404. A department of another brand is invisible to this
   * transaction, so "not found" is the honest answer to both "there is no such
   * id" and "it is not yours".
   */
  async #require(tx: DbTransaction, departmentId: string): Promise<DepartmentRow> {
    const department = await this.#repository.find(tx, departmentId);
    if (department === undefined) {
      throw new NotFoundException('No such department');
    }

    return department;
  }

  async #requireTeam(
    tx: DbTransaction,
    where: { readonly departmentId: string; readonly teamId: string },
  ): Promise<TeamRow> {
    await this.#require(tx, where.departmentId);
    const team = await this.#repository.findTeam(tx, where);
    if (team === undefined) {
      throw new NotFoundException('No such team in this department');
    }

    return team;
  }

  async #assertNameFree(tx: DbTransaction, name: string, exceptId?: string): Promise<void> {
    const taken = await this.#repository.nameTaken(
      tx,
      name,
      exceptId === undefined ? {} : { exceptId },
    );
    if (taken) {
      throw new TicketingFailure('name-taken');
    }
  }

  async #summaryOf(tx: DbTransaction, departmentId: string): Promise<DepartmentSummary> {
    const rows = await this.#repository.list(tx);
    const row = rows.find((candidate) => candidate.department.id === departmentId);
    /* c8 ignore next 3 -- it was read in this transaction a statement ago. */
    if (row === undefined) {
      throw new NotFoundException('No such department');
    }

    return toSummary(row);
  }
}

const toSummary = ({
  department,
  teamCount,
  memberCount,
  defaultTeamName,
}: DepartmentWithCounts): DepartmentSummary => ({
  id: department.id,
  name: department.name,
  nameAr: department.nameAr,
  sortOrder: department.sortOrder,
  defaultTeamId: department.defaultTeamId,
  defaultTeamName,
  teamCount,
  memberCount,
});
