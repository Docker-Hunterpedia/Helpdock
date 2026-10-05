import { brands, type Db, isUuid } from '@helpdock/db';
import { eq } from 'drizzle-orm';

/**
 * Whether a brand still answers its customers (M8-07, DOMAIN-RULES §11): a
 * brand whose deletion was requested is `deleting` for its 30-day grace and
 * `deleted` once purged, and through both its widget, help center, web form
 * and channels answer 410 Gone.
 *
 * `brands` is a global table, so the read needs no tenant context. Answers are
 * kept for {@link CACHE_TTL_MS}: the public surfaces are the busiest routes in
 * the install, and "immediately" in the rule is a human's immediately — a
 * deletion is seen by every replica within seconds, and a restore the same.
 */

const CACHE_TTL_MS = 5_000;

export type BrandAvailabilityState = 'active' | 'gone' | 'missing';

export class BrandAvailability {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #cache = new Map<string, { state: BrandAvailabilityState; until: number }>();

  constructor(db: Db, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  async stateOf(brandId: string): Promise<BrandAvailabilityState> {
    const cached = this.#cache.get(brandId);
    if (cached !== undefined && cached.until > this.#now()) {
      return cached.state;
    }
    const state = await readBrandAvailability(this.#db, brandId);
    this.#cache.set(brandId, { state, until: this.#now() + CACHE_TTL_MS });

    return state;
  }

  async isGone(brandId: string): Promise<boolean> {
    return (await this.stateOf(brandId)) === 'gone';
  }
}

/** One uncached read, for a worker job that runs once a minute at most. */
export const readBrandAvailability = async (
  db: Db,
  brandId: string,
): Promise<BrandAvailabilityState> => {
  if (!isUuid(brandId)) {
    return 'missing';
  }
  const [row] = await db
    .select({ status: brands.status })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (row === undefined) {
    return 'missing';
  }

  return row.status === 'active' ? 'active' : 'gone';
};

export const isBrandGone = async (db: Db, brandId: string): Promise<boolean> =>
  (await readBrandAvailability(db, brandId)) === 'gone';
