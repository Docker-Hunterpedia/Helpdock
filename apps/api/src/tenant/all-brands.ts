import { brands, type Db, type DbTransaction, withTenant } from '@helpdock/db';

/**
 * A transaction over every brand, as the system principal, for the questions
 * asked *before* a brand is known: which brand an inbound-parse recipient or a
 * Telegram webhook belongs to, which pollers a booting worker re-registers,
 * what the install's System page lists. `brands` is a global table, so reading
 * its ids needs no context; the context is then set to exactly those ids, the
 * way ARCHITECTURE §6 asks an all-brands path to.
 *
 * `principalId` names the path, so the database's own logging says who asked.
 */
export const withAllBrands = async <T>(
  db: Db,
  principalId: string,
  fn: (tx: DbTransaction) => Promise<T[]>,
): Promise<T[]> => {
  const brandIds = (await db.select({ id: brands.id }).from(brands)).map((row) => row.id);
  if (brandIds.length === 0) {
    return [];
  }

  return withTenant(
    db,
    { brandIds, departmentIds: 'all', principalType: 'system', principalId },
    fn,
  );
};
