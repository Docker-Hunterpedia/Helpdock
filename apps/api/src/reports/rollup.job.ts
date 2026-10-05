import { brands, type Db, type DbTransaction } from '@helpdock/db';
import {
  type JobLogger,
  PayloadValidationError,
  parseJobPayload,
  type StatsRollupPayload,
  statsRollupJob,
  statsRollupJobId,
  statsRollupScheduleJob,
} from '@helpdock/jobs';
import { parseBrandSettings } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { BrandObjects } from '../media/brand-objects.js';
import type { StorageUsageStore } from '../observability/storage-usage.js';
import { withSystemJob } from '../tenant/system-job.js';
import { RollupRepository } from './rollup.repository.js';
import { chunkDays, type DayRange, localDay, rollupWindow } from './rollup-window.js';

/**
 * The `stats.rollup` cron of ARCHITECTURE §13 (M8-04), as the worker runs it.
 *
 * ```
 * :07 every hour  stats.rollup.schedule   lists active brands, adds one job each
 *                 stats.rollup (brand A)  rebuilds the trailing week, or backfills
 *                                         and measures the brand's storage when stale
 * ```
 *
 * Each brand's run is a system principal of that brand alone (DOMAIN-RULES
 * §1.4), one transaction per chunk of days (`rollup-window.ts`).
 */

/** What measures and remembers a brand's storage; absent in a suite that does not care. */
export interface StorageMeasurement {
  readonly objects: BrandObjects;
  readonly store: StorageUsageStore;
}

export interface BrandRollupOptions {
  readonly db: Db;
  readonly brandId: string;
  readonly jobId: string;
  readonly now?: Date;
  readonly repository?: RollupRepository;
  readonly storage?: StorageMeasurement;
}

export interface BrandRollupResult {
  readonly range: DayRange | null;
  readonly storageMeasured: boolean;
}

/** Rebuilds one brand's rollups. A brand that is gone or being deleted has nothing to report. */
export const runBrandRollup = async ({
  db,
  brandId,
  jobId,
  now = new Date(),
  repository = new RollupRepository(),
  storage,
}: BrandRollupOptions): Promise<BrandRollupResult> => {
  const [brand] = await db
    .select({ status: brands.status, timezone: brands.timezone, settings: brands.settings })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (brand?.status !== 'active') {
    return { range: null, storageMeasured: false };
  }

  const { timezone } = brand;
  const countReopens = parseBrandSettings(brand.settings).slaCountReopens;
  const inBrand = <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withSystemJob(db, brandId, jobId, fn);

  const range = await inBrand(async (tx) =>
    rollupWindow({
      today: localDay(now, timezone),
      rolledUpBefore: await repository.hasRollups(tx, brandId),
      firstActivityDay: await repository.firstActivityDay(tx, brandId, timezone),
    }),
  );
  for (const chunk of chunkDays(range)) {
    await inBrand((tx) =>
      repository.rebuild(tx, { brandId, timezone, range: chunk, countReopens }),
    );
  }

  return { range, storageMeasured: await measureStorage(storage, brandId, now) };
};

const measureStorage = async (
  storage: StorageMeasurement | undefined,
  brandId: string,
  now: Date,
): Promise<boolean> => {
  if (storage === undefined || !(await storage.store.isStale(brandId, now))) {
    return false;
  }
  const usage = await storage.objects.usage(brandId);
  await storage.store.write({ brandId, ...usage, measuredAt: now.toISOString() });

  return true;
};

/** What the tick needs to add one brand's job. BullMQ in production, a recorder in a test. */
export interface StatsRollupQueue {
  add(payload: StatsRollupPayload, jobId: string): Promise<void>;
}

/**
 * The hourly tick. `brands` is a global table, so listing it needs no tenant
 * context; everything a brand's run reads is read in that brand's own.
 */
export const scheduleStatsRollup = async ({
  db,
  queue,
  now = new Date(),
}: {
  readonly db: Db;
  readonly queue: StatsRollupQueue;
  readonly now?: Date;
}): Promise<number> => {
  const tick = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();
  const active = await db.select({ id: brands.id }).from(brands).where(eq(brands.status, 'active'));
  for (const { id: brandId } of active) {
    const payload = { brandId, tick };
    await queue.add(payload, statsRollupJobId(payload));
  }

  return active.length;
};

export interface StatsProcessorOptions {
  readonly db: Db;
  readonly queue: StatsRollupQueue;
  readonly log: JobLogger;
  readonly storage?: StorageMeasurement;
  readonly now?: () => Date;
}

/**
 * The `maintenance` queue's processor for the two rollup jobs. Returns
 * `undefined` for any other job, so the worker can hand it to the next
 * processor on the queue.
 */
export const createStatsProcessor =
  ({ db, queue, log, storage, now = () => new Date() }: StatsProcessorOptions) =>
  (job: Job): Promise<void> | undefined => {
    switch (job.name) {
      case statsRollupScheduleJob.name:
        return scheduleStatsRollup({ db, queue, now: now() }).then((brandCount) =>
          log.info({ job: job.name, brands: brandCount }, 'report rollups scheduled'),
        );
      case statsRollupJob.name: {
        const payload = parsePayload(job.data);
        return runBrandRollup({
          db,
          brandId: payload.brandId,
          jobId: job.id ?? statsRollupJobId(payload),
          now: now(),
          ...(storage === undefined ? {} : { storage }),
        }).then((result) =>
          log.info(
            { job: job.name, brandId: payload.brandId, ...result },
            'report rollup finished',
          ),
        );
      }
      default:
        return undefined;
    }
  };

/** A payload that is wrong now will be wrong on every retry, so it fails for good. */
const parsePayload = (data: unknown): StatsRollupPayload => {
  try {
    return parseJobPayload(statsRollupJob, data);
  } catch (error) {
    if (error instanceof PayloadValidationError) {
      throw new UnrecoverableError(error.message);
    }
    /* c8 ignore next -- parseJobPayload throws nothing else. */
    throw error;
  }
};
