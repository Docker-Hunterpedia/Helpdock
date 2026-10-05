import {
  auditLog,
  brands,
  type Db,
  INSTALL_SCOPE_BRAND_ID,
  mailboxes,
  purgeBrandRows,
  systemContext,
  withTenant,
} from '@helpdock/db';
import {
  type BrandPurgePayload,
  brandPurgeJob,
  brandPurgeJobId,
  brandPurgeScheduleJob,
  type JobLogger,
  PayloadValidationError,
  parseJobPayload,
  RETENTION_BATCH_SIZE,
} from '@helpdock/jobs';
import { BRAND_DELETION_GRACE_DAYS, brandPurgeAfter } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import { and, eq, lte } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { BrandObjects } from '../media/brand-objects.js';
import type { StorageUsageStore } from '../observability/storage-usage.js';
import { withSystemJob } from '../tenant/system-job.js';

/**
 * The hard purge of DOMAIN-RULES §11 (M8-07): once a brand's 30-day grace is
 * over, every row it owns, every object under its prefix, every Redis key
 * that names it, and its custom domains (the `brand_domains` rows Caddy's
 * on-demand TLS asks about), are removed. The `brands` row stays, as
 * `deleted`, so its ticket prefix stays taken and a ticket number of the old
 * brand can never name a new one.
 *
 * ```
 * 04:00 UTC  brand.purge.schedule  adds brand.purge for each brand past its grace
 *            brand.purge (brand)   rows table by table → objects → Redis → `deleted` → audit
 * ```
 *
 * **The rows** go through `purgeBrandRows` (`@helpdock/db`, `brand-purge.ts`):
 * every table with a `brand_id` column, read from the database rather than a
 * list, in foreign-key order, as a system principal of this brand alone.
 * `rls.integration.test.ts` fails if a tenant table keeps a row.
 *
 * **Idempotent.** Every step deletes what is left. A purge that dies halfway
 * is retried by BullMQ and finishes; one that runs twice finds nothing.
 */

export interface BrandPurgeDependencies {
  readonly db: Db;
  readonly objects: BrandObjects;
  readonly redis: Redis;
  readonly storageUsage?: StorageUsageStore;
  /** Removes the IMAP pollers of these mailboxes, whose rows the purge is about to delete. */
  readonly removePollers?: (mailboxIds: readonly string[]) => Promise<void>;
}

export interface BrandPurgeOptions extends BrandPurgeDependencies {
  readonly brandId: string;
  readonly jobId: string;
  readonly now?: Date;
  readonly batchSize?: number;
}

export type BrandPurgeResult =
  | { readonly outcome: 'skipped'; readonly reason: 'missing' | 'restored' | 'not_due' }
  | {
      readonly outcome: 'purged';
      readonly rows: Readonly<Record<string, number>>;
      readonly objects: number;
      readonly redisKeys: number;
    };

export const BRAND_PURGED = 'brand.purged';

/** BullMQ's keys: a job hash removed from under its queue would corrupt the queue. */
const QUEUE_KEY_PREFIX = 'bull:';

