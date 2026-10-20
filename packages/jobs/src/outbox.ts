import { type DbTransaction, outbox } from '@helpdock/db';
import { z } from 'zod';
import { OUTBOX_EVENT_NAME } from './jobs.js';
import { parsePayload } from './validation.js';

/**
 * The only way domain code asks for a side effect (DOMAIN-RULES §6). A service
 * writes its rows and the outbox row in one transaction; the relay publishes the
 * row to BullMQ afterwards. Calling `queue.add` from a request handler or an
 * event listener is forbidden: the job would exist whether or not the
 * transaction committed, which is the drift the outbox exists to prevent.
 */

export const outboxEntrySchema = z.object({
  brandId: z.uuid(),
  /** Dotted event name the dispatcher resolves to a handler, e.g. `ticket.replied`. */
  event: OUTBOX_EVENT_NAME,
  /** Whatever the handler needs to do the work. Serialised as jsonb, so JSON only. */
  payload: z.record(z.string(), z.unknown()),
});

export type OutboxEntry = z.infer<typeof outboxEntrySchema>;

/**
 * The payload key that asks the relay to hold a job back until an instant
 * (M14-03: a survey for a bulk close waits out the Undo window). Reserved: a
 * handler's own schema strips it, and the relay turns it into the job's delay.
 */
export const OUTBOX_DELIVER_AFTER_KEY = 'deliverAfter';

/** The payload with the reserved key set, for an entry that must not run before `at`. */
export const deliverAfter = (
  payload: Record<string, unknown>,
  at: Date,
): Record<string, unknown> => ({ ...payload, [OUTBOX_DELIVER_AFTER_KEY]: at.toISOString() });

/**
 * Milliseconds the relay holds a row's job back: zero for a row without the
 * key, one whose instant has passed, or one that is not an instant.
 */
export const deliveryDelayMs = (
  payload: Record<string, unknown>,
  now: Date = new Date(),
): number => {
  const value = payload[OUTBOX_DELIVER_AFTER_KEY];
  if (typeof value !== 'string') {
    return 0;
  }
  const at = Date.parse(value);

  return Number.isNaN(at) ? 0 : Math.max(0, at - now.getTime());
};

/**
 * Writes one outbox row through the caller's transaction and returns its id. The
 * id becomes the BullMQ job id, so it is also the handle the relay and the
 * consumers dedupe on.
 *
 * `tx` must be the transaction of the domain change. Passing the pool instead
 * would commit the row on its own and reintroduce the drift.
 */
export const enqueueOutbox = async (tx: DbTransaction, entry: OutboxEntry): Promise<string> => {
  const { brandId, event, payload } = parsePayload('outbox entry', outboxEntrySchema, entry);

  const [row] = await tx
    .insert(outbox)
    .values({ brandId, event, payload })
    .returning({ id: outbox.id });

  if (row === undefined) {
    // An insert refused by row-level security raises, so this is not the shape a
    // wrong tenant context takes; it is here because the id is the handle the
    // whole outbox turns on, and inventing one would be worse than failing.
    throw new Error(`The outbox insert for ${event} returned no row.`);
  }

  return row.id;
};
