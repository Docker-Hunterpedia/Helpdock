import {
  brands,
  currentDepartmentScope,
  type DbTransaction,
  departments,
  type NewTicket,
  type NewTicketMessage,
  nextMessageSeq,
  nextTicketNumber,
  type TicketActivityEntry as TicketActivityRow,
  type TicketMessage as TicketMessageRow,
  type Ticket as TicketRow,
  type TicketStatus as TicketStatusRow,
  ticketActivity,
  ticketMessages,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import type { TicketListQuery } from '@helpdock/schemas';
import { and, asc, eq, gt } from 'drizzle-orm';
import { statusJoin, ticketFilters, ticketOrder } from './ticket-query.js';

/**
 * Every statement the ticket endpoints make, in one file.
 *
 * None of them filters by brand or by department. That is not an omission: the
 * transaction the request runs in carries `app.brand_ids` and
 * `app.department_ids`, and the policies of DOMAIN-RULES §1.3 apply them to
 * every one of these reads and writes. A `WHERE brand_id = …` on top would be a
 * second place for isolation to live — and the one that is easy to forget on
 * the next query somebody adds.
 *
 * The only exception is `brands`, which is a global table with no policy, so
 * the read of a brand's prefix names its id explicitly.
 */

export interface TicketWithStatus {
  readonly ticket: TicketRow;
  readonly status: TicketStatusRow;
}

const withStatus = (row: { tickets: TicketRow; ticket_statuses: TicketStatusRow }) => ({
  ticket: row.tickets,
  status: row.ticket_statuses,
});

export class TicketRepository {
  // ----------------------------------------------------------------- statuses

  async listStatuses(tx: DbTransaction): Promise<TicketStatusRow[]> {
    return tx
      .select()
      .from(ticketStatuses)
      .orderBy(asc(ticketStatuses.sortOrder), asc(ticketStatuses.name));
  }

  /** Undefined when the id is not this brand's, which the policy decides. */
  async findStatus(tx: DbTransaction, statusId: string): Promise<TicketStatusRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.id, statusId))
      .limit(1);

    return rows[0];
  }

  /** The status a new ticket lands in (DOMAIN-RULES §2.2). */
  async findDefaultStatus(tx: DbTransaction): Promise<TicketStatusRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.isDefault, true))
      .orderBy(asc(ticketStatuses.sortOrder))
      .limit(1);

    return rows[0];
  }

  // ------------------------------------------------------------------ tickets

  async findTicket(tx: DbTransaction, ticketId: string): Promise<TicketWithStatus | undefined> {
    const rows = await tx
      .select()
      .from(tickets)
      .innerJoin(ticketStatuses, statusJoin)
      .where(eq(tickets.id, ticketId))
      .limit(1);

    const row = rows[0];
    return row === undefined ? undefined : withStatus(row);
  }

  /**
   * One page of the list. `limit + 1` rows are read so the caller knows whether
   * a next page exists without a second `COUNT(*)`, which at 50k tickets would
   * cost more than the page itself (REQUIREMENTS §5.2).
   */
  async listTickets(tx: DbTransaction, query: TicketListQuery): Promise<TicketWithStatus[]> {
    const { sort, direction, cursor, limit, ...filters } = query;
    const where = ticketFilters({ filters, sort, direction, cursor });

    const rows = await tx
      .select()
      .from(tickets)
      .innerJoin(ticketStatuses, statusJoin)
      .where(where)
      .orderBy(...ticketOrder(sort, direction))
      .limit(limit + 1);

    return rows.map(withStatus);
  }

  /** The prefix printed in front of every number. `brands` has no policy; see above. */
  async brandPrefix(tx: DbTransaction, brandId: string): Promise<string | undefined> {
    const rows = await tx
      .select({ prefix: brands.prefix })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    return rows[0]?.prefix;
  }

  /**
   * Whether a ticket may be filed in that department by *this* request.
   *
   * Two questions, and both are needed. `departments` is brand-scoped and not
   * department-scoped — an Agent has to be able to read the name of every
   * department in the brand — so existence alone would let a Support agent file
   * a ticket in Billing and be refused by the policy with a 500 instead of a
   * sentence. The scope comes from the transaction's own settings, so it is the
   * same value the `WITH CHECK` half of the policy will use.
   */
  async departmentIsWritable(tx: DbTransaction, departmentId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);

    if (rows.length === 0) {
      return false;
    }

    const scope = await currentDepartmentScope(tx);
    return scope === 'all' || scope.includes(departmentId);
  }

  nextNumber(tx: DbTransaction, brandId: string): Promise<number> {
    return nextTicketNumber(tx, brandId);
  }

  async insertTicket(tx: DbTransaction, values: NewTicket): Promise<TicketRow> {
    const rows = await tx.insert(tickets).values(values).returning();

    const row = rows[0];
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The ticket insert returned no row');
    }

    return row;
  }

  /**
   * Returns the updated row, or `undefined` when the policy matched nothing —
   * which is how a ticket outside the caller's department answers, and is the
   * same answer as "no such ticket".
   */
  async updateTicket(
    tx: DbTransaction,
    ticketId: string,
    values: Partial<NewTicket>,
  ): Promise<TicketRow | undefined> {
    const rows = await tx
      .update(tickets)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId))
      .returning();

    return rows[0];
  }

  // ----------------------------------------------------------------- messages

  /** Locks the ticket row and returns the `seq` the next message takes (§7). */
  nextSeq(tx: DbTransaction, ticketId: string): Promise<number> {
    return nextMessageSeq(tx, ticketId);
  }

  /** The already-stored message for a retried send, if there is one (§7). */
  async findMessageByClientId(
    tx: DbTransaction,
    ticketId: string,
    clientId: string,
  ): Promise<TicketMessageRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.clientId, clientId)))
      .limit(1);

    return rows[0];
  }

  async insertMessage(tx: DbTransaction, values: NewTicketMessage): Promise<TicketMessageRow> {
    const rows = await tx.insert(ticketMessages).values(values).returning();

    const row = rows[0];
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The message insert returned no row');
    }

    return row;
  }

  /** The thread from a cursor, oldest first, which is the order it is read in. */
  async messagesAfter(
    tx: DbTransaction,
    ticketId: string,
    after: number,
    limit: number,
  ): Promise<TicketMessageRow[]> {
    return tx
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, ticketId), gt(ticketMessages.seq, after)))
      .orderBy(asc(ticketMessages.seq))
      .limit(limit + 1);
  }

  // ----------------------------------------------------------------- activity

  async activityOf(
    tx: DbTransaction,
    ticketId: string,
    limit: number,
  ): Promise<TicketActivityRow[]> {
    return tx
      .select()
      .from(ticketActivity)
      .where(eq(ticketActivity.ticketId, ticketId))
      .orderBy(asc(ticketActivity.createdAt), asc(ticketActivity.id))
      .limit(limit);
  }
}
