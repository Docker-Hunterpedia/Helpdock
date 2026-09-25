import type { TicketListQuery } from '@helpdock/schemas';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { encodeTicketCursor } from './cursor.js';
import {
  cursorAfter,
  fallsBackToFuzzy,
  parseSearch,
  referenceNumber,
  sortValueOf,
  ticketFilters,
  ticketOrder,
} from './ticket-query.js';

/**
 * The filters are assertions about *SQL*, so the SQL is what is asserted on:
 * rendering it through Drizzle's own dialect is the only way to see whether a
 * value was bound or pasted, which is the property that matters most here.
 */
const dialect = new PgDialect();

const render = (sql: SQL | undefined) => (sql === undefined ? undefined : dialect.sqlToQuery(sql));

const STATUS = '01937f5e-7e53-7000-8000-000000000021';
const DEPARTMENT = '01937f5e-7e53-7000-8000-000000000011';
const AGENT = '01937f5e-7e53-7000-8000-000000000001';
const TICKET = '01937f5e-7e53-7000-8000-0000000000a1';
const BRAND = '01937f5e-7e53-7000-8000-0000000000c1';

const query = (filters: Partial<TicketListQuery> = {}) => ({
  brandId: BRAND,
  filters: filters as TicketFilters,
  sort: filters.sort ?? ('updatedAt' as const),
  direction: filters.direction ?? ('desc' as const),
  cursor: filters.cursor,
});

type TicketFilters = Omit<TicketListQuery, 'sort' | 'direction' | 'cursor' | 'limit'>;

