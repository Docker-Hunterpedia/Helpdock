import { brands, type Db, seedBrandViews } from '@helpdock/db';
import { ne } from 'drizzle-orm';
import { withSystemJob } from '../tenant/system-job.js';

/**
 * Writes whichever built-in views an existing brand is missing, at api boot.
 *
 * A migration cannot do it: M14-02 added `snoozed` to the `ticket_view_built_in`
 * enum, and a value added to an enum cannot be used in the transaction that
 * added it. `seedBrandViews` is idempotent on the unique built-in index, so
 * running it for every brand on every boot writes rows only for a brand that
 * lacks one, and the next built-in view needs no migration of its own.
 */
export const backfillBuiltInViews = async (db: Db): Promise<number> => {
  const live = await db.select({ id: brands.id }).from(brands).where(ne(brands.status, 'deleted'));

  for (const { id } of live) {
    await withSystemJob(db, id, 'boot.built-in-views', (tx) => seedBrandViews(tx, id));
  }

  return live.length;
};
