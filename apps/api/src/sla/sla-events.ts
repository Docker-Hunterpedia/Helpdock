import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import {
  SLA_EVENTS,
  type SlaBreachedEvent,
  type SlaWarningEvent,
  slaBreachedEventSchema,
  slaWarningEventSchema,
  ticketEscalatedEventSchema,
} from '@helpdock/schemas';
import { z } from 'zod';

/**
 * The outbox rows M3-02 writes (DOMAIN-RULES §6). Clocks are rows and change
 * inside the caller's transaction; everything that leaves the database — a
 * BullMQ timer, a notification — is an outbox row written in the same
 * transaction, and a handler in the worker does the rest.
 *
 * | Event | Written when | Consumed by |
 * |---|---|---|
 * | `sla.schedule` | any clock of these tickets changed | `sla-schedule.ts`: removes and re-adds their timers |
 * | `sla.warning` | a step below 100 % ran | M3-07 notifications |
 * | `sla.breached` | a clock breached, by timer or by a change (§3.3) | M3-07 notifications, M3-03 rules |
 * | `ticket.escalated` | a step at or past 100 % ran, or a step set status Escalated | M3-07 notifications |
 */

export const SLA_SCHEDULE_EVENT = 'sla.schedule';

/** The ids whose timers to bring in line with their clocks. */
export const slaSchedulePayloadSchema = z.object({
  ticketIds: z.array(z.uuid()).min(1).max(500),
});
export type SlaSchedulePayload = z.infer<typeof slaSchedulePayloadSchema>;

/** How many ticket ids one `sla.schedule` row carries; a brand recompute writes several. */
export const SLA_SCHEDULE_CHUNK = 500;

export const enqueueSlaSchedule = async (
  tx: DbTransaction,
  brandId: string,
  ticketIds: readonly string[],
): Promise<void> => {
  const unique = [...new Set(ticketIds)];
  for (let start = 0; start < unique.length; start += SLA_SCHEDULE_CHUNK) {
    await enqueueOutbox(tx, {
      brandId,
      event: SLA_SCHEDULE_EVENT,
      payload: slaSchedulePayloadSchema.parse({
        ticketIds: unique.slice(start, start + SLA_SCHEDULE_CHUNK),
      }),
    });
  }
};

export const enqueueSlaBreached = (
  tx: DbTransaction,
  brandId: string,
  payload: SlaBreachedEvent,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: SLA_EVENTS.breached,
    payload: slaBreachedEventSchema.parse(payload),
  });

export const enqueueSlaWarning = (
  tx: DbTransaction,
  brandId: string,
  payload: SlaWarningEvent,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: SLA_EVENTS.warning,
    payload: slaWarningEventSchema.parse(payload),
  });

export const enqueueTicketEscalated = (
  tx: DbTransaction,
  brandId: string,
  payload: SlaWarningEvent,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: SLA_EVENTS.escalated,
    payload: ticketEscalatedEventSchema.parse(payload),
  });
