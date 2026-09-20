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

/**
 * Runs `fn` with `departmentIds` added to the transaction's department scope,
 * and puts the scope back afterwards.
 *
 * It exists for exactly one rule. DOMAIN-RULES §1.2: "Moving a ticket to a
 * department the actor cannot see is allowed (it is how escalation works); the
 * ticket disappears from their view afterwards and the activity log records
 * it." The `WITH CHECK` half of the department policy refuses that write,
 * because the row it would leave behind is one the writer may not read — which
 * is the right default for every other statement on the table.
 *
 * The alternative would have been a second policy shape on `tickets` alone, or
 * a `SECURITY DEFINER` function that bypasses row-level security. Both make the
 * escalation path a place where isolation is decided *differently*; this makes
 * it a place where the scope is briefly wider and the policy is the same one.
 *
 * Three properties make that safe, and all three are load-bearing:
 *
 * - **The brand is never widened.** `app.brand_ids` is untouched, so the widest
 *   this can reach is another department of the brand the request has already
 *   been authorised for.
 * - **The window is one call.** The previous value is restored in a `finally`,
 *   so a throw inside `fn` cannot leave a transaction running wide; and the
 *   settings are `SET LOCAL` to begin with, so even a lost restore ends when
 *   the transaction does.
 * - **The ids are validated.** Anything that is not a UUID is refused before a
 *   statement is built, and the value is bound as a parameter rather than
 *   pasted into SQL — the same rule {@link tenantSessionSettings} follows.
 *
 * A transaction whose scope is already `'all'` runs `fn` unchanged: there is
 * nothing to widen, and rewriting the setting would only narrow it.
 */
export const withWidenedDepartments = async <T>(
  tx: DbTransaction,
  departmentIds: readonly string[],
  fn: () => Promise<T>,
): Promise<T> => {
  const scope = await currentDepartmentScope(tx);
  if (scope === 'all') {
    return fn();
  }

  const widened = [...new Set([...scope, ...departmentIds])];
  const literal = uuidArrayLiteral('departmentIds', widened);

  const setScope = (value: string): Promise<unknown> =>
    tx.execute(sql`SELECT set_config(${SESSION_SETTINGS.departmentIds}, ${value}, true)`);

  await setScope(literal);
  try {
    return await fn();
  } finally {
    await setScope(uuidArrayLiteral('departmentIds', scope));
  }
};