describe('ticketFilters', () => {
  it('asks only for the brand and a live ticket when nothing was asked for', () => {
    // Isolation is the policies' job, so "no filters" adds no department
    // predicate. The brand equality is not isolation either — the policy
    // already decides the brand — it is what lets the planner read
    // `tickets_brand_updated_idx` in order (M1-15). The soft-delete clause is
    // DOMAIN-RULES §2.2's "hidden from all views", which no caller may turn off.
    const sql = render(ticketFilters(query()));

    expect(sql?.sql).toBe('("tickets"."brand_id" = $1 and "tickets"."deleted_at" is null)');
    expect(sql?.params).toEqual([BRAND]);
  });

  it('keeps the soft-delete clause alongside whatever was asked for', () => {
    expect(render(ticketFilters(query({ statusId: [STATUS] })))?.sql).toContain(
      '"tickets"."deleted_at" is null',
    );
  });

  it('filters by status', () => {
    const sql = render(ticketFilters(query({ statusId: [STATUS] })));

    expect(sql?.sql).toContain('"status_id" in');
    expect(sql?.params).toContain(STATUS);
  });

  it('filters by system state through the joined status', () => {
    const sql = render(ticketFilters(query({ systemState: ['open', 'escalated'] })));

    expect(sql?.sql).toContain('"ticket_statuses"."system_state" in');
    expect(sql?.params).toEqual([BRAND, 'open', 'escalated']);
  });

  it('turns the unassigned chip into IS NULL beside the named people', () => {
    const sql = render(ticketFilters(query({ assigneeId: [AGENT, 'unassigned'] })));

    expect(sql?.sql).toContain('is null');
    expect(sql?.params).toContain(AGENT);
    // "unassigned" is a chip, not a person: it must never be compared to a uuid.
    expect(sql?.params).not.toContain('unassigned');
  });

  it('asks only for IS NULL when unassigned is the only chip', () => {
    const sql = render(ticketFilters(query({ assigneeId: ['unassigned'] })));

    expect(sql?.sql).toContain('is null');
    expect(sql?.params).toEqual([BRAND]);
  });

  describe('tags (M1-06)', () => {
    const REFUND = '01937f5e-7e53-7000-8000-0000000000b1';
    const VIP = '01937f5e-7e53-7000-8000-0000000000b2';

    it('asks for tickets carrying every tag named, not any of them', () => {
      const sql = render(ticketFilters(query({ tagId: [REFUND, VIP] })));

      // All-of: two chips in a filter are how somebody narrows a queue.
      expect(sql?.sql).toContain('count(DISTINCT');
      expect(sql?.sql).toContain('HAVING');
      expect(sql?.params).toEqual([BRAND, REFUND, VIP, 2]);
    });

    it('reads tagIds as the same filter, so naming both is naming their union', () => {
      const sql = render(ticketFilters(query({ tagId: [REFUND], tagIds: [VIP] })));

      expect(sql?.params).toEqual([BRAND, REFUND, VIP, 2]);
    });

    it('counts a repeated id once, so a duplicate cannot make the filter impossible', () => {
      const sql = render(ticketFilters(query({ tagId: [REFUND], tagIds: [REFUND] })));

      expect(sql?.params).toEqual([BRAND, REFUND, 1]);
    });

    it('binds the ids rather than pasting them', () => {
      const sql = render(ticketFilters(query({ tagId: [REFUND] })));

      expect(sql?.sql).not.toContain(REFUND);
    });

    it('adds nothing when the list is empty', () => {
      // Only the brand and M1-08's soft-delete clause are left: the "no filters" shape.
      expect(render(ticketFilters(query({ tagId: [] })))?.sql).toBe(
        render(ticketFilters(query()))?.sql,
      );
    });
  });

  it('combines several filters', () => {
    const sql = render(
      ticketFilters(
        query({ priority: ['urgent'], departmentId: [DEPARTMENT], channel: ['email'] }),
      ),
    );

    expect(sql?.params).toEqual(expect.arrayContaining(['urgent', DEPARTMENT, 'email']));
    expect(sql?.sql).toContain(' and ');
  });

  describe('search (ADR 0011)', () => {
    it('asks the token table for tickets carrying every word, and binds the term', () => {
      const sql = render(ticketFilters(query({ q: 'refund order' })));

      expect(sql?.sql).toContain('"ticket_search_tokens" AS "tokens"');
      // The lexemes come from the same database function that fills the table.
      expect(sql?.sql).toContain('"tokens"."token" = ANY(helpdock_search_lexemes(');
      // All-of: a ticket must carry as many of the words as the query has.
      expect(sql?.sql).toContain('HAVING count(*) = cardinality(helpdock_search_lexemes(');
      expect(sql?.params).toContain('refund order');
    });

    it('leaves trigram similarity out of the exact half', () => {
      // `<%` is not leakproof, so wherever it appears it is evaluated after the
      // policy; the exact half must be answerable from the index alone.
      const sql = render(ticketFilters(query({ q: 'refund' })));

      expect(sql?.sql).not.toContain('<%');
      expect(sql?.sql).not.toContain('websearch_to_tsquery');
    });

    it('widens each word to the similar ones sharing its first three letters on the fallback', () => {
      const sql = render(ticketFilters({ ...query({ q: 'renewa' }), search: 'fuzzy' }));

      // `<%`, not `%`: the query word against one stored word, as before.
      expect(sql?.sql).toContain('wanted.lexeme <% "near"."token"');
      // The candidates are an index range, not every visible ticket.
      expect(sql?.sql).toContain('"near"."token" >= left(wanted.lexeme, 3)');
      expect(sql?.sql).toContain('"near"."token" < left(wanted.lexeme, 3) || chr(1114111)');
      expect(sql?.sql).toContain('count(DISTINCT matched.word)');
      expect(sql?.params).toContain('renewa');
    });

    it('joins the halves as a union of ticket ids, not an OR checked on every ticket', () => {
      const sql = render(ticketFilters(query({ q: 'HD-1042' })));

      expect(sql?.sql).toContain('"tickets"."id" IN (');
      expect(sql?.sql.match(/UNION ALL/g)).toHaveLength(2);
    });

    it('rules out the tickets carrying a -word', () => {
      const sql = render(ticketFilters(query({ q: 'refund -spam' })));

      expect(sql?.sql).toContain('"tickets"."id" NOT IN (');
      expect(sql?.params).toEqual(expect.arrayContaining(['refund', 'spam']));
      expect(sql?.params).not.toContain('refund -spam');
    });

    it('adds no exclusion when nothing is excluded', () => {
      expect(render(ticketFilters(query({ q: 'refund' })))?.sql).not.toContain('NOT IN');
    });

    it('names the brand of the path in every half, for the planner', () => {
      const sql = render(ticketFilters(query({ q: 'HD-1042' })));

      expect(sql?.params?.filter((param) => param === BRAND)).toHaveLength(5);
    });
  });

  it('also matches the contact by name, with the wildcards of a name escaped (M1-09)', () => {
    const sql = render(ticketFilters(query({ q: '50%_off' })));

    expect(sql?.sql).toContain('ILIKE');
    expect(sql?.params).toContain('%50\\%\\_off%');
  });

  it('matches a reference by its number, whatever prefix it is typed with (M1-09)', () => {
    const sql = render(ticketFilters(query({ q: 'HD-1042' })));

    expect(sql?.sql).toContain('"by_number"."number" = ');
    expect(sql?.params).toContain(1042);
  });

  it('does not treat a word as a reference', () => {
    const sql = render(ticketFilters(query({ q: 'refund' })));

    expect(sql?.sql).not.toContain('"by_number"."number" = ');
  });

  it('never pastes a search term into the statement, however hostile', () => {
    const hostile = "'); drop table tickets; --";
    for (const search of ['exact', 'fuzzy'] as const) {
      const sql = render(ticketFilters({ ...query({ q: hostile }), search }));

      expect(sql?.sql).not.toContain('drop table');
      expect(sql?.params).toContain(`%${hostile}%`);
    }
  });

  it('turns a cursor into a row comparison in the sort direction', () => {
    const cursor = encodeTicketCursor({
      sort: 'updatedAt',
      direction: 'desc',
      value: '2026-09-19T10:00:00.000Z',
      id: TICKET,
    });
    const sql = render(ticketFilters({ ...query(), cursor }));

    expect(sql?.sql).toContain('<');
    expect(sql?.params).toEqual([BRAND, '2026-09-19T10:00:00.000Z', TICKET]);
  });

  it('compares the other way for an ascending sort', () => {
    const cursor = encodeTicketCursor({
      sort: 'number',
      direction: 'asc',
      value: 7,
      id: TICKET,
    });
    const sql = render(
      ticketFilters({
        brandId: BRAND,
        filters: {} as TicketFilters,
        sort: 'number',
        direction: 'asc',
        cursor,
      }),
    );

    expect(sql?.sql).toContain('>');
    expect(sql?.params).toEqual([BRAND, 7, TICKET]);
  });

  it('refuses a cursor from another ordering rather than returning the wrong page', () => {
    const cursor = encodeTicketCursor({
      sort: 'number',
      direction: 'asc',
      value: 7,
      id: TICKET,
    });

    expect(() => ticketFilters({ ...query(), cursor })).toThrow(/different sort order/);
  });
});