export const runBrandPurge = async ({
  db,
  objects,
  redis,
  storageUsage,
  removePollers,
  brandId,
  jobId,
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
}: BrandPurgeOptions): Promise<BrandPurgeResult> => {
  const [brand] = await db
    .select({ status: brands.status, deletedAt: brands.deletedAt })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (brand === undefined) {
    return { outcome: 'skipped', reason: 'missing' };
  }
  if (brand.status === 'active') {
    return { outcome: 'skipped', reason: 'restored' };
  }
  if (
    brand.status === 'deleting' &&
    (brand.deletedAt === null || now < brandPurgeAfter(brand.deletedAt))
  ) {
    return { outcome: 'skipped', reason: 'not_due' };
  }

  if (removePollers !== undefined) {
    const owned = await withSystemJob(db, brandId, jobId, (tx) =>
      tx.select({ id: mailboxes.id }).from(mailboxes),
    );
    await removePollers(owned.map((row) => row.id));
  }

  const rows = await purgeBrandRows({ db, brandId, principalId: jobId, batchSize });
  const objectCount = await objects.removeAll(brandId);
  const redisKeys = await purgeRedisKeys(redis, brandId);
  await storageUsage?.remove(brandId);

  await db.update(brands).set({ status: 'deleted' }).where(eq(brands.id, brandId));
  await withTenant(db, systemContext(INSTALL_SCOPE_BRAND_ID, jobId), (tx) =>
    tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'system',
      actorId: jobId,
      action: BRAND_PURGED,
      targetType: 'brand',
      targetId: brandId,
      // Counts only: the rows themselves are what was asked to be forgotten.
      meta: {
        rows: Object.values(rows).reduce((sum, count) => sum + count, 0),
        tables: rows,
        objects: objectCount,
        redisKeys,
      },
    }),
  );

  return { outcome: 'purged', rows, objects: objectCount, redisKeys };
};

/**
 * Every key with the brand's id in its name — the help center's page cache,
 * rate-limit counters, widget presence — except BullMQ's own, which age out
 * on their queues' schedules and would corrupt a queue if pulled from under
 * it. `SCAN`, not `KEYS`, so a large keyspace is walked without blocking
 * Redis.
 */
export const purgeRedisKeys = async (redis: Redis, brandId: string): Promise<number> => {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `*${brandId}*`, 'COUNT', 1_000);
    cursor = next;
    const owned = keys.filter((key) => !key.startsWith(QUEUE_KEY_PREFIX));
    if (owned.length > 0) {
      removed += await redis.unlink(...owned);
    }
  } while (cursor !== '0');

  return removed;
};

/** What the nightly tick needs to add one brand's purge. */
export interface BrandPurgeQueue {
  add(payload: BrandPurgePayload, jobId: string): Promise<void>;
}

/** Adds a purge for every brand whose grace ended before `now`. */
export const scheduleBrandPurges = async ({
  db,
  queue,
  now = new Date(),
}: {
  readonly db: Db;
  readonly queue: BrandPurgeQueue;
  readonly now?: Date;
}): Promise<number> => {
  const graceStart = new Date(now.getTime() - BRAND_DELETION_GRACE_DAYS * 86_400_000);
  const due = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.status, 'deleting'), lte(brands.deletedAt, graceStart)));
  for (const { id: brandId } of due) {
    await queue.add({ brandId }, brandPurgeJobId({ brandId }));
  }

  return due.length;
};

export interface BrandPurgeProcessorOptions extends BrandPurgeDependencies {
  readonly queue: BrandPurgeQueue;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

/** The `maintenance` queue's processor for the purge jobs; `undefined` for any other job. */
export const createBrandPurgeProcessor =
  ({ queue, log, now = () => new Date(), ...deps }: BrandPurgeProcessorOptions) =>
  (job: Job): Promise<void> | undefined => {
    switch (job.name) {
      case brandPurgeScheduleJob.name:
        return scheduleBrandPurges({ db: deps.db, queue, now: now() }).then((count) =>
          log.info({ job: job.name, brands: count }, 'brand purges scheduled'),
        );
      case brandPurgeJob.name: {
        const payload = parsePayload(job.data);
        return runBrandPurge({
          ...deps,
          brandId: payload.brandId,
          jobId: job.id ?? brandPurgeJobId(payload),
          now: now(),
        }).then((result) =>
          log.warn({ job: job.name, brandId: payload.brandId, ...result }, 'brand purge finished'),
        );
      }
      default:
        return undefined;
    }
  };

const parsePayload = (data: unknown): BrandPurgePayload => {
  try {
    return parseJobPayload(brandPurgeJob, data);
  } catch (error) {
    if (error instanceof PayloadValidationError) {
      throw new UnrecoverableError(error.message);
    }
    /* c8 ignore next -- parseJobPayload throws nothing else. */
    throw error;
  }
};
