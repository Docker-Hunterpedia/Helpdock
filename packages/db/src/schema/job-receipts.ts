import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Idempotency keys for consumers that have no natural key to dedupe on
 * (DOMAIN-RULES §6). A job writes its receipt in the same transaction as its
 * effect; a redelivery of the same job finds the receipt and stops.
 *
 * Not a tenant table: the key is chosen by the consumer and already carries
 * whatever scope it needs, and a worker must be able to claim a receipt before
 * it has opened a brand transaction. Rows are purged seven days after
 * completion (DOMAIN-RULES §11).
 */
export const jobReceipts = pgTable('job_receipts', {
  key: text('key').primaryKey(),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type JobReceipt = typeof jobReceipts.$inferSelect;
export type NewJobReceipt = typeof jobReceipts.$inferInsert;
