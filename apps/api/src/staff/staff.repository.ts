import {
  auditLog,
  type DbTransaction,
  type Department,
  departments,
  type User,
  type UserBrandRole,
  userBrandRoles,
  users,
} from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';
import type { BrandRole } from '@helpdock/schemas';
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { anonymisedEmail, FORMER_STAFF_NAME } from './anonymise.js';

/**
 * Every read and write M0-06 makes, through the transaction the request is
 * already inside.
 *
 * **Why no tenant context is opened here.** `user_brand_roles` and
 * `departments` are tenant tables, so the row-level security policies on the
 * request's transaction already restrict both to the brand the route resolved.
 * That is the whole point of the interceptor: the filter is not written out,
 * because a filter that is written out is a filter that can be forgotten.
 * `users` is global and is reached through a join, which means the list can
 * only ever contain people who hold a role in *this* brand.
 *
 * It is deliberately separate from `auth/staff.repository.ts`, which is the
 * sign-in path and runs before any brand is known. Nothing here runs without
 * one.
 */

export interface StaffRow {
  readonly membership: UserBrandRole;
  readonly user: User;
}

export class StaffRepository {
  /**
   * Everybody with a role in this brand, newest membership last so the table
   * reads as the brand grew. `search` matches a name or an address, case
   * insensitively; it is bound as a parameter and the wildcards are added
   * around the escaped value, so a `%` somebody types is a per cent sign.
   */
  async list(tx: DbTransaction, search: string | undefined): Promise<StaffRow[]> {
    const term = search?.trim();
    const pattern = term === undefined || term === '' ? null : `%${escapeLike(term)}%`;

    const rows = await tx
      .select({ membership: userBrandRoles, user: users })
      .from(userBrandRoles)
      .innerJoin(users, eq(users.id, userBrandRoles.userId))
      .where(
        pattern === null
          ? undefined
          : or(
              sql`${users.name} ILIKE ${pattern} ESCAPE '\\'`,
              sql`${users.email} ILIKE ${pattern} ESCAPE '\\'`,
            ),
      )
      .orderBy(asc(users.name), asc(users.email));

    return rows;
  }

  async find(tx: DbTransaction, userId: string): Promise<StaffRow | undefined> {
    const rows = await tx
      .select({ membership: userBrandRoles, user: users })
      .from(userBrandRoles)
      .innerJoin(users, eq(users.id, userBrandRoles.userId))
      .where(eq(userBrandRoles.userId, userId))
      .limit(1);

    return rows[0];
  }

