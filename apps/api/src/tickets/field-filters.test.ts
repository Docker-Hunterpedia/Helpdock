import type { CustomFieldType, TicketFieldFilter } from '@helpdock/schemas';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  FieldFilterFailure,
  type FilterableField,
  fieldFilterClause,
  resolveFieldFilters,
} from './field-filters.js';
import { ticketFilters } from './ticket-query.js';

const dialect = new PgDialect();
const render = (sql: SQL) => dialect.sqlToQuery(sql);

const field = (key: string, type: CustomFieldType, agentVisible = true): FilterableField => ({
  key,
  type,
  agentVisible,
});

const FIELDS: FilterableField[] = [
  field('severity', 'select'),
  field('regions', 'multi_select'),
  field('vip', 'checkbox'),
  field('order_total', 'number'),
  field('renewal', 'date'),
  field('note', 'text'),
  field('details', 'long_text'),
  field('status_page', 'link'),
  field('billing_email', 'email'),
  field('owner', 'person'),
  field('internal_score', 'number', false),
];

const resolve = (filter: TicketFieldFilter, seesHidden = false) =>
  resolveFieldFilters([filter], FIELDS, { seesHidden });

describe('resolveFieldFilters', () => {
  it('reads the type from the definition, not from the request', () => {
    expect(resolve({ key: 'severity', op: 'any_of', values: ['Sev 1'] })[0]?.type).toBe('select');
    expect(resolve({ key: 'order_total', op: 'before', value: 10 })[0]?.type).toBe('number');
  });

  it('is empty when there is nothing to resolve', () => {
    expect(resolveFieldFilters(undefined, FIELDS, { seesHidden: false })).toEqual([]);
  });

  it('refuses a key no ticket field has, the way a typo should fail', () => {
    expect(() => resolve({ key: 'severty', op: 'not_set' })).toThrow(FieldFilterFailure);
    expect(() => resolve({ key: 'severty', op: 'not_set' })).toThrow('no such ticket field');
  });

  it.each<[string, TicketFieldFilter]>([
    ['contains on a select', { key: 'severity', op: 'contains', value: 'x' }],
    ['any_of on a number', { key: 'order_total', op: 'any_of', values: ['1'] }],
    ['is on a text', { key: 'note', op: 'is', value: true }],
    ['before on a checkbox', { key: 'vip', op: 'before', value: 1 }],
  ])('refuses an operator the type has no use for: %s', (_name, filter) => {
    expect(() => resolve(filter)).toThrow(FieldFilterFailure);
  });

  it.each<[string, TicketFieldFilter]>([
    ['contains on a long text', { key: 'details', op: 'contains', value: 'x' }],
    ['contains on a link', { key: 'status_page', op: 'contains', value: 'x' }],
    ['contains on an email', { key: 'billing_email', op: 'contains', value: 'x' }],
    [
      'any_of on a person',
      { key: 'owner', op: 'any_of', values: ['0192c3f0-1a2b-7c3d-8e4f-00000000000a'] },
    ],
    ['not_set on every new type', { key: 'owner', op: 'not_set' }],
  ])('accepts what the M14-27 types answer: %s', (_name, filter) => {
    expect(resolve(filter)).toHaveLength(1);
  });

  it.each<[string, TicketFieldFilter]>([
    ['contains on a person', { key: 'owner', op: 'contains', value: 'x' }],
    ['any_of on an email', { key: 'billing_email', op: 'any_of', values: ['a@b.co'] }],
    ['is on a link', { key: 'status_page', op: 'is', value: true }],
    ['before on a long text', { key: 'details', op: 'before', value: 1 }],
  ])('refuses what they have no use for: %s', (_name, filter) => {
    expect(() => resolve(filter)).toThrow(FieldFilterFailure);
  });

  it('refuses a number compared with a day and a day compared with a number', () => {
    expect(() => resolve({ key: 'order_total', op: 'after', value: '2026-01-01' })).toThrow(
      'its own kind',
    );
    expect(() => resolve({ key: 'renewal', op: 'before', value: 5 })).toThrow('its own kind');
    expect(() =>
      resolve({ key: 'renewal', op: 'between', from: '2026-01-01', to: '2026-02-01' }),
    ).not.toThrow();
  });

  it('refuses a field an Agent may not see unless the reader manages ticketing', () => {
    const filter: TicketFieldFilter = { key: 'internal_score', op: 'after', value: 3 };

    expect(() => resolve(filter)).toThrow('no such ticket field');
    expect(resolve(filter, true)).toHaveLength(1);
  });

  it('refuses a field filtered twice', () => {
    expect(() =>
      resolveFieldFilters(
        [
          { key: 'severity', op: 'any_of', values: ['Sev 1'] },
          { key: 'severity', op: 'not_set' },
        ],
        FIELDS,
        { seesHidden: false },
      ),
    ).toThrow('filtered twice');
  });
});

