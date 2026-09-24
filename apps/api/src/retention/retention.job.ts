import { auditLog, brands, type Db, type DbTransaction } from '@helpdock/db';
import {
  drainInBatches,
  type JobLogger,
  type MaintenanceRetentionPayload,
  maintenanceRetentionJob,
  maintenanceRetentionScheduleJob,
  PayloadValidationError,
  parseJobPayload,
  purgePublishedOutbox,
  purgeReceipts,
  RETENTION_BATCH_SIZE,
  retentionJobId,
} from '@helpdock/jobs';
import { type RetentionCounts, retentionTotal } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import { ne } from 'drizzle-orm';
import { enqueueObjectPurge } from '../media/object-purge.js';
import { withSystemJob } from '../tenant/system-job.js';
import { RetentionRepository, type TicketPurgeKind } from './retention.repository.js';
import { retentionCutoffs, runDateOf, settingsFromRow } from './retention-rules.js';

/**
 * The nightly purge of DOMAIN-RULES §11 (M1-14), as the worker runs it.
 *
 * ```
 * 03:00 UTC  maintenance.retention.schedule   lists brands, adds one job each, purges job_receipts
 *            maintenance.retention (brand A)  closed tickets, spam, audit log, outbox → audit row
 *            maintenance.retention (brand B)  …
 * ```
 *
 * **Tenancy.** Each brand's run is a system principal of that brand alone
 * (DOMAIN-RULES §1.4): every batch opens a transaction with
 * `app.brand_ids = {brandId}`, so row-level security — not a `WHERE` somebody
 * remembered — is what keeps one brand's purge off another brand's rows. The
 * principal id is the job id, and each run ends with a `retention.purged` audit
 * row naming it: this is the audited system path the tenancy rule asks for.
 *
 * **Locks.** Every batch is its own short transaction of at most
 * {@link RETENTION_BATCH_SIZE} rows, so a brand with a year of backlog is many
 * short purges, never one long lock on `tickets`.
 *
 * **Idempotency.** Every purge is "delete what is older than the cutoff", so a
 * retried or repeated run finds fewer rows and deletes nothing twice. The S3
 * objects of a purged ticket go through the outbox in the same transaction as
 * the rows (`media/object-purge.ts`).
 */

export interface BrandRetentionOptions {
  readonly db: Db;
  readonly brandId: string;
  /** The principal id of every transaction, and the actor on the audit row. */
  readonly jobId: string;
  readonly now?: Date;
  readonly batchSize?: number;
  readonly repository?: RetentionRepository;
}

/** Runs one brand's retention and returns what it removed, by category. */
export const runBrandRetention = async ({
  db,
  brandId,
  jobId,
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
  repository = new RetentionRepository(),
}: BrandRetentionOptions): Promise<RetentionCounts> => {
  const inBrand: InBrand = (fn) => withSystemJob(db, brandId, jobId, fn);
  const settings = settingsFromRow(await inBrand((tx) => repository.find(tx, brandId)));
  const cutoffs = retentionCutoffs(settings, now);
  const purge = { inBrand, repository, brandId, batchSize };

  const counts: RetentionCounts = {};
  if (cutoffs.closedTickets !== null) {
    counts.closedTickets = await purgeTickets(purge, 'closed', cutoffs.closedTickets);
  }
  counts.spamTickets = await purgeTickets(purge, 'spam', cutoffs.spamTickets);
  counts.auditLog = await drainInBatches(
    () => inBrand((tx) => repository.purgeAuditBatch(tx, brandId, cutoffs.auditLog, batchSize)),
    batchSize,
  );
  counts.outbox = await drainInBatches(
    () => inBrand((tx) => purgePublishedOutbox(tx, { now, limit: batchSize })),
    batchSize,
  );

  await inBrand((tx) => recordRun(tx, { repository, brandId, jobId, now, counts }));

  return counts;
};

type InBrand = <T>(fn: (tx: DbTransaction) => Promise<T>) => Promise<T>;

interface PurgeScope {
  readonly inBrand: InBrand;
  readonly repository: RetentionRepository;
  readonly brandId: string;
  readonly batchSize: number;
}

/**
 * Expired tickets, one batch per transaction. The attachment keys are read
 * before the delete, because the cascade takes the rows that name them, and are
 * queued in the same transaction (`media/object-purge.ts`).
 */
