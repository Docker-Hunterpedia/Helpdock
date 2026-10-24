import { describe, expect, it } from 'vitest';
import { ticketListQuerySchema } from './ticket.js';
import { FIELD_FILTERS_MAX, ticketFieldFilterSchema } from './ticket-field-filter.js';
import { ticketViewFiltersSchema } from './views.js';

describe('ticketFieldFilterSchema', () => {
  it.each([
    { key: 'severity', op: 'any_of', values: ['Sev 1', 'Sev 2'] },
    { key: 'severity', op: 'not_set' },
    { key: 'vip', op: 'is', value: false },
    { key: 'total', op: 'before', value: 10 },
    { key: 'renewal', op: 'after', value: '2026-03-01' },
    { key: 'total', op: 'between', from: 1, to: 9 },
    { key: 'renewal', op: 'between', from: '2026-01-01', to: '2026-12-31' },
    { key: 'note', op: 'contains', value: 'stripe' },
  ])('accepts $op', (filter) => {
    expect(ticketFieldFilterSchema.parse(filter)).toEqual(filter);
  });

  it.each([
    ['a key that is not a key', { key: 'Severity', op: 'not_set' }],
    ['a key with a path in it', { key: 'a.b', op: 'not_set' }],
    ['an operator that does not exist', { key: 'severity', op: 'like', value: 'x' }],
    ['no options to choose', { key: 'severity', op: 'any_of', values: [] }],
    ['an option that is empty', { key: 'severity', op: 'any_of', values: [' '] }],
    ['a value on not_set', { key: 'severity', op: 'not_set', value: 1 }],
    ['a number for a checkbox', { key: 'vip', op: 'is', value: 1 }],
    ['a day that is not one', { key: 'renewal', op: 'before', value: '1 March' }],
    ['a number that is not finite', { key: 'total', op: 'before', value: Number.NaN }],
    ['a range of two kinds', { key: 'total', op: 'between', from: 1, to: '2026-01-01' }],
    ['a range that ends first', { key: 'total', op: 'between', from: 9, to: 1 }],
    ['an empty search', { key: 'note', op: 'contains', value: '  ' }],
  ])('refuses %s', (_name, filter) => {
    expect(ticketFieldFilterSchema.safeParse(filter).success).toBe(false);
  });
});

describe('the fieldFilter parameter of the list', () => {
  const severity = { key: 'severity', op: 'any_of', values: ['Sev 1'] };

  it('reads one filter from a query string as a one-element list', () => {
    expect(
      ticketListQuerySchema.parse({ fieldFilter: JSON.stringify(severity) }).fieldFilter,
    ).toEqual([severity]);
  });

  it('reads several, in order, and is idempotent for the second pipe that parses it', () => {
    const once = ticketListQuerySchema.parse({
      fieldFilter: [
        JSON.stringify(severity),
        JSON.stringify({ key: 'vip', op: 'is', value: true }),
      ],
    });

    expect(once.fieldFilter).toHaveLength(2);
    expect(ticketListQuerySchema.parse(once).fieldFilter).toEqual(once.fieldFilter);
  });

  it('is absent when the query names none', () => {
    expect(ticketListQuerySchema.parse({}).fieldFilter).toBeUndefined();
  });

  it('refuses text that is not JSON, and JSON that is not a filter', () => {
    expect(ticketListQuerySchema.safeParse({ fieldFilter: 'not json' }).success).toBe(false);
    expect(ticketListQuerySchema.safeParse({ fieldFilter: '{"key":"x"}' }).success).toBe(false);
    expect(ticketListQuerySchema.safeParse({ fieldFilter: '[1]' }).success).toBe(false);
  });

  it('caps how many a request may carry', () => {
    const filters = Array.from({ length: FIELD_FILTERS_MAX + 1 }, (_, index) =>
      JSON.stringify({ key: `field_${index}`, op: 'not_set' }),
    );

    expect(ticketListQuerySchema.safeParse({ fieldFilter: filters }).success).toBe(false);
  });
});

describe('a saved view', () => {
  it('keeps field filters as objects, so anything the list accepts a view can save', () => {
    const fieldFilter = [{ key: 'severity', op: 'any_of', values: ['Sev 1'] }];

    expect(ticketViewFiltersSchema.parse({ fieldFilter }).fieldFilter).toEqual(fieldFilter);
    expect(
      ticketViewFiltersSchema.safeParse({ fieldFilter: [{ key: 'x', op: 'nope' }] }).success,
    ).toBe(false);
  });
});
