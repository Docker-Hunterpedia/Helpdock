import {
  brands,
  contacts,
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
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { decodeTicketCursor } from './cursor.js';
import {
  fallsBackToFuzzy,
  type SearchMode,
  statusJoin,
  ticketFilters,
  ticketOrder,
} from './ticket-query.js';

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

/** A page of the list, and which half of the search read it. */
export interface TicketListPage {
  readonly rows: TicketWithStatus[];
  readonly search: SearchMode;
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

  /**
   * One ticket, or `undefined` for a ticket of another department, of another
   * brand, or one an Admin has soft-deleted (DOMAIN-RULES §2.2: "hidden from
   * all views"). All three answer 404 in the handler, which is deliberate: a
   * deleted ticket that answered 410 would confirm that it had existed.
   */
  async findTicket(tx: DbTransaction, ticketId: string): Promise<TicketWithStatus | undefined> {
    const rows = await tx
      .select()
      .from(tickets)
      .innerJoin(ticketStatuses, statusJoin)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);

    const row = rows[0];
    return row === undefined ? undefined : withStatus(row);
  }

  /**
   * One page of the list. `limit + 1` rows are read so the caller knows whether
   * a next page exists without a second `COUNT(*)`, which at 50k tickets would
   * cost more than the page itself (REQUIREMENTS §5.2).
   *
   * A search is read with its exact half first, and again with the fuzzy half
   * only when {@link fallsBackToFuzzy} says so (ADR 0011); a later page of a
   * search that fell back goes straight to the fuzzy half its cursor names.
   */
  async listTickets(
    tx: DbTransaction,
    brandId: string,
    query: TicketListQuery,
  ): Promise<TicketListPage> {
    const cursor = query.cursor === undefined ? undefined : decodeTicketCursor(query.cursor, query);
    const read = async (search: SearchMode): Promise<TicketListPage> => ({
      rows: (await this.listTicketsStatement(tx, brandId, query, search)).map(withStatus),
      search,
    });

    if (query.q !== undefined && cursor?.fuzzy === true) {
      return read('fuzzy');
    }
    const exact = await read('exact');
    const fallBack = fallsBackToFuzzy({
      q: query.q,
      cursor,
      found: exact.rows.length,
      limit: query.limit,
    });

    return fallBack ? read('fuzzy') : exact;
  }

  /**
   * The statement {@link listTickets} runs for one half of a search, unexecuted,
   * so the performance harness can `EXPLAIN` exactly what the api sends rather
   * than a copy of it that drifts (`src/testing/perf`).
   */
  listTicketsStatement(
    tx: DbTransaction,
    brandId: string,
    query: TicketListQuery,
    search: SearchMode = 'exact',
  ) {
    const { sort, direction, cursor, limit, ...filters } = query;
    const where = ticketFilters({ brandId, filters, sort, direction, cursor, search });

    return tx
      .select()
      .from(tickets)
      .innerJoin(ticketStatuses, statusJoin)
      .where(where)
      .orderBy(...ticketOrder(sort, direction))
      .limit(limit + 1);
  }

  /**
   * The name of each contact a page of tickets names, keyed by id: one primary
   * key lookup for the whole page, which is what lets a list row say who wrote
   * in without the screen paging through the contact list (M1-15).
   *
   * `contacts` is brand-scoped and never department-scoped (DOMAIN-RULES
   * §1.2), so the policy answers "in this brand" and an id from another brand
   * is simply absent.
   */
  async contactNames(
    tx: DbTransaction,
    contactIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (contactIds.length === 0) {
      return new Map();
    }

    const rows = await tx
      .select({ id: contacts.id, name: contacts.name })
      .from(contacts)
      .where(inArray(contacts.id, [...new Set(contactIds)]));

    return new Map(rows.map((row) => [row.id, row.name]));
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

  /**
   * Whether the brand has a department with this id at all, whatever the
   * caller's own scope is. `departments` is brand-scoped and never
   * department-scoped, so an Agent may read the name of every department —
   * which is what makes escalation into one of them a decision the service can
   * take rather than a policy violation (DOMAIN-RULES §1.2, and
   * `lifecycle/lifecycle.service.ts` for how the write is made).
   */
  async departmentExists(tx: DbTransaction, departmentId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);

    return rows.length > 0;
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

  /**
   * The **newest** `limit` entries, newest first. The caller reverses them for
   * the thread: a long-running ticket's hundred most recent changes are what a
   * reader needs, and `ORDER BY created_at ASC LIMIT 100` would hand back the
   * first hundred and drop every change since.
   */
  async activityOf(
    tx: DbTransaction,
    ticketId: string,
    limit: number,
  ): Promise<TicketActivityRow[]> {
    return tx
      .select()
      .from(ticketActivity)
      .where(eq(ticketActivity.ticketId, ticketId))
      .orderBy(desc(ticketActivity.createdAt), desc(ticketActivity.id))
      .limit(limit);
  }
}
