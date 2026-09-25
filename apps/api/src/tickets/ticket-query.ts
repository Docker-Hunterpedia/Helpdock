import { contacts, ticketSearchTokens, ticketStatuses, tickets, ticketTags } from '@helpdock/db';
import type { TicketListQuery, TicketSort, TicketSortDirection } from '@helpdock/schemas';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import { decodeTicketCursor, encodeTicketCursor, type TicketCursor } from './cursor.js';

/**
 * The ticket list's `WHERE` and `ORDER BY`, built from the parsed query.
 *
 * Nothing here *isolates* by brand or by department. That is row-level
 * security's job and it is not repeated: a filter that also enforced isolation
 * would be a second place for isolation to be wrong, and the one that is
 * easiest to forget (DOMAIN-RULES §1.3). What this file decides is only what
 * the *reader asked for* within what they may already see — plus the one
 * `brand_id = …` that {@link ticketFilters} explains, which is there for the
 * planner and would change nothing about which rows come back if removed.
 *
 * Every value reaches SQL as a bound parameter. The search term in particular
 * goes to `to_tsvector` (through `helpdock_search_lexemes`), which reads any
 * text as words and never raises on nonsense.
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
 * How a search is answered (ADR 0011, M1-15 part 2). `exact` asks the token
 * table for tickets that carry every word; `fuzzy` also accepts a word that is
 * trigram-similar to one a ticket carries, and runs only when `exact` has
 * fewer than a page to show (see {@link fallsBackToFuzzy}).
 */
export type SearchMode = 'exact' | 'fuzzy';

// A string rather than a literal, for the scanner `REFERENCE` below describes.
// biome-ignore lint/complexity/useRegexLiterals: a literal stalls that scanner.
const WHITESPACE = new RegExp('\\s+');

/** A search as typed: the words it looks for, and the `-words` it excludes. */
export interface SearchTerms {
  readonly include: string;
  readonly exclude: string;
}

/**
 * Splits a search into the words it asks for and the words it rules out. A
 * word that starts with `-` is an exclusion, as it was when the search went to
 * `websearch_to_tsquery`; everything else is a word to find. Quotes are not
 * operators: the words of a quoted phrase are all required, in any order,
 * because the token table stores words, not their positions.
 */
export const parseSearch = (term: string): SearchTerms => {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const word of term.split(WHITESPACE)) {
    if (word.length > 1 && word.startsWith('-')) {
      exclude.push(word.slice(1));
    } else if (word !== '') {
      include.push(word);
    }
  }

  return { include: include.join(' '), exclude: exclude.join(' ') };
};

/** Trigram similarity means nothing below three characters, so neither does the fallback. */
const FUZZY_MIN_LENGTH = 3;

/**
 * Whether a page is read with the fuzzy half. It is decided on the **first**
 * page — the exact half found fewer than a page, and the words are long
 * enough to be similar to something — and a later page follows the flag its
 * cursor carries instead, so one search never changes halves between pages.
 */
export const fallsBackToFuzzy = ({
  q,
  cursor,
  found,
  limit,
}: {
  readonly q: string | undefined;
  readonly cursor: TicketCursor | undefined;
  readonly found: number;
  readonly limit: number;
}): boolean =>
  q !== undefined &&
  cursor === undefined &&
  found < limit &&
  [...parseSearch(q).include].length >= FUZZY_MIN_LENGTH;

/**
 * The lexemes of a text, by the one database function that also fills
 * `ticket_search_tokens`, so a query and the stored words are always built by
 * the same text-search configuration. It is IMMUTABLE, so Postgres folds it
 * into a constant array when it plans the statement.
 */
const lexemesOf = (text: string): SQL => sql`helpdock_search_lexemes(${text})`;

const tokens = alias(ticketSearchTokens, 'tokens');
const near = alias(ticketSearchTokens, 'near');
const byContact = alias(tickets, 'by_contact');
const byNumber = alias(tickets, 'by_number');
/** An alias in a `FROM`: the table's own name, then the alias. */
const TOKENS = sql`${ticketSearchTokens} AS ${tokens}`;
const NEAR = sql`${ticketSearchTokens} AS ${near}`;
const BY_CONTACT = sql`${tickets} AS ${byContact}`;
const BY_NUMBER = sql`${tickets} AS ${byNumber}`;
const PREFIX = sql.raw(String(FUZZY_MIN_LENGTH));

/**
 * Tickets that carry **every** word: one index lookup per word on
 * `ticket_search_tokens_brand_token_idx`, then `GROUP BY … HAVING count(*) = n`.
 * `=` on text is leakproof, so the lookup runs ahead of the department policy
 * and a word nobody used costs an index probe, not a read of every ticket.
 * `count(*)` is exact because the primary key makes a word unique per ticket.
 */
const exactTicketIds = (brandId: string, words: string): SQL => sql`
(
  SELECT ${tokens.ticketId} FROM ${TOKENS}
  WHERE ${tokens.brandId} = ${brandId} AND ${tokens.token} = ANY(${lexemesOf(words)})
  GROUP BY ${tokens.ticketId}
  HAVING count(*) = cardinality(${lexemesOf(words)})
)`;

/**
 * Tickets that carry, for every word, that word or one trigram-similar to it
 * (`<%`, word similarity, the operator the subject search used before M1-15
 * part 2). The candidates for each word are the tokens sharing its first three
 * characters, read as a range of the same index — `>=` and `<` on text are
 * leakproof too — so the similarity is computed on a handful of words rather
 * than on every visible ticket. A typo in the first three letters is the price
 * of that, and it is documented in the tickets guide.
 */
