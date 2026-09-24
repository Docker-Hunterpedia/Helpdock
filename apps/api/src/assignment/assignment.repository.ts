import {
  assignmentAgents,
  assignmentSkills,
  type DbTransaction,
  type Department,
  departments,
  tags,
  ticketStatuses,
  tickets,
  ticketTags,
  userBrandRoles,
  users,
} from '@helpdock/db';
import type { Tag } from '@helpdock/schemas';
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { departmentScopeOf } from '../staff/roles.js';
import type { RotationCandidate, RotationMember } from './rotation.js';

/**
 * The reads and writes of M1-07, all through the caller's transaction.
 *
 * Every read names the brand even where row-level security already narrows it:
 * a staff principal who belongs to two brands carries both in `app.brand_ids`,
 * and "who may work this department" must never count a colleague from the
 * brand next door.
 */

/** The department columns M1-07 owns, as the settings screen and the rotation read them. */
export type DepartmentAssignmentRow = Pick<
  Department,
  | 'id'
  | 'name'
  | 'nameAr'
  | 'sortOrder'
  | 'assignmentMode'
  | 'loadCap'
  | 'autoUnassignOffline'
  | 'autoUnassignAfterMinutes'
  | 'onUnassign'
>;

export type DepartmentAssignmentValues = Partial<
  Pick<
    Department,
    'assignmentMode' | 'loadCap' | 'autoUnassignOffline' | 'autoUnassignAfterMinutes' | 'onUnassign'
  >
>;

export interface NamedMember extends RotationMember {
  readonly name: string;
}

export interface AssignedTicket {
  readonly id: string;
  readonly departmentId: string;
}

const departmentColumns = {
  id: departments.id,
  name: departments.name,
  nameAr: departments.nameAr,
  sortOrder: departments.sortOrder,
  assignmentMode: departments.assignmentMode,
  loadCap: departments.loadCap,
  autoUnassignOffline: departments.autoUnassignOffline,
  autoUnassignAfterMinutes: departments.autoUnassignAfterMinutes,
  onUnassign: departments.onUnassign,
};

/**
 * "Open" for the cap and for what gets unassigned: an open-like ticket that is
 * neither deleted nor in a status reports leave out (Spam, Merged —
 * DOMAIN-RULES §2.2 excludes spam from round-robin counts).
 */
const countsTowardsLoad = and(
  isNull(tickets.deletedAt),
  inArray(ticketStatuses.systemState, ['open', 'escalated']),
  eq(ticketStatuses.excludedFromReports, false),
);

const stillOpen = and(
  isNull(tickets.deletedAt),
  inArray(ticketStatuses.systemState, ['open', 'on_hold', 'escalated']),
);

export class AssignmentRepository {
  async departments(tx: DbTransaction, brandId: string): Promise<DepartmentAssignmentRow[]> {
    return tx
      .select(departmentColumns)
      .from(departments)
      .where(eq(departments.brandId, brandId))
      .orderBy(asc(departments.sortOrder), asc(departments.name));
  }

  async department(
    tx: DbTransaction,
    departmentId: string,
  ): Promise<DepartmentAssignmentRow | undefined> {
    const [row] = await tx
      .select(departmentColumns)
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);

