import type { TicketListQuery } from '@helpdock/schemas';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { encodeTicketCursor } from './cursor.js';
import {
  cursorAfter,
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

  it('searches full text and word-similar trigrams, and binds the term', () => {
    const sql = render(ticketFilters(query({ q: 'refund' })));

    expect(sql?.sql).toContain('websearch_to_tsquery');
    // `<%`, not `%`: the query is one word against a whole subject line.
    expect(sql?.sql).toContain('<%');
    expect(sql?.params).toEqual([BRAND, 'refund', 'refund', '%refund%']);
  });

  it('also matches the contact by name, with the wildcards of a name escaped (M1-09)', () => {
    const sql = render(ticketFilters(query({ q: '50%_off' })));

    expect(sql?.sql).toContain('ILIKE');
    expect(sql?.params).toContain('%50\\%\\_off%');
  });

  it('matches a reference by its number, whatever prefix it is typed with (M1-09)', () => {
    const sql = render(ticketFilters(query({ q: 'HD-1042' })));

    expect(sql?.sql).toContain('"tickets"."number" = ');
    expect(sql?.params).toContain(1042);
  });

  it('does not treat a word as a reference', () => {
    const sql = render(ticketFilters(query({ q: 'refund' })));

    expect(sql?.sql).not.toContain('"tickets"."number" = ');
  });

  it('never pastes a search term into the statement, however hostile', () => {
    // `websearch_to_tsquery` also never raises on nonsense, which is why it is
    // used rather than `to_tsquery`.
    const hostile = "'); drop table tickets; --";
    const sql = render(ticketFilters(query({ q: hostile })));

    expect(sql?.sql).not.toContain('drop table');
    expect(sql?.params).toEqual([BRAND, hostile, hostile, `%${hostile}%`]);
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
