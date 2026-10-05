import { brands, type Db, type DbTransaction, withTenant } from '@helpdock/db';

/**
 * A transaction over every brand, as the system principal named
 * `principalId`. For the few questions asked *before* a brand is known: an
 * inbound-parse request names only a recipient (M2-03), a worker booting has
 * to re-register every brand's poller (M2-02), and an API request names only
 * its key (M8-01).
 *
 * `brands` is a global table, so reading its ids needs no context; the context
 * is then set to exactly those ids, the way ARCHITECTURE §6 asks an all-brands
 * path to. With no brand at all there is nothing to scope to, and `empty` is
 * the answer.
 */
export const withAllBrands = async <T>(
  db: Db,
  principalId: string,
  empty: T,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> => {
  const brandIds = (await db.select({ id: brands.id }).from(brands)).map((row) => row.id);
  if (brandIds.length === 0) {
    return empty;
  }

  return withTenant(
    db,
    { brandIds, departmentIds: 'all', principalType: 'system', principalId },
    fn,
  );
};