const fuzzyTicketIds = (brandId: string, words: string): SQL => sql`(
  SELECT ${tokens.ticketId} FROM ${TOKENS}
  JOIN (
    SELECT DISTINCT wanted.word, ${near.token} AS token
    FROM unnest(${lexemesOf(words)}) WITH ORDINALITY AS wanted(lexeme, word)
    JOIN ${NEAR} ON ${near.brandId} = ${brandId}
      AND ${near.token} >= left(wanted.lexeme, ${PREFIX})
      AND ${near.token} < left(wanted.lexeme, ${PREFIX}) || chr(1114111)
    WHERE ${near.token} = wanted.lexeme
      OR (char_length(wanted.lexeme) >= ${PREFIX} AND wanted.lexeme <% ${near.token})
  ) matched ON matched.token = ${tokens.token}
  WHERE ${tokens.brandId} = ${brandId}
  GROUP BY ${tokens.ticketId}
  HAVING count(DISTINCT matched.word) = cardinality(${lexemesOf(words)})
)`;

/**
 * The search: the words (exact, or fuzzy on the fallback), the contact's name
 * and a reference (M1-09: the merge dialog searches "by reference, subject or
 * contact"), each as a set of ticket ids that an index answers, joined by
 * `UNION ALL` rather than `OR`. An `OR` of subqueries is a filter Postgres
 * checks on every visible ticket; a union of index lookups is a short list of
 * ids, and an empty one when nothing matches.
 *
 * Every half reads a table under the same policies as `tickets` (`contacts` is
 * brand-scoped, the other two department-scoped like `tickets`), so each can
 * only narrow what the reader already sees. The `brand_id = …` equalities are
 * for the planner, as in {@link ticketFilters}.
 */
const searchFilter = (brandId: string, term: string, mode: SearchMode): SQL => {
  const { include, exclude } = parseSearch(term);
  const matches = [
    mode === 'fuzzy' ? fuzzyTicketIds(brandId, include) : exactTicketIds(brandId, include),
    sql`(SELECT ${byContact.id} FROM ${BY_CONTACT}
      WHERE ${byContact.brandId} = ${brandId} AND ${byContact.contactId} IN (
        SELECT ${contacts.id} FROM ${contacts}
        WHERE ${contacts.brandId} = ${brandId} AND ${contacts.name} ILIKE ${`%${escapeLike(term)}%`}
      ))`,
  ];

  const number = referenceNumber(term);
  if (number !== null) {
    matches.push(
      sql`(SELECT ${byNumber.id} FROM ${BY_NUMBER}
        WHERE ${byNumber.brandId} = ${brandId} AND ${byNumber.number} = ${number})`,
    );
  }

  const found = sql`${tickets.id} IN (${sql.join(matches, sql` UNION ALL `)})`;
  if (exclude === '') {
    return found;
  }

  // `-word`: the ticket carries none of the excluded words.
  return sql`(${found} AND ${tickets.id} NOT IN (
    SELECT ${tokens.ticketId} FROM ${TOKENS}
    WHERE ${tokens.brandId} = ${brandId} AND ${tokens.token} = ANY(${lexemesOf(exclude)})
  ))`;
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
  /** The brand in the path, which the guard has already matched to the transaction. */
  readonly brandId: string;
  readonly filters: Omit<TicketListQuery, 'sort' | 'direction' | 'cursor' | 'limit'>;
  readonly cursor: string | undefined;
  /** Which half of the search answers `q`; `exact` unless the list fell back. */
  readonly search?: SearchMode;
}

/** Every condition of one list read, or `undefined` when the reader asked for none. */
export const ticketFilters = ({
  brandId,
  filters,
  sort,
  direction,
  cursor,
  search = 'exact',
}: TicketFilterInput): SQL | undefined => {
  const clauses: (SQL | undefined)[] = [
    // Not isolation — the policy's `brand_id = ANY(app.brand_ids)` already
    // decides that, and this cannot widen it. It is what lets the planner read
    // `tickets_brand_updated_idx` *in order* and stop after one page: against
    // an array it cannot know that one brand is involved, so it has to fetch
    // every visible ticket and sort them, which at 50k tickets is the whole
    // latency budget (M1-15, docs/guides/tickets.md "Performance").
    eq(tickets.brandId, brandId),
    // DOMAIN-RULES §2.2: a soft-deleted ticket is "hidden from all views". It
    // is unconditional rather than a filter the caller may ask for, because
    // "all views" includes the ones added after this line was written.
    isNull(tickets.deletedAt),
  ];

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
    clauses.push(searchFilter(brandId, filters.q, search));
  }
  if (cursor !== undefined) {
    clauses.push(keysetFilter(decodeTicketCursor(cursor, { sort, direction })));
  }

  return and(...clauses.filter((clause): clause is SQL => clause !== undefined));
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

/**
 * The cursor that asks for the row after `row`, given the ordering it was read
 * under, and the search half it was read with.
 */
export const cursorAfter = (
  row: { readonly id: string; readonly sortValue: string | number | Date },
  sort: TicketSort,
  direction: TicketSortDirection,
  search: SearchMode = 'exact',
): string =>
  encodeTicketCursor({
    sort,
    direction,
    value: row.sortValue instanceof Date ? row.sortValue.toISOString() : row.sortValue,
    id: row.id,
    ...(search === 'fuzzy' ? { fuzzy: true } : {}),
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
