import { type Db, type DbTransaction, jobReceipts, outbox } from '@helpdock/db';
import { and, isNotNull, lt } from 'drizzle-orm';
import { RETENTION_DAYS } from './jobs.js';

/**
 * "Outbox, job receipts — 7 days after publish/complete, hard delete"
 * (DOMAIN-RULES §11). `maintenance.retention` calls these nightly; they are
 * plain functions so the job stays a thin wrapper and the maths stays testable.
 */

const MS_PER_DAY = 86_400_000;

/** The instant rows older than which are purged. */
export const retentionCutoff = (olderThanDays: number, now: Date = new Date()): Date => {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new RangeError('retentionCutoff expects a whole number of days, at least 1');
  }
  return new Date(now.getTime() - olderThanDays * MS_PER_DAY);
};

/**
 * Deletes published outbox rows older than the cutoff and returns how many.
 * `outbox` is a tenant table, so this runs inside the brand's transaction and
 * row-level security keeps it to that brand.
 */
export const purgePublishedOutbox = async (
  tx: DbTransaction,
  olderThanDays: number = RETENTION_DAYS,
  now?: Date,
): Promise<number> => {
  const cutoff = retentionCutoff(olderThanDays, now);

  const rows = await tx
    .delete(outbox)
    .where(and(isNotNull(outbox.publishedAt), lt(outbox.publishedAt, cutoff)))
    .returning({ id: outbox.id });

  return rows.length;
};

/**
 * Deletes completed receipts older than the cutoff and returns how many.
 * `job_receipts` is global, so this takes the pool or a transaction and needs no
 * tenant context.
 *
 * The cutoff has to stay comfortably longer than the longest retry schedule of
 * any job: deleting a receipt while a delivery of its job can still arrive would
 * let that delivery run a second time.
 */
export const purgeReceipts = async (
  db: Db | DbTransaction,
  olderThanDays: number = RETENTION_DAYS,
  now?: Date,
): Promise<number> => {
  const cutoff = retentionCutoff(olderThanDays, now);

  const rows = await db
    .delete(jobReceipts)
    .where(lt(jobReceipts.completedAt, cutoff))
    .returning({ key: jobReceipts.key });

  return rows.length;
};
