import type { TicketListQuery } from '@helpdock/schemas';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { encodeTicketCursor } from './cursor.js';
import { cursorAfter, sortValueOf, ticketFilters, ticketOrder } from './ticket-query.js';

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

const query = (filters: Partial<TicketListQuery> = {}) => ({
  filters: filters as TicketFilters,
  sort: filters.sort ?? ('updatedAt' as const),
  direction: filters.direction ?? ('desc' as const),
  cursor: filters.cursor,
});

type TicketFilters = Omit<TicketListQuery, 'sort' | 'direction' | 'cursor' | 'limit'>;

describe('ticketFilters', () => {
  it('asks for nothing when nothing was asked for', () => {
    // Isolation is the policies' job, so "no filters" really is no WHERE at
    // all — the transaction already narrows the rows.
    expect(render(ticketFilters(query()))).toBeUndefined();
  });

  it('filters by status', () => {
    const sql = render(ticketFilters(query({ statusId: [STATUS] })));

    expect(sql?.sql).toContain('"status_id" in');
    expect(sql?.params).toContain(STATUS);
  });

  it('filters by system state through the joined status', () => {
    const sql = render(ticketFilters(query({ systemState: ['open', 'escalated'] })));

    expect(sql?.sql).toContain('"ticket_statuses"."system_state" in');
    expect(sql?.params).toEqual(['open', 'escalated']);
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
    expect(sql?.params).toEqual([]);
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
    expect(sql?.params).toEqual(['refund', 'refund']);
  });

  it('never pastes a search term into the statement, however hostile', () => {
    // `websearch_to_tsquery` also never raises on nonsense, which is why it is
    // used rather than `to_tsquery`.
    const hostile = "'); drop table tickets; --";
    const sql = render(ticketFilters(query({ q: hostile })));

    expect(sql?.sql).not.toContain('drop table');
    expect(sql?.params).toEqual([hostile, hostile]);
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
    expect(sql?.params).toEqual(['2026-09-19T10:00:00.000Z', TICKET]);
  });

  it('compares the other way for an ascending sort', () => {
    const cursor = encodeTicketCursor({
      sort: 'number',
      direction: 'asc',
      value: 7,
      id: TICKET,
    });
    const sql = render(
      ticketFilters({ filters: {} as TicketFilters, sort: 'number', direction: 'asc', cursor }),
    );

    expect(sql?.sql).toContain('>');
    expect(sql?.params).toEqual([7, TICKET]);
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