describe('ticketOrder', () => {
  it('always breaks a tie on the id', () => {
    // Two tickets updated in the same millisecond have no order without it, and
    // a cursor landing between them would drop a row or repeat one.
    const [primary, tiebreak] = ticketOrder('updatedAt', 'desc');

    expect(dialect.sqlToQuery(primary as SQL).sql).toContain('"updated_at" desc');
    expect(dialect.sqlToQuery(tiebreak as SQL).sql).toContain('"id" desc');
  });

  it('orders ascending when asked to', () => {
    const [primary] = ticketOrder('number', 'asc');

    expect(dialect.sqlToQuery(primary as SQL).sql).toContain('"number" asc');
  });
});

describe('the next cursor', () => {
  const row = {
    id: TICKET,
    updatedAt: new Date('2026-09-19T10:00:00.000Z'),
    createdAt: new Date('2026-09-18T09:00:00.000Z'),
    number: 1042,
    priority: 'high',
  };

  it.each([
    ['updatedAt', '2026-09-19T10:00:00.000Z'],
    ['createdAt', '2026-09-18T09:00:00.000Z'],
    ['number', 1042],
    ['priority', 'high'],
  ] as const)('carries the %s of the last row', (sort, expected) => {
    const cursor = cursorAfter({ id: row.id, sortValue: sortValueOf(row, sort) }, sort, 'desc');

    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      s: sort,
      d: 'desc',
      v: expected,
      id: TICKET,
    });
  });

  it('carries a fuzzy fallback to the next page, so one search never changes halves', () => {
    const decode = (cursor: string) =>
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const next = { id: row.id, sortValue: row.updatedAt };

    expect(decode(cursorAfter(next, 'updatedAt', 'desc', 'fuzzy')).f).toBe(true);
    expect(decode(cursorAfter(next, 'updatedAt', 'desc', 'exact'))).not.toHaveProperty('f');
  });
});

