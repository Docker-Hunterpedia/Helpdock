import { contacts, ticketStatuses, tickets, ticketTags } from '@helpdock/db';
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
 * Tags, with **all-of** semantics (M1-06): the ticket has to carry every tag
 * named. Two chips in a filter are how somebody narrows a queue, and "any"
 * would widen it — the reading that is wrong in the direction that shows rows
 * the reader asked to exclude.
 *
 * `GROUP BY … HAVING count(DISTINCT tag_id) = n` rather than one `EXISTS` per
 * tag: it is one index scan of `ticket_tags_brand_tag_idx` however many tags
 * are named, and the `DISTINCT` makes it immune to a caller repeating one.
 *
 * The subquery reads `ticket_tags`, which is department-scoped like `tickets`,
 * so it narrows what the reader may already see and can never widen it.
 */
const tagFilter = (tagIds: readonly string[]): SQL => {
  const wanted = [...new Set(tagIds)];

  return sql`${tickets.id} IN (
    SELECT ${ticketTags.ticketId} FROM ${ticketTags}
    WHERE ${inArray(ticketTags.tagId, wanted)}
    GROUP BY ${ticketTags.ticketId}
    HAVING count(DISTINCT ${ticketTags.tagId}) = ${wanted.length}
  )`;
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
const searchFilter = (term: string): SQL => {
  const clauses = [
    sql`${tickets.search} @@ websearch_to_tsquery('english', ${term})`,
    sql`${term} <% ${tickets.subject}`,
    // M1-09: the merge dialog searches "by reference, subject or contact". The
    // contact half reads `contacts`, which is brand-scoped, so it can only
    // narrow what the reader already sees.
    sql`${tickets.contactId} IN (SELECT ${contacts.id} FROM ${contacts} WHERE ${contacts.name} ILIKE ${`%${escapeLike(term)}%`})`,
  ];

  const number = referenceNumber(term);
  if (number !== null) {
    clauses.push(sql`${tickets.number} = ${number}`);
  }

  return sql`(${sql.join(clauses, sql` OR `)})`;
};

/**
 * The number in a ticket reference as an agent types one — `HD-1042`,
 * `hd-1042`, `#1042` or `1042` — or `null` when the term is not one. The
 * prefix is not compared: a brand has one sequence, so the number alone is the
 * ticket, and a prefix that was renamed since is still the same ticket.
 */
// A string rather than a regular-expression literal: `pnpm check:routes` scans
// this file with the compiler's scanner, which reads a bare `/` as division.
// biome-ignore lint/complexity/useRegexLiterals: a literal stalls that scanner, as above.
const REFERENCE = new RegExp('^(?:[A-Za-z][A-Za-z0-9]{0,9}-|#)?(\\d{1,15})$');

export const referenceNumber = (term: string): number | null => {
  const match = REFERENCE.exec(term.trim());
  if (match?.[1] === undefined) {
    return null;
  }

  const value = Number(match[1]);

  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

/** `%` and `_` are wildcards to ILIKE; a name that contains one means the character. */
const escapeLike = (term: string): string =>
  term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

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
  // DOMAIN-RULES §2.2: a soft-deleted ticket is "hidden from all views". It is
  // first and unconditional rather than a filter the caller may ask for,
  // because "all views" includes the ones added after this line was written.
  const clauses: (SQL | undefined)[] = [isNull(tickets.deletedAt)];

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
  // One filter, two spellings: `tagId=a&tagId=b` and `tagIds=a&tagIds=b` are
  // the same question, so naming both is naming their union.
  const tagIds = [...(filters.tagId ?? []), ...(filters.tagIds ?? [])];
  if (tagIds.length > 0) {
    clauses.push(tagFilter(tagIds));
  }
  if (filters.q !== undefined) {
    clauses.push(searchFilter(filters.q));
  }
  if (cursor !== undefined) {
    clauses.push(keysetFilter(decodeTicketCursor(cursor, { sort, direction })));
  }

  const present = clauses.filter((clause): clause is SQL => clause !== undefined);
  /* c8 ignore next -- the soft-delete clause above is unconditional, so this is never empty. */
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
