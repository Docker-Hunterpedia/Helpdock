import { type Db, type DbTransaction, withTenant } from '@helpdock/db';
import { liveBrandIds } from './live-brands.js';

/**
 * A transaction over every brand, as the system principal, for the questions
 * asked *before* a brand is known: which brand an inbound-parse recipient or a
 * Telegram webhook belongs to, whose an API key is (M8-01), which pollers a booting worker re-registers,
 * what the install's System page lists. `brands` is a global table, so reading
 * its ids needs no context; the context is then set to exactly those ids, the
 * way ARCHITECTURE §6 asks an all-brands path to. A purged brand is left out
 * (`live-brands.ts`); one in its deletion grace is still found, because the
 * route that found it answers 410 for it, and the pollers check
 * `isBrandGone` before they fetch.
 *
 * `principalId` names the path, so the database's own logging says who asked.
 */
export const withAllBrands = async <T>(
  db: Db,
  principalId: string,
  fn: (tx: DbTransaction) => Promise<T[]>,
): Promise<T[]> => {
  const brandIds = await liveBrandIds(db, 'not-deleted');
  if (brandIds.length === 0) {
    return [];
  }

  return withTenant(
    db,
    { brandIds, departmentIds: 'all', principalType: 'system', principalId },
    fn,
  );
};
