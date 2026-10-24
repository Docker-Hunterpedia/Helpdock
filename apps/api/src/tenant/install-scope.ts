import {
  auditLog,
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  isUuid,
  SESSION_SETTINGS,
} from '@helpdock/db';
import { sql } from 'drizzle-orm';
import type { Principal } from '../auth/principal.js';
import { principalIdOf } from '../auth/principal.js';
import type { RequestContext } from '../context/request-context.js';

/** The audit action every install-scope entry is recorded under. */
export const INSTALL_SCOPE_ACTION = 'install.scope.access';

/**
 * "Install-admin 'all brands' paths set the full list explicitly and are
 * audited" (ARCHITECTURE §6). The row is written inside the request's own
 * transaction, before the handler runs: if the handler fails and the
 * transaction rolls back, the access did not happen either.
 */
export const auditInstallScopeAccess = async (
  tx: DbTransaction,
  context: RequestContext,
  principal: Principal,
): Promise<void> => {
  await tx.insert(auditLog).values({
    brandId: INSTALL_SCOPE_BRAND_ID,
    actorType: principal.type,
    actorId: principalIdOf(principal),
    action: INSTALL_SCOPE_ACTION,
    targetType: 'route',
    targetId: `${context.method} ${context.path}`,
    meta: { requestId: context.requestId },
  });
};

/**
 * Widens an install-scope transaction's `app.brand_ids` from the sentinel alone
 * to the sentinel and `brandIds`, so an install-wide read can see every brand's
 * rows — M3-08's audit log viewer, which is "who changed what" across the
 * install.
 *
 * **Why this is not a back door**, for the reasons `InstallBrandsService`'s
 * `#reachInto` gives: only an `install:admin` route runs in install scope, and
 * that route has already written its own `install.scope.access` row; the
 * setting is `SET LOCAL` and dies with the transaction; every id is checked to
 * be a UUID and bound as a parameter. It refuses to run from any transaction
 * that does not hold the sentinel alone, so it cannot widen a brand's own.
 */
export const widenInstallScope = async (
  tx: DbTransaction,
  brandIds: readonly string[],
): Promise<void> => {
  for (const brandId of brandIds) {
    if (!isUuid(brandId)) {
      throw new TypeError('A brand id must be a UUID before it reaches a session setting');
    }
  }

  const [current] = await tx.execute<{ value: string }>(
    sql`SELECT current_setting('app.brand_ids', true) AS value`,
  );
  if ((current?.value ?? '') !== `{${INSTALL_SCOPE_BRAND_ID}}`) {
    throw new Error(
      'Widening the tenant scope is only safe from an install-scope transaction that holds the sentinel alone',
    );
  }

  await tx.execute(
    sql`SELECT set_config('app.brand_ids', ${`{${[INSTALL_SCOPE_BRAND_ID, ...brandIds].join(',')}}`}, true)`,
  );
};

/**
 * Runs `fn` with the install scope added to the transaction's brands, and puts
 * the brands back afterwards.
 *
 * It exists for a request that holds a pooled connection and needs one
 * install-wide value (`sso.enforced`, the pinned passkey RP ID). The
 * alternative, `withSystem` on the pool, takes a second connection while the
 * first is held; as many such requests as the pool has connections then wait
 * on each other for good.
 *
 * Rules for `fn`:
 * - **Read.** The one write allowed is the audited RP ID pin of
 *   `RpIdPin.pinIfUnset`; the install scope's policy would accept any other
 *   install-settings write, so nothing else writes in here.
 * - **One call at a time per transaction.** A nested call sees the scope
 *   already present and does nothing, and the outer call's restore then
 *   narrows it under the inner caller.
 *
 * The setting is transaction-local, so even a lost restore ends with the
 * transaction. A restore that fails after `fn` threw (an aborted transaction)
 * does not hide the original error.
 */
export const withInstallScope = async <T>(tx: DbTransaction, fn: () => Promise<T>): Promise<T> => {
  const [current] = await tx.execute<{ value: string | null }>(
    sql`SELECT current_setting(${SESSION_SETTINGS.brandIds}, true) AS value`,
  );
  const literal = current?.value ?? '';
  const held = literal.startsWith('{') && literal.endsWith('}') ? literal.slice(1, -1) : '';
  const brandIds = held === '' ? [] : held.split(',');
  if (brandIds.includes(INSTALL_SCOPE_BRAND_ID)) {
    return fn();
  }
  if (!brandIds.every(isUuid)) {
    throw new TypeError('A brand id must be a UUID before it reaches a session setting');
  }

  const setBrands = (value: string): Promise<unknown> =>
    tx.execute(sql`SELECT set_config(${SESSION_SETTINGS.brandIds}, ${value}, true)`);

  await setBrands(`{${[...brandIds, INSTALL_SCOPE_BRAND_ID].join(',')}}`);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await setBrands(literal).catch(() => undefined);
    throw error;
  }
  await setBrands(literal);

  return result;
};
