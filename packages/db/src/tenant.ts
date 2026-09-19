import { sql } from 'drizzle-orm';
import type { Db, DbTransaction } from './client.js';
import { SESSION_SETTINGS } from './rls.js';
import { isUuid } from './uuid.js';

/**
 * The tenant context of ARCHITECTURE §6: every query runs inside a transaction
 * whose `app.*` settings say which brands and departments the principal may
 * reach. The row-level security policies read those settings, so opening a
 * transaction any other way means seeing nothing.
 */

/** The principal kinds of DOMAIN-RULES §1.1. */
export const PRINCIPAL_TYPES = ['staff', 'visitor', 'apikey', 'system'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * Install-wide rows of an otherwise tenant-scoped table (`settings`,
 * `audit_log`) carry this brand id. A null would be invisible to the
 * `brand_id = ANY(…)` policy, and a separate nullable code path would mean a
 * second policy shape to review; the nil UUID keeps one shape for every tenant
 * table. A transaction that must read or write install-scope rows puts it in
 * `brandIds`.
 */
export const INSTALL_SCOPE_BRAND_ID = '00000000-0000-0000-0000-000000000000';

/** Principal id recorded for a worker that has no job id of its own. */
export const SYSTEM_PRINCIPAL_ID = 'system';

export interface TenantContext {
  /** Every brand the principal may reach. Install-admin paths list them all. */
  readonly brandIds: readonly string[];
  /** `'all'` for an Admin, or for an unrestricted Team Leader or Viewer. */
  readonly departmentIds: readonly string[] | 'all';
  readonly principalType: PrincipalType;
  /** User id, visitor id, api key id, or a job id for a system principal. */
  readonly principalId: string;
}

/** Thrown before anything reaches the database, naming the field at fault but never its value. */
export class TenantContextError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid tenant context: ${field} ${reason}`);
    this.name = 'TenantContextError';
    this.field = field;
  }
}

const MAX_PRINCIPAL_ID_LENGTH = 128;
// A principal id is a uuid for staff, visitors and api keys, and a BullMQ job id
// for a worker. Both fit this alphabet; anything else is a caller mistake.
const PRINCIPAL_ID = /^[A-Za-z0-9:._-]+$/;

const uuidArrayLiteral = (field: string, values: readonly string[]): string => {
  for (const value of values) {
    if (!isUuid(value)) {
      throw new TenantContextError(field, 'must contain UUIDs only');
    }
  }
  return `{${values.join(',')}}`;
};

const assertPrincipal = ({ principalType, principalId }: TenantContext): void => {
  if (!PRINCIPAL_TYPES.includes(principalType)) {
    throw new TenantContextError('principalType', `must be one of ${PRINCIPAL_TYPES.join(', ')}`);
  }

  if (
    principalId.length === 0 ||
    principalId.length > MAX_PRINCIPAL_ID_LENGTH ||
    !PRINCIPAL_ID.test(principalId)
  ) {
    throw new TenantContextError(
      'principalId',
      `must be 1 to ${MAX_PRINCIPAL_ID_LENGTH} characters of letters, digits, ':', '.', '_' or '-'`,
    );
  }
};

/**
 * The `(name, value)` pairs a tenant transaction sets. Values are validated
 * here and then bound as query parameters, never pasted into SQL, so a hostile
 * id cannot become a statement.
 */
export const tenantSessionSettings = (
  context: TenantContext,
): readonly (readonly [string, string])[] => {
  if (context.brandIds.length === 0) {
    throw new TenantContextError('brandIds', 'must name at least one brand');
  }
  assertPrincipal(context);

  const allDepartments = context.departmentIds === 'all';
  const departmentIds = allDepartments ? [] : context.departmentIds;

  return [
    [SESSION_SETTINGS.brandIds, uuidArrayLiteral('brandIds', context.brandIds)],
    [SESSION_SETTINGS.departmentIds, uuidArrayLiteral('departmentIds', departmentIds)],
    [SESSION_SETTINGS.allDepartments, String(allDepartments)],
    [SESSION_SETTINGS.principalType, context.principalType],
    [SESSION_SETTINGS.principalId, context.principalId],
  ];
};

/**
 * Runs `fn` in a transaction that carries `context`. The settings are local to
 * the transaction, so a pooled connection handed to the next request starts
 * with none of them.
 */
export const withTenant = <T>(
  db: Db,
  context: TenantContext,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> => {
  const assignments = tenantSessionSettings(context).map(
    ([name, value]) => sql`set_config(${name}, ${value}, true)`,
  );

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT ${sql.join(assignments, sql`, `)}`);
    return fn(tx);
  });
};

/**
 * The department scope the *current transaction* carries, read back out of the
 * session settings.
 *
 * It exists so that a service can refuse a request with a sentence instead of
 * letting a policy refuse it with a 500. A handler that is about to write a row
 * into a department has to know whether this principal reaches it, and asking
 * the transaction is the one way to know that cannot drift: it is literally the
 * value the `WITH CHECK` half of the policy will be evaluated against.
 *
 * Outside a tenant transaction the settings are unset and this answers `[]`,
 * which is the same fail-closed reading the policies take.
 */
export const currentDepartmentScope = async (
  tx: DbTransaction,
): Promise<readonly string[] | 'all'> => {
  const rows = await tx.execute<{ all_departments: string | null; department_ids: string | null }>(
    sql`SELECT current_setting(${SESSION_SETTINGS.allDepartments}, true) AS all_departments,
               current_setting(${SESSION_SETTINGS.departmentIds}, true) AS department_ids`,
  );

  const row = [...rows][0];
  if (row?.all_departments === 'true') {
    return 'all';
  }

  // The setting is a Postgres array literal of uuids, `{a,b}`, written by
  // `tenantSessionSettings`; anything else means no scope at all.
  const literal = row?.department_ids ?? '';
  const inner = literal.startsWith('{') && literal.endsWith('}') ? literal.slice(1, -1) : '';

  return inner.length === 0 ? [] : inner.split(',');
};

/** The context a worker runs under: one brand, every department (DOMAIN-RULES §1.4). */
export const systemContext = (brandId: string, jobId = SYSTEM_PRINCIPAL_ID): TenantContext => ({
  brandIds: [brandId],
  departmentIds: 'all',
  principalType: 'system',
  principalId: jobId,
});

/**
 * Runs `fn` as the system principal for one brand. A job that needs several
 * brands enqueues one child job per brand rather than widening `brandIds`
 * (DOMAIN-RULES §1.4); a job with an id of its own passes it through
 * {@link systemContext} to {@link withTenant} so the audit trail names it.
 */
export const withSystem = <T>(
  db: Db,
  brandId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> => withTenant(db, systemContext(brandId), fn);
