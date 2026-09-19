import type { DbTransaction } from '@helpdock/db';
import {
  enqueueOutbox,
  type OutboxEventContext,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import {
  departmentRoom,
  REALTIME_EVENTS,
  ticketChangedSchema,
  ticketMessageEventSchema,
  ticketRoom,
} from '@helpdock/schemas';
import { z } from 'zod';
import type { RealtimeBroadcast } from '../realtime/broadcast.js';

/**
 * How a ticket change becomes a socket frame, the long way round, which is the
 * only way DOMAIN-RULES §6 allows: "a side effect is enqueued in the same
 * transaction as the change that causes it, and executed at least once,
 * idempotently."
 *
 * ```
 * request  →  tickets + ticket_activity + outbox   (one transaction)
 * relay    →  BullMQ outbox.event                  (after commit, jobId = outbox.id)
 * worker   →  this handler → Redis                 (the api process has no queue)
 * api      →  RealtimePublisher → sockets          (every replica, its own sockets)
 * ```
 *
 * The third hop exists because `APP_ROLE=worker` runs no Nest application and
 * therefore holds no Socket.IO namespace, while `APP_ROLE=api` runs no queue.
 * Redis pub/sub is how the two already talk (`principal.revoked`, M0-05), so
 * this is the same shape rather than a second one.
 *
 * Emitting is not made idempotent and does not need to be. A socket frame
 * delivered twice is a screen that re-reads a ticket twice: "Socket.IO does not
 * guarantee delivery. The REST API is the source of truth; sockets are
 * notifications" (§7).
 */

export const TICKET_EVENTS = {
  created: 'ticket.created',
  updated: 'ticket.updated',
  replied: 'ticket.replied',
  noteAdded: 'ticket.note_added',
} as const;

export type TicketEvent = (typeof TICKET_EVENTS)[keyof typeof TICKET_EVENTS];

/**
 * What an outbox row for a ticket carries. Ids and the department, never a
 * body: the payload is stored in `outbox.payload` and read by a worker, and a
 * note's text has no business being in either.
 */
export const ticketEventPayloadSchema = z.object({
  ticketId: z.uuid(),
  departmentId: z.uuid(),
  /** Present on `ticket.replied` and `ticket.note_added`. */
  messageId: z.uuid().optional(),
  seq: z.int().positive().optional(),
  kind: z.enum(['public', 'note', 'system', 'ai']).optional(),
});
export type TicketEventPayload = z.infer<typeof ticketEventPayloadSchema>;

/**
 * Writes the outbox row for a ticket change through the caller's transaction.
 * `tx` must be the transaction that made the change; passing the pool would
 * commit the row on its own and reintroduce exactly the drift the outbox
 * exists to prevent.
 */
export const enqueueTicketEvent = (
  tx: DbTransaction,
  brandId: string,
  event: TicketEvent,
  payload: TicketEventPayload,
): Promise<string> =>
  enqueueOutbox(tx, { brandId, event, payload: ticketEventPayloadSchema.parse(payload) });

/**
 * Which rooms hear about a change. Both, always:
 *
 * - `ticket:<id>` is whoever has the ticket open, for the thread and for
 *   M1-09's collision indicator;
 * - `department:<id>` is whoever has a queue open, because a new ticket has to
 *   appear in a list nobody was looking at.
 *
 * The department is the ticket's department *now*, which is what lets a client
 * holding the old department's room tell that the ticket has left it.
 */
export const roomsFor = (payload: TicketEventPayload): readonly string[] => [
  ticketRoom(payload.ticketId),
  departmentRoom(payload.departmentId),
];

/**
 * The handler registered for all four ticket events. It is one function rather
 * than four because the difference between them is the payload shape, and the
 * schemas already say what that is.
 */
export const createTicketEventHandler =
  (broadcast: RealtimeBroadcast): OutboxEventHandler =>
  async ({ brandId, event, payload }: OutboxEventContext): Promise<void> => {
    const parsed = ticketEventPayloadSchema.parse(payload);
    const rooms = roomsFor(parsed);

    if (event === TICKET_EVENTS.created || event === TICKET_EVENTS.updated) {
      const data = ticketChangedSchema.parse({
        brandId,
        ticketId: parsed.ticketId,
        departmentId: parsed.departmentId,
        event,
      });

      // No `seq`: a ticket change has no per-ticket cursor to catch up from, and
      // §7 reserves `seq` for what a client replays.
      await broadcast.emit({ rooms, event: REALTIME_EVENTS.ticketChanged, data, seq: null });
      return;
    }

    const data = ticketMessageEventSchema.parse({
      brandId,
      ticketId: parsed.ticketId,
      departmentId: parsed.departmentId,
      messageId: parsed.messageId,
      seq: parsed.seq,
      kind: parsed.kind,
      event,
    });

    await broadcast.emit({
      rooms,
      event: REALTIME_EVENTS.ticketMessage,
      data,
      seq: data.seq,
    });
  };

/**
 * Called by the worker's start-up, before the `outbox.event` consumer exists:
 * "a job that arrives before its handler fails as an unknown event and burns
 * attempts" (`packages/jobs/README.md`).
 */
export const registerTicketEventHandlers = (broadcast: RealtimeBroadcast): void => {
  const handler = createTicketEventHandler(broadcast);

  for (const event of Object.values(TICKET_EVENTS)) {
    registerEventHandler(event, handler);
  }
};
