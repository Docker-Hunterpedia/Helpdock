import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import { z } from 'zod';

/**
 * The outbox row M14-03's Undo writes (DOMAIN-RULES §6).
 *
 * | Event | Written when | Consumed by |
 * |---|---|---|
 * | `ticket.bulk_undone` | a bulk edit was undone | the notifications module: withdraws what the edit told people |
 *
 * The bulk edit's own side effects are the single-ticket ones, written by the
 * same code per ticket; this is the only event bulk adds.
 */
export const BULK_EVENTS = { undone: 'ticket.bulk_undone' } as const;

export const bulkUndonePayloadSchema = z.object({
  operationId: z.uuid(),
  ticketIds: z.array(z.uuid()).min(1),
});
export type BulkUndonePayload = z.infer<typeof bulkUndonePayloadSchema>;

export const enqueueBulkUndone = (
  tx: DbTransaction,
  brandId: string,
  payload: BulkUndonePayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: BULK_EVENTS.undone,
    payload: bulkUndonePayloadSchema.parse(payload),
  });
