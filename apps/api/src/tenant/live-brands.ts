import { brands, type Db } from '@helpdock/db';
import { eq, ne } from 'drizzle-orm';

/**
 * The brands a system path may still act for. DOMAIN-RULES §11 makes a
 * deleted brand gone for good: its row stays only so the prefix is never
 * reused, and no path runs for it. A brand in its 30-day grace (`deleting`)
 * is disabled but may be restored, so each caller says whether it wants them:
 *
 * - `active`: anything that reaches the outside world on a schedule — pollers,
 *   knowledge syncs. A disabled brand's surfaces answer 410, so nothing may be
 *   sent or fetched on its behalf. A lookup that has to find the brand first
 *   (`withAllBrands`: channel routing, API keys) uses `not-deleted` and
 *   refuses the answer with `isBrandGone`.
 * - `not-deleted`: housekeeping that keeps the brand's own data consistent for
 *   a restore — report rollups, re-embedding after a model change — which the
 *   purge throws away anyway if the grace runs out.
 */
export type BrandLiveness = 'active' | 'not-deleted';

export const liveBrandIds = async (db: Db, liveness: BrandLiveness): Promise<string[]> => {
  const rows = await db
    .select({ id: brands.id })
    .from(brands)
    .where(liveness === 'active' ? eq(brands.status, 'active') : ne(brands.status, 'deleted'));
  return rows.map((row) => row.id);
};
