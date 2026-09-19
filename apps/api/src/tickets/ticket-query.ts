import { ticketStatuses, tickets } from '@helpdock/db';
import type { TicketListQuery, TicketSort, TicketSortDirection } from '@helpdock/schemas';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { decodeTicketCursor, encodeTicketCursor, type TicketCursor } from './cursor.js';

/**
 * The ticket list's `WHERE` and `ORDER BY`, built from the parsed query.
 *
 * Nothing here narrows by brand or by department. That is row-level security's
 * job and it is not repeated: a filter that also enforced isolation would be a
 * second place for isolation to be wrong, and the one that is easiest to forget
 * (DOMAIN-RULES §1.3). What this file decides is only what the *reader asked
 * for* within what they may already see.
 *
 * Every value reaches SQL as a bound parameter. The search term in particular
 * goes to `websearch_to_tsquery`, which parses a user's words and never raises
 * on nonsense, rather than to `to_tsquery`, which does.
 */

/** Which column each sort orders by, and the type its cursor value is cast to. */
const SORT_COLUMNS: Record<TicketSort, { readonly column: PgColumn; readonly cast: string }> = {
  updatedAt: { column: tickets.updatedAt, cast: 'timestamptz' },
  createdAt: { column: tickets.createdAt, cast: 'timestamptz' },
  number: { column: tickets.number, cast: 'bigint' },
  priority: { column: tickets.priority, cast: 'ticket_priority' },
};

/**
 * `assigneeId` may name people *and* "nobody". The two cannot be one `IN` list,
 * so an `unassigned` chip becomes `assignee_id IS NULL` beside it.
 */
const assigneeFilter = (values: readonly (string | 'unassigned')[]): SQL | undefined => {
  const ids = values.filter((value) => value !== 'unassigned');
  const clauses: SQL[] = [];

  if (ids.length > 0) {
    clauses.push(inArray(tickets.assigneeId, ids));
  }
  if (values.includes('unassigned')) {
    clauses.push(isNull(tickets.assigneeId));
  }

  return clauses.length === 0 ? undefined : or(...clauses);
};

/**
 * Full text first, trigram second. `websearch_to_tsquery` understands what an
 * agent types — quoted phrases, `-excluded` — and the trigram half catches the
 * half-typed and the misspelled through `tickets_subject_trgm_idx`. Neither is
 * enough alone: full text will not match `renewa` against "renewal", and
 * trigram will not match "invoice" against a subject that says "invoices" as
 * confidently as a stemmer does.
 *
 * The trigram operator is `<%` (word similarity), not `%` (similarity). `%`
 * compares two strings *whole*, so a six-letter query against a fifty-letter
 * subject scores near zero however well it matches one of its words — which is
 * every search anybody types. `<%` asks whether the query matches some run of
 * words inside the subject, which is the question being asked. The query goes
 * on the left; the operator is not symmetric.
 */
const searchFilter = (term: string): SQL =>
  sql`(${tickets.search} @@ websearch_to_tsquery('english', ${term}) OR ${term} <% ${tickets.subject})`;

/**
 * The keyset predicate: "strictly after the cursor row in this ordering". A row
 * comparison rather than `(a > x) OR (a = x AND b > y)`, because Postgres can
 * answer the first from an index in one seek.
 */
const keysetFilter = (cursor: TicketCursor): SQL => {
  const { column, cast } = SORT_COLUMNS[cursor.sort];
  const row = sql`(${column}, ${tickets.id})`;
  // Cast both halves explicitly. The schema already types the value per sort,
  // and this is the second half of the same guarantee: an untyped parameter in
  // a row comparison is resolved by Postgres, and a future sort key added
  // without a matching schema branch would resolve to the wrong type rather
  // than failing here.
  const after = sql`(${cursor.value}${sql.raw(`::${cast}`)}, ${cursor.id}::uuid)`;

  return cursor.direction === 'desc' ? lt(row, after) : gt(row, after);
};

export interface TicketFilterInput extends Pick<TicketListQuery, 'sort' | 'direction'> {
  readonly filters: Omit<TicketListQuery, 'sort' | 'direction' | 'cursor' | 'limit'>;
  readonly cursor: string | undefined;
}

/** Every condition of one list read, or `undefined` when the reader asked for none. */
export const ticketFilters = ({
  filters,
  sort,
  direction,
  cursor,
}: TicketFilterInput): SQL | undefined => {
  const clauses: (SQL | undefined)[] = [];

  if (filters.statusId !== undefined && filters.statusId.length > 0) {
    clauses.push(inArray(tickets.statusId, [...filters.statusId]));
  }
  if (filters.systemState !== undefined && filters.systemState.length > 0) {
    // The join is already there for the embedded status, so this costs nothing
    // extra and saves the caller resolving four states into a list of ids.
    clauses.push(inArray(ticketStatuses.systemState, [...filters.systemState]));
  }
  if (filters.priority !== undefined && filters.priority.length > 0) {
    clauses.push(inArray(tickets.priority, [...filters.priority]));
  }
  if (filters.departmentId !== undefined && filters.departmentId.length > 0) {
    clauses.push(inArray(tickets.departmentId, [...filters.departmentId]));
  }
  if (filters.channel !== undefined && filters.channel.length > 0) {
    clauses.push(inArray(tickets.channel, [...filters.channel]));
  }
  if (filters.assigneeId !== undefined && filters.assigneeId.length > 0) {
    clauses.push(assigneeFilter(filters.assigneeId));
  }
  if (filters.q !== undefined) {
    clauses.push(searchFilter(filters.q));
  }
  if (cursor !== undefined) {
    clauses.push(keysetFilter(decodeTicketCursor(cursor, { sort, direction })));
  }

  const present = clauses.filter((clause): clause is SQL => clause !== undefined);
  return present.length === 0 ? undefined : and(...present);
};

/**
 * The ordering, always with `id` behind it. Without the tiebreaker two tickets
 * updated in the same millisecond have no defined order, and a cursor that
 * lands between them would drop one row or repeat it.
 */
export const ticketOrder = (sort: TicketSort, direction: TicketSortDirection): SQL[] => {
  const order = direction === 'desc' ? desc : asc;

  return [order(SORT_COLUMNS[sort].column), order(tickets.id)];
};

/** The cursor that asks for the row after `row`, given the ordering it was read under. */
export const cursorAfter = (
  row: { readonly id: string; readonly sortValue: string | number | Date },
  sort: TicketSort,
  direction: TicketSortDirection,
): string =>
  encodeTicketCursor({
    sort,
    direction,
    value: row.sortValue instanceof Date ? row.sortValue.toISOString() : row.sortValue,
    id: row.id,
  });

/** The column whose value goes into the next cursor, read off a returned row. */
export const sortValueOf = (
  row: {
    readonly updatedAt: Date;
    readonly createdAt: Date;
    readonly number: number;
    readonly priority: string;
  },
  sort: TicketSort,
): string | number | Date => {
  switch (sort) {
    case 'updatedAt':
      return row.updatedAt;
    case 'createdAt':
      return row.createdAt;
    case 'number':
      return row.number;
    case 'priority':
      return row.priority;
  }
};

/** The join every list and every read shares: a ticket carries its status inline. */
export const statusJoin = eq(ticketStatuses.id, tickets.statusId);
