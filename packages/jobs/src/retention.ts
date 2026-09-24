import { type Db, type DbTransaction, jobReceipts, outbox } from '@helpdock/db';
import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import { RETENTION_DAYS } from './jobs.js';

/**
 * "Outbox, job receipts — 7 days after publish/complete, hard delete"
 * (DOMAIN-RULES §11). `maintenance.retention` calls these nightly; they are
 * plain functions so the job stays a thin wrapper and the maths stays testable.
 *
 * Both delete **one bounded batch** and return how many rows went. The caller
 * loops until a batch comes back short, each batch in a transaction of its
 * own, so a backlog of a million rows is a million-row purge made of short
 * transactions rather than one long lock.
 */

const MS_PER_DAY = 86_400_000;

/** How many rows one purge statement removes at most, unless the caller says otherwise. */
export const RETENTION_BATCH_SIZE = 500;

/** The instant rows older than which are purged. */
export const retentionCutoff = (olderThanDays: number, now: Date = new Date()): Date => {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new RangeError('retentionCutoff expects a whole number of days, at least 1');
  }
  return new Date(now.getTime() - olderThanDays * MS_PER_DAY);
};

export interface PurgeBatchOptions {
  readonly olderThanDays?: number;
  readonly now?: Date;
  readonly limit?: number;
}

/**
 * Deletes up to `limit` published outbox rows older than the cutoff. `outbox`
 * is a tenant table, so this runs inside the brand's transaction and row-level
 * security keeps it to that brand.
 */
export const purgePublishedOutbox = async (
  tx: DbTransaction,
  { olderThanDays = RETENTION_DAYS, now, limit = RETENTION_BATCH_SIZE }: PurgeBatchOptions = {},
): Promise<number> => {
  const cutoff = retentionCutoff(olderThanDays, now);
  const batch = tx
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(isNotNull(outbox.publishedAt), lt(outbox.publishedAt, cutoff)))
    .limit(limit);

  const rows = await tx
    .delete(outbox)
    .where(inArray(outbox.id, batch))
    .returning({ id: outbox.id });

  return rows.length;
};

/**
 * Deletes up to `limit` completed receipts older than the cutoff. `job_receipts`
 * is global, so this takes the pool or a transaction and needs no tenant
 * context; the nightly tick runs it once, not once per brand.
 *
 * The cutoff has to stay comfortably longer than the longest retry schedule of
 * any job: deleting a receipt while a delivery of its job can still arrive would
 * let that delivery run a second time.
 */
export const purgeReceipts = async (
  db: Db | DbTransaction,
  { olderThanDays = RETENTION_DAYS, now, limit = RETENTION_BATCH_SIZE }: PurgeBatchOptions = {},
): Promise<number> => {
  const cutoff = retentionCutoff(olderThanDays, now);
  const batch = db
    .select({ key: jobReceipts.key })
    .from(jobReceipts)
    .where(lt(jobReceipts.completedAt, cutoff))
    .limit(limit);

  const rows = await db
    .delete(jobReceipts)
    .where(inArray(jobReceipts.key, batch))
    .returning({ key: jobReceipts.key });

  return rows.length;
};

/**
 * Runs `batch` until it removes fewer rows than a full batch, and returns the
 * total. `batch` opens its own transaction each time, which is the point.
 */
export const drainInBatches = async (
  batch: () => Promise<number>,
  limit: number = RETENTION_BATCH_SIZE,
): Promise<number> => {
  let total = 0;
  for (;;) {
    const removed = await batch();
    total += removed;
    if (removed < limit) {
      return total;
    }
  }
};
