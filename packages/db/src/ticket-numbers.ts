import { sql } from 'drizzle-orm';
import type { DbTransaction } from './client.js';
import { brandTicketSequenceName } from './schema/brands.js';

/**
 * The two counters a ticket thread runs on: the display number on the ticket
 * and the `seq` cursor on each of its messages. Both are drawn inside the
 * caller's transaction, so a rolled-back write leaves no gap it can help — a
 * sequence advances anyway, which is why only `seq` is required to be dense.
 */

/** Thrown when a counter cannot be drawn. Always a wiring problem, never input. */
export class TicketNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketNumberError';
  }
}

/**
 * The next display number for a brand, from that brand's own sequence
 * (ARCHITECTURE §5). The sequence is created with the brand by the
 * `brands_create_ticket_sequence` trigger.
 *
 * The name is built by {@link brandTicketSequenceName}, which refuses anything
 * that is not a UUID, and is then bound as a *parameter* cast to `regclass`
 * rather than pasted into the statement, so a brand id can never become SQL.
 *
 * Numbers are not dense. `nextval` is non-transactional by design — that is what
 * lets two requests draw two numbers without waiting for each other — so a
 * rolled-back ticket creation burns its number. A gap in ticket numbers is not
 * a defect; a duplicate would be, and `tickets_brand_number_key` is what would
 * catch one.
 */
export const nextTicketNumber = async (tx: DbTransaction, brandId: string): Promise<number> => {
  const sequence = brandTicketSequenceName(brandId);
  const rows = await tx.execute<{ number: string }>(
    sql`SELECT nextval(${sequence}::regclass)::text AS number`,
  );

  const value = [...rows][0]?.number;
  if (value === undefined) {
    throw new TicketNumberError(`The ticket sequence for brand ${brandId} returned no value`);
  }

  return Number(value);
};

/**
 * The `seq` the next message of a ticket takes (DOMAIN-RULES §7: "a
 * server-assigned `seq`, monotonic per conversation").
 *
 * Two statements, and the order is the whole point:
 *
 * 1. `SELECT … FOR UPDATE` on the ticket row. Twenty replies arriving at once
 *    queue on that lock, one transaction at a time, so no two of them read the
 *    same maximum. The lock is held to the end of the caller's transaction,
 *    which is also where the message is inserted.
 * 2. `max(seq) + 1` over that ticket's messages.
 *
 * Locking the *ticket* rather than the messages is what makes the first message
 * of a ticket safe too: there is no message row to lock yet, and the ticket row
 * always exists. `ticket_messages_ticket_seq_key` is the backstop if this is
 * ever called outside a transaction.
 *
 * A ticket the caller may not see returns no row and raises, rather than
 * quietly handing back 1: row-level security is what decides whether the ticket
 * exists for this principal (DOMAIN-RULES §1.3).
 */
export const nextMessageSeq = async (tx: DbTransaction, ticketId: string): Promise<number> => {
  const locked = await tx.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM tickets WHERE id = ${ticketId}::uuid FOR UPDATE`,
  );

  if ([...locked].length === 0) {
    throw new TicketNumberError(`No ticket ${ticketId} is visible in this transaction`);
  }

  const rows = await tx.execute<{ seq: number }>(
    sql`SELECT coalesce(max(seq), 0) + 1 AS seq FROM ticket_messages WHERE ticket_id = ${ticketId}::uuid`,
  );

  const seq = [...rows][0]?.seq;
  /* c8 ignore next 3 -- an aggregate over zero rows still returns one row. */
  if (seq === undefined) {
    throw new TicketNumberError(`The message sequence for ticket ${ticketId} returned no value`);
  }

  return Number(seq);
};
