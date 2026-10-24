import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import { z } from 'zod';

/**
 * `ticket.status_state_resync` — the outbox event a status edit writes when
 * its system state crossed the closed boundary (issue #361). Its worker moves
 * the live tickets already in the status through the lifecycle, a batch at a
 * time: `closed_at`, the clocks of §3.5 or §2.2, the survey, the activity rows
 * and the `ticket.closed` / `ticket.reopened` events an agent moving each
 * ticket would have written.
 *
 * | Event | Written when | Consumed by |
 * |---|---|---|
 * | `ticket.status_state_resync` | a status's `system_state` crossed the closed boundary | `status-state-worker.ts`: closes or reopens the tickets in that status, a batch at a time |
 *
 * It sits beside `sla.status_resync` (#358), which carries the same shape for
 * the `pauses_sla` flag; the two events are independent and a save may write
 * both.
 */

export const TICKET_STATUS_STATE_RESYNC_EVENT = 'ticket.status_state_resync';

/**
 * `at` is when the state changed, so `closed_at` and the restarted clocks
 * count from then and not from whenever the worker got to the batch.
 * `actorType`/`actorId` are the save the tickets moved for: the activity rows
 * record them. `afterId` is the last ticket of the previous batch.
 */
export const ticketStatusStateResyncPayloadSchema = z.object({
  statusId: z.uuid(),
  at: z.coerce.date(),
  actorType: z.enum(['staff', 'visitor', 'apikey', 'system']),
  actorId: z.string().min(1),
  afterId: z.uuid().optional(),
});
export type TicketStatusStateResyncPayload = z.infer<typeof ticketStatusStateResyncPayloadSchema>;

/** Tickets one `ticket.status_state_resync` row moves before it writes its successor. */
export const TICKET_STATUS_STATE_RESYNC_BATCH = 200;

export const enqueueTicketStatusStateResync = (
  tx: DbTransaction,
  brandId: string,
  payload: TicketStatusStateResyncPayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: TICKET_STATUS_STATE_RESYNC_EVENT,
    payload: {
      statusId: payload.statusId,
      at: payload.at.toISOString(),
      actorType: payload.actorType,
      actorId: payload.actorId,
      ...(payload.afterId === undefined ? {} : { afterId: payload.afterId }),
    },
  });