  /** Global table, so this finds an account that works in another brand too. */
  async findUserByEmail(tx: DbTransaction, email: string): Promise<User | undefined> {
    const rows = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email.trim()})`)
      .limit(1);

    return rows[0];
  }

  async findUser(tx: DbTransaction, userId: string): Promise<User | undefined> {
    const rows = await tx.select().from(users).where(eq(users.id, userId)).limit(1);

    return rows[0];
  }

  async departments(tx: DbTransaction): Promise<Department[]> {
    return tx.select().from(departments).orderBy(asc(departments.name));
  }

  /**
   * The departments of this brand among the ids given. A caller compares the
   * count: anything missing belongs to another brand or to nothing, and the
   * request is refused rather than silently narrowed.
   */
  async departmentsByIds(
    tx: DbTransaction,
    departmentIds: readonly string[],
  ): Promise<Department[]> {
    if (departmentIds.length === 0) {
      return [];
    }

    return tx
      .select()
      .from(departments)
      .where(inArray(departments.id, [...departmentIds]));
  }

  /** A staff account that has never signed in. `status` is `invited` until it does. */
  async createInvitedUser(
    tx: DbTransaction,
    { email, name }: { readonly email: string; readonly name: string },
  ): Promise<User> {
    const inserted = await tx
      .insert(users)
      .values({ email: email.trim(), name, status: 'invited' })
      .returning();

    const created = inserted[0];
    /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
    if (created === undefined) {
      throw new Error('The invited account could not be created');
    }

    return created;
  }

  async createMembership(
    tx: DbTransaction,
    {
      userId,
      brandId,
      role,
      departmentIds,
    }: {
      readonly userId: string;
      readonly brandId: string;
      readonly role: BrandRole;
      readonly departmentIds: string[] | null;
    },
  ): Promise<void> {
    await tx.insert(userBrandRoles).values({ userId, brandId, role, departmentIds });
  }

  async updateMembership(
    tx: DbTransaction,
    membershipId: string,
    { role, departmentIds }: { readonly role: BrandRole; readonly departmentIds: string[] | null },
  ): Promise<void> {
    await tx
      .update(userBrandRoles)
      .set({ role, departmentIds })
      .where(eq(userBrandRoles.id, membershipId));
  }

  async deleteMembership(tx: DbTransaction, membershipId: string): Promise<void> {
    await tx.delete(userBrandRoles).where(eq(userBrandRoles.id, membershipId));
  }

  /**
   * Whether this account holds a role anywhere the request's transaction can
   * see. Revoking an invitation deletes the account itself only when nothing is
   * left of it, and this is the "nothing is left" half of that test.
   */
  async hasMembership(tx: DbTransaction, userId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: userBrandRoles.id })
      .from(userBrandRoles)
      .where(eq(userBrandRoles.userId, userId))
      .limit(1);

    return rows.length > 0;
  }

  /**
   * Removes an account that was never used. Guarded in SQL as well as by the
   * caller, so a race between two administrators revoking the same invitation
   * cannot delete an account that has just been activated between the read and
   * the write.
   */
  async deleteInvitedUser(tx: DbTransaction, userId: string): Promise<void> {
    await tx.delete(users).where(and(eq(users.id, userId), eq(users.status, 'invited')));
  }

  /**
   * The one write that turns an invitation into a working account: the name
   * they chose, the language they chose, the first password they will ever
   * have, and `active` instead of `invited`.
   *
   * Guarded on `invited` in SQL as well as in the caller, so two tabs racing
   * the accept form cannot both set a password — the second statement matches
   * no row.
   */
  async activate(
    tx: DbTransaction,
    userId: string,
    {
      name,
      locale,
      passwordHash,
    }: { readonly name: string; readonly locale: Locale; readonly passwordHash: string },
  ): Promise<boolean> {
    const updated = await tx
      .update(users)
      .set({ name, locale, passwordHash, status: 'active' })
      .where(and(eq(users.id, userId), eq(users.status, 'invited')))
      .returning({ id: users.id });

    return updated.length > 0;
  }

  /**
   * Who sent the invitation this account is waiting on. The token deliberately
   * does not carry it — a token a stranger holds should say as little as it can
   * — so the name on the invite screen comes from the audit row the invitation
   * wrote, which is the record of the fact rather than a second copy of it.
   */
  async inviterOf(tx: DbTransaction, userId: string): Promise<string | null> {
    const rows = await tx
      .select({ actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, userId), eq(auditLog.action, 'staff.invited')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);

    return rows[0]?.actorId ?? null;
  }

  async setDeactivated(tx: DbTransaction, userId: string, deactivated: boolean): Promise<void> {
    await tx
      .update(users)
      .set(
        deactivated
          ? { status: 'deactivated', deactivatedAt: new Date() }
          : { status: 'active', deactivatedAt: null },
      )
      .where(eq(users.id, userId));
  }

  async updateProfile(
    tx: DbTransaction,
    userId: string,
    changes: { readonly name?: string; readonly locale?: 'en' | 'ar' },
  ): Promise<void> {
    await tx.update(users).set(changes).where(eq(users.id, userId));
  }

  /**
   * DOMAIN-RULES §12's delete: the row survives so that everything pointing at
   * it still resolves, and everything personal about it does not. The
   * credentials go with the identity — a password or an authenticator left
   * behind would be a way back into an account nobody owns any more.
   *
   * Guarded on `deactivated`, because "only after deactivation" has to be true
   * of the statement and not only of the code path that usually reaches it.
   */
  async anonymise(tx: DbTransaction, userId: string): Promise<boolean> {
    const updated = await tx
      .update(users)
      .set({
        name: FORMER_STAFF_NAME,
        email: anonymisedEmail(userId),
        passwordHash: null,
        totpSecretEncrypted: null,
        totpEnabled: false,
        recoveryCodesHashed: [],
        installAdmin: false,
      })
      .where(and(eq(users.id, userId), eq(users.status, 'deactivated')))
      .returning({ id: users.id });

    return updated.length > 0;
  }

  /**
   * How many install admins are still able to sign in. The floor that keeps an
   * install reachable is counted rather than assumed, because the answer
   * changes as people are deactivated.
   *
   * An `invited` install admin counts: their account works the moment they
   * accept, so refusing to deactivate an active one *because* the only other is
   * still pending would be the wrong way round.
   */
  async countUsableInstallAdmins(tx: DbTransaction): Promise<number> {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.installAdmin, true), ne(users.status, 'deactivated')));

    return rows[0]?.count ?? 0;
  }
}

/** `%` and `_` are wildcards in `LIKE`; a person typing one means the character. */
const escapeLike = (value: string): string => value.replaceAll(/[\\%_]/g, (match) => `\\${match}`);