    return row;
  }

  async updateDepartment(
    tx: DbTransaction,
    departmentId: string,
    values: DepartmentAssignmentValues,
  ): Promise<DepartmentAssignmentRow | undefined> {
    const [row] = await tx
      .update(departments)
      .set(values)
      .where(eq(departments.id, departmentId))
      .returning(departmentColumns);

    return row;
  }

  /** Everyone holding a role in the brand, with what decides whether they may work a department. */
  async members(tx: DbTransaction, brandId: string, userId?: string): Promise<NamedMember[]> {
    const rows = await tx
      .select({
        userId: users.id,
        name: users.name,
        role: userBrandRoles.role,
        departmentIds: userBrandRoles.departmentIds,
        deactivatedAt: users.deactivatedAt,
      })
      .from(userBrandRoles)
      .innerJoin(users, eq(users.id, userBrandRoles.userId))
      .where(
        and(
          eq(userBrandRoles.brandId, brandId),
          userId === undefined ? undefined : eq(userBrandRoles.userId, userId),
        ),
      )
      .orderBy(asc(users.name), asc(users.id));

    return rows.map((row) => ({
      userId: row.userId,
      name: row.name,
      role: row.role,
      departmentIds: departmentScopeOf(row.departmentIds),
      deactivated: row.deactivatedAt !== null,
    }));
  }

  async member(
    tx: DbTransaction,
    brandId: string,
    userId: string,
  ): Promise<NamedMember | undefined> {
    const [member] = await this.members(tx, brandId, userId);

    return member;
  }

  /** The members of the brand, with their standing in this department's rotation. */
  async candidates(
    tx: DbTransaction,
    brandId: string,
    departmentId: string,
  ): Promise<(RotationCandidate & { readonly name: string })[]> {
    const [members, rows, skills] = await Promise.all([
      this.members(tx, brandId),
      tx
        .select({
          userId: assignmentAgents.userId,
          inRotation: assignmentAgents.inRotation,
          lastAssignedAt: assignmentAgents.lastAssignedAt,
        })
        .from(assignmentAgents)
        .where(eq(assignmentAgents.departmentId, departmentId)),
      this.skills(tx, departmentId),
    ]);
    const byUser = new Map(rows.map((row) => [row.userId, row]));

    return members.map((member) => ({
      ...member,
      inRotation: byUser.get(member.userId)?.inRotation ?? null,
      lastAssignedAt: byUser.get(member.userId)?.lastAssignedAt ?? null,
      skillTagIds: (skills.get(member.userId) ?? []).map((tag) => tag.id),
    }));
  }

  /** Every stored rotation choice in the brand, for the tab's per-department counts. */
  async rotationRows(
    tx: DbTransaction,
    brandId: string,
  ): Promise<{ departmentId: string; userId: string; inRotation: boolean }[]> {
    return tx
      .select({
        departmentId: assignmentAgents.departmentId,
        userId: assignmentAgents.userId,
        inRotation: assignmentAgents.inRotation,
      })
      .from(assignmentAgents)
      .where(eq(assignmentAgents.brandId, brandId));
  }

  /** Each person's skills in this department, as the chips the tab draws. */
  async skills(tx: DbTransaction, departmentId: string): Promise<Map<string, Tag[]>> {
    const rows = await tx
      .select({
        userId: assignmentSkills.userId,
        id: tags.id,
        name: tags.name,
        nameAr: tags.nameAr,
        color: tags.color,
      })
      .from(assignmentSkills)
      .innerJoin(tags, eq(tags.id, assignmentSkills.tagId))
      .where(eq(assignmentSkills.departmentId, departmentId))
      .orderBy(asc(tags.sortOrder), asc(tags.name));

    const byUser = new Map<string, Tag[]>();
    for (const { userId, ...tag } of rows) {
      byUser.set(userId, [...(byUser.get(userId) ?? []), tag]);
    }

    return byUser;
  }

  /** Open and escalated tickets per assignee in one department. */
  async openCounts(tx: DbTransaction, departmentId: string): Promise<Map<string, number>> {
    const rows = await tx
      .select({ assigneeId: tickets.assigneeId, open: count() })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(
        and(
          eq(tickets.departmentId, departmentId),
          isNotNull(tickets.assigneeId),
          countsTowardsLoad,
        ),
      )
      .groupBy(tickets.assigneeId);

    return new Map(rows.map((row) => [row.assigneeId ?? '', row.open]));
  }

  async setRotation(
    tx: DbTransaction,
    row: { brandId: string; departmentId: string; userId: string; inRotation: boolean },
  ): Promise<void> {
    await tx
      .insert(assignmentAgents)
      .values(row)
      .onConflictDoUpdate({
        target: [assignmentAgents.departmentId, assignmentAgents.userId],
        set: { inRotation: row.inRotation },
      });
  }

  /**
   * Records that the rotation just picked somebody. Only a person in rotation
   * can be picked, so the insert branch writes down what their default already
   * said.
   */
  async markAssigned(
    tx: DbTransaction,
    row: { brandId: string; departmentId: string; userId: string; at: Date },
  ): Promise<void> {
    await tx
      .insert(assignmentAgents)
      .values({
        brandId: row.brandId,
        departmentId: row.departmentId,
        userId: row.userId,
        inRotation: true,
        lastAssignedAt: row.at,
      })
      .onConflictDoUpdate({
        target: [assignmentAgents.departmentId, assignmentAgents.userId],
        set: { lastAssignedAt: row.at },
      });
  }

  async replaceSkills(
    tx: DbTransaction,
    row: { brandId: string; departmentId: string; userId: string; tagIds: readonly string[] },
  ): Promise<void> {
    await tx
      .delete(assignmentSkills)
      .where(
        and(
          eq(assignmentSkills.departmentId, row.departmentId),
          eq(assignmentSkills.userId, row.userId),
        ),
      );

    if (row.tagIds.length > 0) {
      await tx.insert(assignmentSkills).values(
        row.tagIds.map((tagId) => ({
          brandId: row.brandId,
          departmentId: row.departmentId,
          userId: row.userId,
          tagId,
        })),
      );
    }
  }

  /**
   * Serialises every automatic assignment in one brand until the transaction
   * ends. Two tickets created at once each read the loads and pick; without
   * this, both could read an agent at `cap - 1` and both hand them a ticket.
   * One lock per brand rather than per agent, because taking several agents'
   * locks in whatever order a pick visits them is how two transactions
   * deadlock — and an assignment is one short transaction, so the queue it
   * forms is measured in milliseconds.
   */
  async lockBrandRotation(tx: DbTransaction, brandId: string): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`helpdock:assignment:${brandId}`}, 0))`,
    );
  }

  /**
   * The ticket as the rotation needs it, locked, so a manual assignment racing
   * the job is decided by whichever commits first rather than overwritten.
   */
  async ticketForAssignment(tx: DbTransaction, ticketId: string) {
    const [row] = await tx
      .select({
        id: tickets.id,
        departmentId: tickets.departmentId,
        assigneeId: tickets.assigneeId,
        deletedAt: tickets.deletedAt,
        systemState: ticketStatuses.systemState,
        excludedFromReports: ticketStatuses.excludedFromReports,
      })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(eq(tickets.id, ticketId))
      .for('update', { of: tickets })
      .limit(1);

    return row;
  }

  async ticketTagIds(tx: DbTransaction, ticketId: string): Promise<string[]> {
    const rows = await tx
      .select({ tagId: ticketTags.tagId })
      .from(ticketTags)
      .where(eq(ticketTags.ticketId, ticketId));

    return rows.map((row) => row.tagId);
  }

  async setAssignee(tx: DbTransaction, ticketId: string, assigneeId: string | null): Promise<void> {
    await tx.update(tickets).set({ assigneeId }).where(eq(tickets.id, ticketId));
  }

  /** The not-yet-closed tickets assigned to somebody, optionally in one department. */
  async openTicketsOf(
    tx: DbTransaction,
    brandId: string,
    userId: string,
    departmentId?: string,
  ): Promise<AssignedTicket[]> {
    return tx
      .select({ id: tickets.id, departmentId: tickets.departmentId })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(
        and(
          eq(tickets.brandId, brandId),
          eq(tickets.assigneeId, userId),
          stillOpen,
          departmentId === undefined ? undefined : eq(tickets.departmentId, departmentId),
        ),
      )
      .orderBy(asc(tickets.createdAt));
  }
}
