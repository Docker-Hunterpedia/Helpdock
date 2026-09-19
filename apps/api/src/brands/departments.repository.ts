import {
  type DbTransaction,
  type Department,
  departments,
  type Team,
  teamMembers,
  teams,
  type User,
  type UserBrandRole,
  userBrandRoles,
  users,
} from '@helpdock/db';
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';

/**
 * Every read and write the Ticketing settings make, through the transaction the
 * request is already inside.
 *
 * **No tenant context is opened here.** `departments`, `teams` and
 * `team_members` are tenant tables, so the row-level security policies on the
 * request's transaction already restrict all three to the brand the route
 * resolved. That is the whole point of the interceptor: the filter is not
 * written out, because a filter that is written out is a filter that can be
 * forgotten. `users` is global and is only ever reached through a join from one
 * of those three, which means a row can only be seen by a brand the person
 * actually works in.
 */

/** A department with the counts and the name the list cell prints. */
export interface DepartmentWithCounts {
  readonly department: Department;
  readonly teamCount: number;
  /** Distinct people across the department's teams, not the sum of the teams. */
  readonly memberCount: number;
  /** The default team's name, or null when it has none. */
  readonly defaultTeamName: string | null;
}

/** Somebody who works in this brand, with the scope their role carries. */
export type BrandRoleRow = Pick<User, 'id' | 'name' | 'email'> &
  Pick<UserBrandRole, 'role' | 'departmentIds'>;

/** The one select shape both roster reads use. */
const BRAND_ROLE_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: userBrandRoles.role,
  departmentIds: userBrandRoles.departmentIds,
} as const;

export interface TeamWithMembers {
  readonly team: Team;
  /**
   * No address: the team list is readable at `brand:read`, and DOMAIN-RULES
   * §1.2 keeps the brand's roster — and its addresses — behind `staff:manage`.
   */
  readonly members: readonly (Pick<User, 'id' | 'name'> & {
    readonly role: UserBrandRole['role'];
  })[];
}

export class DepartmentsRepository {
  /**
   * The brand's departments in the order the admin list draws them. The name
   * breaks ties, so departments that have never been reordered — every one of
   * them carries `sort_order` 0 until somebody drags a row — still come out in
   * a stable, readable order rather than in insertion order.
   */
  async list(tx: DbTransaction): Promise<DepartmentWithCounts[]> {
    // Left, because most departments have no default team, and the list still
    // has to draw them.
    const rows = await tx
      .select({ department: departments, defaultTeamName: teams.name })
      .from(departments)
      .leftJoin(teams, eq(teams.id, departments.defaultTeamId))
      .orderBy(asc(departments.sortOrder), asc(departments.name));

    const [teamCounts, memberCounts] = await Promise.all([
      this.#teamCounts(tx),
      this.#memberCounts(tx),
    ]);

    return rows.map(({ department, defaultTeamName }) => ({
      department,
      teamCount: teamCounts.get(department.id) ?? 0,
      memberCount: memberCounts.get(department.id) ?? 0,
      defaultTeamName,
    }));
  }

  async find(tx: DbTransaction, departmentId: string): Promise<Department | undefined> {
    const rows = await tx
      .select()
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);

