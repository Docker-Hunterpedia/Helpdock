import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import { z } from 'zod';

/**
 * The outbox rows M14-02 writes (DOMAIN-RULES §6, §3.4).
 *
 * | Event | Written when | Consumed by |
 * |---|---|---|
 * | `ticket.snoozed` | a snooze was set or moved | `snooze-worker.ts`: adds the delayed `ticket.unsnooze` job |
 * | `ticket.snooze_ended` | a snooze ended by time or by an SLA step | the notifications module: `snooze_ended` |
 *
 * A snooze ended by a customer reply, a status change or *Wake now* tells
 * nobody: the person who did it, or whose customer wrote, already knows.
 */

export const SNOOZE_EVENTS = {
  snoozed: 'ticket.snoozed',
  ended: 'ticket.snooze_ended',
} as const;

export const ticketSnoozedPayloadSchema = z.object({
  ticketId: z.uuid(),
  departmentId: z.uuid(),
  /** `tickets.snooze_version` after the change: the timer's key. */
  version: z.int().nonnegative(),
  snoozedUntil: z.iso.datetime(),
});
export type TicketSnoozedPayload = z.infer<typeof ticketSnoozedPayloadSchema>;

export const snoozeEndedPayloadSchema = z.object({
  ticketId: z.uuid(),
  departmentId: z.uuid(),
  cause: z.enum(['time', 'sla']),
  /** Told when nobody holds the ticket. Null when the person has gone. */
  snoozedBy: z.uuid().nullable(),
});
export type SnoozeEndedPayload = z.infer<typeof snoozeEndedPayloadSchema>;

export const enqueueTicketSnoozed = (
  tx: DbTransaction,
  brandId: string,
  payload: TicketSnoozedPayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: SNOOZE_EVENTS.snoozed,
    payload: ticketSnoozedPayloadSchema.parse(payload),
  });

export const enqueueSnoozeEnded = (
  tx: DbTransaction,
  brandId: string,
  payload: SnoozeEndedPayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: SNOOZE_EVENTS.ended,
    payload: snoozeEndedPayloadSchema.parse(payload),
  });
