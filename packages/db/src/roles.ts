import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * DOMAIN-RULES §1.5 splits the database in two: `helpdock_owner` owns the schema
 * and runs migrations, `helpdock_app` runs queries and cannot escape row-level
 * security. "A startup check refuses to serve if the runtime connection can
 * bypass RLS" — this is that check.
 */

/** The runtime role the migration provisions and `DATABASE_URL` connects as. */
export const APP_ROLE_NAME = 'helpdock_app';

export interface RuntimeRoleFacts {
  readonly roleName: string;
  /** True if the role, or any role it can assume, is a superuser. */
  readonly superuser: boolean;
  /** True if the role, or any role it can assume, has `BYPASSRLS`. */
  readonly bypassRls: boolean;
  /** Tables in the search path owned by the role, which would also escape FORCEd policies. */
  readonly ownedTables: number;
}

/** Why a role must not serve traffic, or an empty list if it may. */
export const unsafeRuntimeRoleReasons = (facts: RuntimeRoleFacts): readonly string[] => {
  const reasons: string[] = [];
  if (facts.superuser) {
    reasons.push('it is a superuser, or a member of one');
  }
  if (facts.bypassRls) {
    reasons.push('it has BYPASSRLS, or is a member of a role that has it');
  }
  if (facts.ownedTables > 0) {
    reasons.push(`it owns ${facts.ownedTables} table(s) in the schema`);
  }
  return reasons;
};

export class UnsafeRuntimeRoleError extends Error {
  readonly roleName: string;
  readonly reasons: readonly string[];

  constructor(roleName: string, reasons: readonly string[]) {
    super(
      `The database role ${roleName} must not serve traffic: ${reasons.join('; ')}. ` +
        `DATABASE_URL has to name the ${APP_ROLE_NAME} role, not the migration owner (DOMAIN-RULES §1.5).`,
    );
    this.name = 'UnsafeRuntimeRoleError';
    this.roleName = roleName;
    this.reasons = reasons;
  }
}

const readFacts = (row: Record<string, unknown> | undefined): RuntimeRoleFacts => {
  const roleName = row?.role_name;
  const superuser = row?.superuser;
  const bypassRls = row?.bypass_rls;
  const ownedTables = row?.owned_tables;

  if (
    typeof roleName !== 'string' ||
    typeof superuser !== 'boolean' ||
    typeof bypassRls !== 'boolean' ||
    typeof ownedTables !== 'number'
  ) {
    throw new TypeError('The runtime role check did not get a row it understands from Postgres');
  }

  return { roleName, superuser, bypassRls, ownedTables };
};

const runtimeRoleFacts = async (db: Db): Promise<RuntimeRoleFacts> => {
  // `pg_has_role(…, 'MEMBER')` covers the role itself and every role it may
  // `SET ROLE` to: inheriting the attribute is not required to use it.
  const rows = await db.execute(sql`
    SELECT
      current_user::text AS role_name,
      coalesce(bool_or(r.rolsuper), false) AS superuser,
      coalesce(bool_or(r.rolbypassrls), false) AS bypass_rls,
      (
        SELECT count(*)::int
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname = ANY (current_schemas(false))
          AND pg_has_role(current_user, c.relowner, 'MEMBER')
      ) AS owned_tables
    FROM pg_roles r
    WHERE pg_has_role(current_user, r.oid, 'MEMBER')
  `);

  return readFacts(rows[0]);
};

/**
 * Called by the api and the worker before they serve anything. Throws
 * {@link UnsafeRuntimeRoleError} when the connection could read another brand's
 * rows whatever the policies say, and otherwise returns what it found, so boot
 * can log which role it verified.
 */
export const assertRuntimeRoleIsSafe = async (db: Db): Promise<RuntimeRoleFacts> => {
  const facts = await runtimeRoleFacts(db);
  const reasons = unsafeRuntimeRoleReasons(facts);

  if (reasons.length > 0) {
    throw new UnsafeRuntimeRoleError(facts.roleName, reasons);
  }

  return facts;
};