describe('referenceNumber', () => {
  it.each([
    ['HD-1042', 1042],
    ['hd-1042', 1042],
    ['#1042', 1042],
    ['1042', 1042],
    [' ACME2-7 ', 7],
  ])('reads %s as ticket %d', (term, expected) => {
    expect(referenceNumber(term)).toBe(expected);
  });

  it.each(['refund', 'HD-', 'HD 1042', '0', '1042abc', '99999999999999999'])(
    'reads %s as no reference',
    (term) => {
      expect(referenceNumber(term)).toBeNull();
    },
  );
});

describe('parseSearch', () => {
  it('splits the words to find from the -words to rule out', () => {
    expect(parseSearch('refund  -spam order -test')).toEqual({
      include: 'refund order',
      exclude: 'spam test',
    });
  });

  it('reads a lone dash, or a dash inside a word, as part of the words to find', () => {
    expect(parseSearch('e-mail - bounce')).toEqual({ include: 'e-mail - bounce', exclude: '' });
  });

  it('keeps Arabic words as they were typed', () => {
    expect(parseSearch('استرداد -تجربة')).toEqual({ include: 'استرداد', exclude: 'تجربة' });
  });
});

describe('fallsBackToFuzzy', () => {
  const firstPage = { q: 'renewa', cursor: undefined, found: 0, limit: 25 };

  it('falls back on a first page the exact half could not fill', () => {
    expect(fallsBackToFuzzy(firstPage)).toBe(true);
    expect(fallsBackToFuzzy({ ...firstPage, found: 24 })).toBe(true);
  });

  it('does not fall back once the exact half has a page', () => {
    expect(fallsBackToFuzzy({ ...firstPage, found: 25 })).toBe(false);
  });

  it('does not fall back for fewer than three characters to compare', () => {
    expect(fallsBackToFuzzy({ ...firstPage, q: 'ab' })).toBe(false);
    // Counted in characters, not bytes: three Arabic letters are enough.
    expect(fallsBackToFuzzy({ ...firstPage, q: 'شحن' })).toBe(true);
    // An excluded word is not a word to compare.
    expect(fallsBackToFuzzy({ ...firstPage, q: 'ab -refund' })).toBe(false);
  });

  it('leaves a later page to the flag its cursor carries', () => {
    const cursor = { sort: 'updatedAt', direction: 'desc', value: 'x', id: TICKET } as const;

    expect(fallsBackToFuzzy({ ...firstPage, cursor })).toBe(false);
  });

  it('has nothing to fall back from without a search', () => {
    expect(fallsBackToFuzzy({ ...firstPage, q: undefined })).toBe(false);
  });
});