const purgeTickets = (
  { inBrand, repository, brandId, batchSize }: PurgeScope,
  kind: TicketPurgeKind,
  cutoff: Date,
): Promise<number> =>
  drainInBatches(
    () =>
      inBrand(async (tx) => {
        const ids = await repository.ticketBatch(tx, brandId, { kind, cutoff, limit: batchSize });
        await enqueueObjectPurge(tx, brandId, await repository.attachmentsOfTickets(tx, ids));
        return repository.deleteTickets(tx, ids);
      }),
    batchSize,
  );

interface RunRecord {
  readonly repository: RetentionRepository;
  readonly brandId: string;
  readonly jobId: string;
  readonly now: Date;
  readonly counts: RetentionCounts;
}

/** Counts only, never an id or a value (§11: "logs counts to the audit log"). */
const recordRun = async (
  tx: DbTransaction,
  { repository, brandId, jobId, now, counts }: RunRecord,
): Promise<void> => {
  await tx.insert(auditLog).values({
    brandId,
    actorType: 'system',
    actorId: jobId,
    action: 'retention.purged',
    targetType: 'brand',
    targetId: brandId,
    meta: { counts, total: retentionTotal(counts) },
  });
  await repository.recordRun(tx, brandId, now, counts);
};

/** What the tick needs to add one brand's job. BullMQ in production, a recorder in a test. */
export interface RetentionQueue {
  add(payload: MaintenanceRetentionPayload, jobId: string): Promise<void>;
}

export interface ScheduleRetentionOptions {
  readonly db: Db;
  readonly queue: RetentionQueue;
  readonly now?: Date;
  readonly batchSize?: number;
}

export interface ScheduleResult {
  readonly brands: number;
  readonly receipts: number;
}

/**
 * The nightly tick. `brands` and `job_receipts` are the two global tables
 * (`packages/db/src/rls.ts`), so this is the one part of retention that runs
 * without a tenant context — and all it does with that is read brand ids and
 * purge receipts, which carry no tenant data.
 *
 * The job id is per brand per night ({@link retentionJobId}), so a tick that
 * fires twice adds nothing the second time.
 */
export const scheduleRetention = async ({
  db,
  queue,
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
}: ScheduleRetentionOptions): Promise<ScheduleResult> => {
  const runDate = runDateOf(now);
  // A deleted brand has nothing left to purge; brand deletion is its own path.
  const liveBrands = await db
    .select({ id: brands.id })
    .from(brands)
    .where(ne(brands.status, 'deleted'));

  for (const { id: brandId } of liveBrands) {
    const payload = { brandId, runDate };
    await queue.add(payload, retentionJobId(payload));
  }

  const receipts = await drainInBatches(
    () => purgeReceipts(db, { now, limit: batchSize }),
    batchSize,
  );

  return { brands: liveBrands.length, receipts };
};

export interface MaintenanceProcessorOptions {
  readonly db: Db;
  readonly queue: RetentionQueue;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

/**
 * The `maintenance` queue's processor. BullMQ routes by queue, not by name, so
 * one processor serves both retention jobs and dispatches on `job.name`; any
 * other name fails unrecoverably rather than being run by the wrong code.
 */
export const createMaintenanceProcessor =
  ({ db, queue, log, now = () => new Date() }: MaintenanceProcessorOptions) =>
  async (job: Job): Promise<void> => {
    switch (job.name) {
      case maintenanceRetentionScheduleJob.name: {
        const result = await scheduleRetention({ db, queue, now: now() });
        log.info({ job: job.name, ...result }, 'retention scheduled');
        return;
      }
      case maintenanceRetentionJob.name: {
        const payload = parseRetentionPayload(job.data);
        const counts = await runBrandRetention({
          db,
          brandId: payload.brandId,
          jobId: job.id ?? retentionJobId(payload),
          now: now(),
        });
        log.info({ job: job.name, brandId: payload.brandId, counts }, 'retention finished');
        return;
      }
      default:
        throw new UnrecoverableError(
          `The maintenance queue received job ${job.name}, which no processor here handles.`,
        );
    }
  };

/** A payload that is wrong now will be wrong on every retry, so it fails for good. */
const parseRetentionPayload = (data: unknown): MaintenanceRetentionPayload => {
  try {
    return parseJobPayload(maintenanceRetentionJob, data);
  } catch (error) {
    if (error instanceof PayloadValidationError) {
      throw new UnrecoverableError(error.message);
    }
    /* c8 ignore next -- parseJobPayload throws nothing else. */
    throw error;
  }
};
