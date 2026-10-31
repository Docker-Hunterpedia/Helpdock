import { type DbTransaction, ticketActivity, tickets } from '@helpdock/db';
import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { recordedArrival } from './arrival.js';

/**
 * M14-26: the arrival record of M14-08 (`to.arrival` on the row that filed the
 * ticket) read as facts a rule's condition and the ticket list can ask about.
 *
 * The record is the source of truth and there is no copy of it on the ticket,
 * so a ticket filed before M14 simply has none and answers "no mailbox".
 * Reads go through `ticket_activity`, which is department-scoped like the
 * ticket, so a filter can only narrow what the reader may already see.
 */

/** The activity rows that carry an arrival record: a creation, a continuation, an import. */
export const ARRIVAL_ACTIONS = ['ticket.created', 'ticket.continued', 'ticket.imported'] as const;

export interface ArrivalFacts {
  /** The mailbox the ticket arrived at; null for any other entry point or no record. */
  readonly mailboxId: string | null;
  /** The address the customer wrote to, lower-cased; null when none was recorded. */
  readonly toAddress: string | null;
}

export const NO_ARRIVAL: ArrivalFacts = { mailboxId: null, toAddress: null };

export const arrivalFactsOf = async (
  tx: DbTransaction,
  ticketId: string,
): Promise<ArrivalFacts> => {
  const [row] = await tx
    .select({ to: ticketActivity.to })
    .from(ticketActivity)
    .where(
      and(
        eq(ticketActivity.ticketId, ticketId),
        inArray(ticketActivity.action, [...ARRIVAL_ACTIONS]),
        sql`${ticketActivity.to} ? 'arrival'`,
      ),
    )
    .orderBy(asc(ticketActivity.createdAt), asc(ticketActivity.id))
    .limit(1);

  const arrival = recordedArrival(row?.to ?? null);
  if (arrival?.entry !== 'mailbox') {
    return NO_ARRIVAL;
  }

  return {
    mailboxId: arrival.entryId,
    toAddress: arrival.address?.toLowerCase() ?? null,
  };
};

const arrivedWhere = (...conditions: SQL[]): SQL => sql`${tickets.id} IN (
  SELECT ${ticketActivity.ticketId} FROM ${ticketActivity}
  WHERE ${ticketActivity.brandId} = ${tickets.brandId}
    AND ${inArray(ticketActivity.action, [...ARRIVAL_ACTIONS])}
    AND ${ticketActivity.to} -> 'arrival' ->> 'entry' = 'mailbox'
    AND ${sql.join(conditions, sql` AND `)}
)`;

/** Tickets that arrived at any of these mailboxes. */
export const mailboxFilterClause = (mailboxIds: readonly string[]): SQL =>
  arrivedWhere(
    inArray(sql`(${ticketActivity.to} -> 'arrival' ->> 'entryId')`, [...new Set(mailboxIds)]),
  );

/** Tickets whose customer wrote to exactly this address (case-insensitive). */
export const toAddressFilterClause = (address: string): SQL =>
  arrivedWhere(
    sql`lower(${ticketActivity.to} -> 'arrival' ->> 'address') = ${address.toLowerCase()}`,
  );