describe('fieldFilterClause', () => {
  const clause = (filter: TicketFieldFilter) => {
    const [resolved] = resolve(filter);
    if (resolved === undefined) {
      throw new Error('the filter did not resolve');
    }

    return render(fieldFilterClause(resolved));
  };

  it('asks a select by containment and binds both the key and the value', () => {
    const sql = clause({ key: 'severity', op: 'any_of', values: ['Sev 1', 'Sev 2'] });

    expect(sql.sql).toBe('("tickets"."custom" @> $1::jsonb OR "tickets"."custom" @> $2::jsonb)');
    expect(sql.params).toEqual(['{"severity":"Sev 1"}', '{"severity":"Sev 2"}']);
  });

  it('asks a person by containment of the id, as a select is asked', () => {
    const [resolved] = resolve({ key: 'owner', op: 'any_of', values: ['u-1'] });
    const query = render(fieldFilterClause(resolved as never));

    expect(query.sql).toContain('@>');
    expect(query.params).toContain(JSON.stringify({ owner: 'u-1' }));
  });

  it('searches a link, an email and a long text as text', () => {
    for (const key of ['status_page', 'billing_email', 'details']) {
      const [resolved] = resolve({ key, op: 'contains', value: 'a_b' });
      const query = render(fieldFilterClause(resolved as never));

      expect(query.sql).toContain('ILIKE');
      expect(query.params).toContain('%a\\_b%');
    }
  });

  it('asks a multi-select for the member inside the stored array', () => {
    expect(clause({ key: 'regions', op: 'any_of', values: ['EU'] }).params).toEqual([
      '{"regions":["EU"]}',
    ]);
  });

  it('keeps a hostile value in a parameter', () => {
    const hostile = `x"}' OR 1=1 --`;
    const sql = clause({ key: 'severity', op: 'any_of', values: [hostile] });

    expect(sql.sql).not.toContain('OR 1=1');
    expect(sql.params).toEqual([JSON.stringify({ severity: hostile })]);
  });

  it('reads "not set" as the key being absent, which is how a cleared field is stored', () => {
    const sql = clause({ key: 'note', op: 'not_set' });

    expect(sql.sql).toBe('NOT jsonb_exists("tickets"."custom", $1)');
    expect(sql.params).toEqual(['note']);
  });

  it('reads an untouched checkbox as unticked', () => {
    expect(clause({ key: 'vip', op: 'is', value: true }).sql).toBe(
      '"tickets"."custom" @> $1::jsonb',
    );
    expect(clause({ key: 'vip', op: 'is', value: false }).sql).toBe(
      'NOT ("tickets"."custom" @> $1::jsonb)',
    );
  });

  it('compares a number only when the stored value is one', () => {
    const sql = clause({ key: 'order_total', op: 'between', from: 10, to: 20 });

    expect(sql.sql).toContain('jsonb_typeof("tickets"."custom" -> $1::text) = \'number\'');
    expect(sql.sql).toContain('::numeric BETWEEN $3 AND $4');
    expect(sql.params).toEqual(['order_total', 'order_total', 10, 20]);
  });

  it('compares a day as text under the C collation, only when the stored value is text', () => {
    const sql = clause({ key: 'renewal', op: 'before', value: '2026-03-01' });

    expect(sql.sql).toContain("= 'string'");
    expect(sql.sql).toContain('COLLATE "C" < $3');
  });

  it('escapes the wildcards of a text search', () => {
    const sql = clause({ key: 'note', op: 'contains', value: '50%_off' });

    expect(sql.params).toContain('%50\\%\\_off%');
  });
});

describe('ticketFilters with field filters', () => {
  const base = {
    brandId: 'brand',
    viewerId: 'viewer',
    sort: 'updatedAt' as const,
    direction: 'desc' as const,
    cursor: undefined,
  };

  it('adds the resolved clauses, all of which have to match', () => {
    const fieldFilters = resolveFieldFilters(
      [
        { key: 'severity', op: 'any_of', values: ['Sev 1'] },
        { key: 'vip', op: 'is', value: true },
      ],
      FIELDS,
      { seesHidden: false },
    );
    const sql = dialect.sqlToQuery(
      ticketFilters({
        ...base,
        filters: { fieldFilter: fieldFilters.map(({ filter }) => filter) },
        fieldFilters,
      }) as SQL,
    );

    expect(sql.sql.match(/"tickets"\."custom" @>/g)).toHaveLength(2);
  });

  it('refuses to compile a query whose field filters were never resolved', () => {
    expect(() =>
      ticketFilters({
        ...base,
        filters: { fieldFilter: [{ key: 'severity', op: 'not_set' }] },
      }),
    ).toThrow('resolved against the brand');
  });
});