    return rows[0];
  }

  async countDepartments(tx: DbTransaction): Promise<number> {
    const rows = await tx.select({ total: count() }).from(departments);

    return rows[0]?.total ?? 0;
  }

  /** The position a new department takes: the end of the list. */
  async nextSortOrder(tx: DbTransaction): Promise<number> {
    const rows = await tx
      .select({ highest: sql<number | null>`max(${departments.sortOrder})` })
      .from(departments);

    return (rows[0]?.highest ?? -1) + 1;
  }

  async create(
    tx: DbTransaction,
    values: {
      readonly brandId: string;
      readonly name: string;
      readonly nameAr: string | null;
      readonly sortOrder: number;
    },
  ): Promise<Department> {
    const inserted = await tx.insert(departments).values(values).returning();

    const created = inserted[0];
    /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
    if (created === undefined) {
      throw new Error('The department could not be created');
    }

    return created;
  }

  async update(
    tx: DbTransaction,
    departmentId: string,
    changes: {
      readonly name?: string | undefined;
      readonly nameAr?: string | null | undefined;
      readonly defaultTeamId?: string | null | undefined;
    },
  ): Promise<void> {
    await tx.update(departments).set(changes).where(eq(departments.id, departmentId));
  }

  async delete(tx: DbTransaction, departmentId: string): Promise<void> {
    await tx.delete(departments).where(eq(departments.id, departmentId));
  }

  /**
   * Writes the new order. Positions are dense and zero-based, so the list never
   * drifts into the sparse numbering a "move by one" scheme accumulates.
   */
  async reorder(tx: DbTransaction, departmentIds: readonly string[]): Promise<void> {
    for (const [position, departmentId] of departmentIds.entries()) {
      await tx
        .update(departments)
        .set({ sortOrder: position })
        .where(eq(departments.id, departmentId));
    }
  }

  /** Whether another department of this brand already carries that name. */
  async nameTaken(
    tx: DbTransaction,
    name: string,
    { exceptId }: { readonly exceptId?: string } = {},
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(
        and(
          sql`lower(${departments.name}) = lower(${name})`,
          exceptId === undefined ? undefined : ne(departments.id, exceptId),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  // ------------------------------------------------------------------
  // Teams
  // ------------------------------------------------------------------

  async teamsOf(tx: DbTransaction, departmentId: string): Promise<TeamWithMembers[]> {
    const rows = await tx
      .select()
      .from(teams)
      .where(eq(teams.departmentId, departmentId))
      .orderBy(asc(teams.sortOrder), asc(teams.name));

    if (rows.length === 0) {
      return [];
    }

    const memberRows = await tx
      .select({
        teamId: teamMembers.teamId,
        id: users.id,
        name: users.name,
        role: userBrandRoles.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      // An inner join, so somebody whose role in this brand was removed stops
      // being listed as a member without the row having to be deleted.
      .innerJoin(
        userBrandRoles,
        and(
          eq(userBrandRoles.userId, teamMembers.userId),
          eq(userBrandRoles.brandId, teamMembers.brandId),
        ),
      )
      .where(
        inArray(
          teamMembers.teamId,
          rows.map((team) => team.id),
        ),
      )
      .orderBy(asc(users.name), asc(users.id));

    return rows.map((team) => ({
      team,
      members: memberRows
        .filter((member) => member.teamId === team.id)
        .map(({ id, name, role }) => ({ id, name, role })),
    }));
  }

  async findTeam(
    tx: DbTransaction,
    { departmentId, teamId }: { readonly departmentId: string; readonly teamId: string },
  ): Promise<Team | undefined> {
    const rows = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.departmentId, departmentId)))
      .limit(1);

    return rows[0];
  }

  async nextTeamSortOrder(tx: DbTransaction, departmentId: string): Promise<number> {
    const rows = await tx
      .select({ highest: sql<number | null>`max(${teams.sortOrder})` })
      .from(teams)
      .where(eq(teams.departmentId, departmentId));

    return (rows[0]?.highest ?? -1) + 1;
  }

  async createTeam(
    tx: DbTransaction,
    values: {
      readonly brandId: string;
      readonly departmentId: string;
      readonly name: string;
      readonly sortOrder: number;
    },
  ): Promise<Team> {
    const inserted = await tx.insert(teams).values(values).returning();

    const created = inserted[0];
    /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
    if (created === undefined) {
      throw new Error('The team could not be created');
    }

    return created;
  }

  async renameTeam(tx: DbTransaction, teamId: string, name: string): Promise<void> {
    await tx.update(teams).set({ name }).where(eq(teams.id, teamId));
  }

  async deleteTeam(tx: DbTransaction, teamId: string): Promise<void> {
    await tx.delete(teams).where(eq(teams.id, teamId));
  }

  async teamNameTaken(
    tx: DbTransaction,
    departmentId: string,
    name: string,
    { exceptId }: { readonly exceptId?: string } = {},
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          eq(teams.departmentId, departmentId),
          sql`lower(${teams.name}) = lower(${name})`,
          exceptId === undefined ? undefined : ne(teams.id, exceptId),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  // ------------------------------------------------------------------
  // Membership
  // ------------------------------------------------------------------

  /**
   * Everybody with a role in this brand, with the scope that role carries.
   *
   * A deactivated account is left out of both readers below: somebody who
   * cannot sign in cannot take a ticket, so they are not offered as a team
   * member either (DOMAIN-RULES §12).
   */
  async brandRoles(tx: DbTransaction): Promise<BrandRoleRow[]> {
    return tx
      .select(BRAND_ROLE_COLUMNS)
      .from(userBrandRoles)
      .innerJoin(users, eq(users.id, userBrandRoles.userId))
      .where(ne(users.status, 'deactivated'))
      .orderBy(asc(users.name), asc(users.email));
  }

  /**
   * One person's role in this brand, or nothing. Adding somebody to a team
   * needs exactly this much; loading the whole roster to test one id would be a
   * join over every colleague per click.
   */
  async brandRoleOf(tx: DbTransaction, userId: string): Promise<BrandRoleRow | undefined> {
    const rows = await tx
      .select(BRAND_ROLE_COLUMNS)
      .from(userBrandRoles)
      .innerJoin(users, eq(users.id, userBrandRoles.userId))
      .where(and(eq(userBrandRoles.userId, userId), ne(users.status, 'deactivated')))
      .limit(1);

    return rows[0];
  }

  async addMember(
    tx: DbTransaction,
    values: {
      readonly brandId: string;
      readonly teamId: string;
      readonly userId: string;
    },
  ): Promise<void> {
    // The unique index already refuses a second row; doing nothing makes adding
    // somebody twice the no-op the screen expects rather than a 500.
    await tx.insert(teamMembers).values(values).onConflictDoNothing();
  }

  async removeMember(
    tx: DbTransaction,
    { teamId, userId }: { readonly teamId: string; readonly userId: string },
  ): Promise<void> {
    await tx
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  }

  // ------------------------------------------------------------------

  async #teamCounts(tx: DbTransaction): Promise<Map<string, number>> {
    const rows = await tx
      .select({ departmentId: teams.departmentId, total: count() })
      .from(teams)
      .groupBy(teams.departmentId);

    return new Map(rows.map((row) => [row.departmentId, row.total]));
  }

  async #memberCounts(tx: DbTransaction): Promise<Map<string, number>> {
    const rows = await tx
      .select({
        departmentId: teams.departmentId,
        total: sql<number>`count(DISTINCT ${teamMembers.userId})::int`,
      })
      .from(teams)
      .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .groupBy(teams.departmentId);

    return new Map(rows.map((row) => [row.departmentId, row.total]));
  }
}
