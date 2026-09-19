import {
  type Brand,
  brands,
  type Db,
  type DbTransaction,
  type User,
  type UserBrandRole,
  userBrandRoles,
  users,
  withTenant,
} from '@helpdock/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * Everything sign-in reads and writes about a staff account.
 *
 * **Why this is a system path.** Authentication happens before a brand is
 * known — that is what authentication is — so there is no request transaction
 * to join and no principal to scope one to. `users` and `brands` are global
 * tables for exactly that reason (`GLOBAL_TABLES` in `@helpdock/db`), and are
 * read directly. `user_brand_roles` is a tenant table, so the one read of it
 * opens a transaction naming every active brand, as `principal_type = system`
 * with `principal_id = auth`.
 *
 * That is the widest scope in the application, so it is confined to this file,
 * it never returns anything but the memberships of the one user who has just
 * proved who they are, and it never writes. AGENTS.md asks for exactly this: an
 * explicit, named system path rather than a query that quietly runs without a
 * tenant context.
 *
 * **Why every method takes a transaction.** A route that already runs inside
 * the request transaction must not ask the pool for a second connection while
 * holding the first: enough concurrent requests doing that would take every
 * connection and then wait for one. So an authenticated route passes `getTx()`
 * and the repository uses it; an anonymous route passes nothing and the
 * repository opens what it needs.
 */

/** Recorded in `app.principal_id` for the lookup above, so an audit trail names it. */
export const AUTH_SYSTEM_PRINCIPAL = 'auth';

export type StaffUser = User;
export type StaffMembership = UserBrandRole;

/** The request's transaction, when there is one. */
export type Queryable = Db | DbTransaction;

export interface StaffRepositoryOptions {
  readonly db: Db;
}

export class StaffRepository {
  readonly #db: Db;

  constructor({ db }: StaffRepositoryOptions) {
    this.#db = db;
  }

  /**
   * Addresses are compared case-insensitively, the same way the unique index on
   * `lower(email)` enforces uniqueness, so two accounts can never both answer
   * to one address.
   */
  async findByEmail(email: string, tx?: Queryable): Promise<StaffUser | undefined> {
    const rows = await (tx ?? this.#db)
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email.trim()})`)
      .limit(1);

    return rows[0];
  }

  async findById(userId: string, tx?: Queryable): Promise<StaffUser | undefined> {
    const rows = await (tx ?? this.#db).select().from(users).where(eq(users.id, userId)).limit(1);

    return rows[0];
  }

  /**
   * The memberships of one user. Inside a request the caller's own transaction
   * already carries that principal's brands, so row-level security narrows the
   * read for free; outside one it goes through the system path above.
   */
  async membershipsOf(userId: string, tx?: Queryable): Promise<StaffMembership[]> {
    if (tx !== undefined) {
      return tx.select().from(userBrandRoles).where(eq(userBrandRoles.userId, userId));
    }

    const brandIds = await this.activeBrandIds();
    if (brandIds.length === 0) {
      return [];
    }

    return withTenant(
      this.#db,
      {
        brandIds,
        departmentIds: 'all',
        principalType: 'system',
        principalId: AUTH_SYSTEM_PRINCIPAL,
      },
      (scoped) => scoped.select().from(userBrandRoles).where(eq(userBrandRoles.userId, userId)),
    );
  }

  /** Brands a session may name. A brand being deleted is not one (DOMAIN-RULES §11). */
  async activeBrandIds(tx?: Queryable): Promise<string[]> {
    const rows = await (tx ?? this.#db)
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.status, 'active'));

    return rows.map((row) => row.id);
  }

  async brandsByIds(brandIds: readonly string[], tx?: Queryable): Promise<Brand[]> {
    if (brandIds.length === 0) {
      return [];
    }

    return (tx ?? this.#db)
      .select()
      .from(brands)
      .where(and(inArray(brands.id, [...brandIds]), eq(brands.status, 'active')));
  }

  async updatePasswordHash(userId: string, passwordHash: string, tx?: Queryable): Promise<void> {
    await (tx ?? this.#db).update(users).set({ passwordHash }).where(eq(users.id, userId));
  }

  /** Stores an enrolment that no live code has confirmed yet. */
  async stageTotpSecret(
    userId: string,
    totpSecretEncrypted: string,
    tx?: Queryable,
  ): Promise<void> {
    await (tx ?? this.#db)
      .update(users)
      .set({ totpSecretEncrypted, totpEnabled: false })
      .where(eq(users.id, userId));
  }

  async enableTotp(userId: string, recoveryCodesHashed: string[], tx?: Queryable): Promise<void> {
    await (tx ?? this.#db)
      .update(users)
      .set({ totpEnabled: true, recoveryCodesHashed })
      .where(eq(users.id, userId));
  }

  async replaceRecoveryCodes(
    userId: string,
    recoveryCodesHashed: string[],
    tx?: Queryable,
  ): Promise<void> {
    await (tx ?? this.#db).update(users).set({ recoveryCodesHashed }).where(eq(users.id, userId));
  }

  /** An invited account becomes active the first time it proves an identity. */
  async markActive(userId: string, tx?: Queryable): Promise<void> {
    await (tx ?? this.#db).update(users).set({ status: 'active' }).where(eq(users.id, userId));
  }
}
