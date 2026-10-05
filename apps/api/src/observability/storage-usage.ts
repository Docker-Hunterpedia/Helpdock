import type { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * Storage usage per brand (M8-05), measured by the worker and read by the
 * System page.
 *
 * Measuring is listing every object under a brand's prefix, which on a big
 * bucket is thousands of requests — not something a page load should wait on.
 * So the hourly `stats.rollup` job measures a brand when its reading is older
 * than {@link STORAGE_USAGE_MAX_AGE_MS} and keeps the answer here, one hash
 * field per brand. It is a cache: losing Redis loses the readings until the
 * next run, and nothing else (DOMAIN-RULES §10).
 */

export const STORAGE_USAGE_KEY = 'hd:storage:usage';
export const STORAGE_USAGE_MAX_AGE_MS = 6 * 3_600_000;

const recordSchema = z.object({
  bytes: z.number().nonnegative(),
  objects: z.int().nonnegative(),
  measuredAt: z.iso.datetime(),
});

export interface StorageUsageRecord {
  readonly brandId: string;
  readonly bytes: number;
  readonly objects: number;
  readonly measuredAt: string;
}

export class StorageUsageStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /** Every brand's last reading. A field that does not parse is left out rather than guessed. */
  async all(): Promise<readonly StorageUsageRecord[]> {
    const fields = await this.#redis.hgetall(STORAGE_USAGE_KEY);

    return Object.entries(fields).flatMap(([brandId, value]) => {
      const parsed = recordSchema.safeParse(safeJson(value));
      return parsed.success ? [{ brandId, ...parsed.data }] : [];
    });
  }

  /** Whether the brand's reading is missing or older than the maximum age. */
  async isStale(brandId: string, now: Date): Promise<boolean> {
    const parsed = recordSchema.safeParse(
      safeJson(await this.#redis.hget(STORAGE_USAGE_KEY, brandId)),
    );

    return (
      !parsed.success ||
      now.getTime() - Date.parse(parsed.data.measuredAt) > STORAGE_USAGE_MAX_AGE_MS
    );
  }

  async write({ brandId, ...record }: StorageUsageRecord): Promise<void> {
    await this.#redis.hset(STORAGE_USAGE_KEY, brandId, JSON.stringify(record));
  }

  async remove(brandId: string): Promise<void> {
    await this.#redis.hdel(STORAGE_USAGE_KEY, brandId);
  }
}

const safeJson = (value: string | null | undefined): unknown => {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
