import type { TicketFieldFilter } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  blankDraft,
  draftOfFilter,
  filterOfDraft,
  filtersOfDrafts,
  operatorsOf,
} from './field-filter-draft.js';

describe('operatorsOf', () => {
  it('offers each type the operators the api answers for it, the first being the default', () => {
    expect(operatorsOf('select')).toEqual(['any_of', 'not_set']);
    expect(operatorsOf('multi_select')).toEqual(['any_of', 'not_set']);
    expect(operatorsOf('checkbox')).toEqual(['is', 'not_set']);
    expect(operatorsOf('number')).toEqual(['between', 'before', 'after', 'not_set']);
    expect(operatorsOf('date')).toEqual(['between', 'before', 'after', 'not_set']);
    expect(operatorsOf('text')).toEqual(['contains', 'not_set']);
    expect(blankDraft({ key: 'severity', type: 'select' }).op).toBe('any_of');
  });
});

describe('filterOfDraft', () => {
  const draft = (patch: Partial<ReturnType<typeof blankDraft>>) => ({
    ...blankDraft({ key: 'severity', type: 'select' }),
    ...patch,
  });

  it('is null while the row has no value yet, so the list is never asked for it', () => {
    expect(filterOfDraft(draft({ op: 'any_of' }), 'select')).toBeNull();
    expect(filterOfDraft(draft({ op: 'contains', text: '  ' }), 'text')).toBeNull();
    expect(filterOfDraft(draft({ op: 'before', text: '' }), 'number')).toBeNull();
    expect(filterOfDraft(draft({ op: 'between', text: '1' }), 'number')).toBeNull();
  });

  it('builds each operator from the box the type shows', () => {
    expect(filterOfDraft(draft({ values: ['Sev 1', 'Sev 2'] }), 'select')).toEqual({
      key: 'severity',
      op: 'any_of',
      values: ['Sev 1', 'Sev 2'],
    });
    expect(filterOfDraft(draft({ op: 'not_set' }), 'select')).toEqual({
      key: 'severity',
      op: 'not_set',
    });
    expect(filterOfDraft(draft({ op: 'is', flag: false }), 'checkbox')).toEqual({
      key: 'severity',
      op: 'is',
      value: false,
    });
    expect(filterOfDraft(draft({ op: 'contains', text: ' stripe ' }), 'text')).toEqual({
      key: 'severity',
      op: 'contains',
      value: 'stripe',
    });
  });

  it('reads a number box as a number and a date box as the day typed', () => {
    expect(filterOfDraft(draft({ op: 'after', text: '10.5' }), 'number')).toEqual({
      key: 'severity',
      op: 'after',
      value: 10.5,
    });
    expect(filterOfDraft(draft({ op: 'after', text: 'ten' }), 'number')).toBeNull();
    expect(filterOfDraft(draft({ op: 'before', text: '2026-03-01' }), 'date')).toEqual({
      key: 'severity',
      op: 'before',
      value: '2026-03-01',
    });
    expect(filterOfDraft(draft({ op: 'before', text: '1 March' }), 'date')).toBeNull();
  });

  it('is null for a range that ends before it starts, which the api would refuse', () => {
    expect(filterOfDraft(draft({ op: 'between', text: '5', to: '1' }), 'number')).toBeNull();
    expect(filterOfDraft(draft({ op: 'between', text: '1', to: '5' }), 'number')).toEqual({
      key: 'severity',
      op: 'between',
      from: 1,
      to: 5,
    });
  });
});

describe('draftOfFilter', () => {
  it.each<TicketFieldFilter>([
    { key: 'severity', op: 'any_of', values: ['Sev 1'] },
    { key: 'severity', op: 'not_set' },
    { key: 'vip', op: 'is', value: false },
    { key: 'total', op: 'before', value: 10 },
    { key: 'total', op: 'between', from: 1, to: 9 },
    { key: 'renewal', op: 'after', value: '2026-01-01' },
    { key: 'note', op: 'contains', value: 'stripe' },
  ])('round-trips $op', (filter) => {
    const type = (
      {
        severity: 'select',
        vip: 'checkbox',
        total: 'number',
        renewal: 'date',
        note: 'text',
      } as const
    )[filter.key as 'severity'];

    expect(filterOfDraft(draftOfFilter(filter), type)).toEqual(filter);
  });
});

describe('filtersOfDrafts', () => {
  it('keeps the complete rows in order and drops a row whose field is gone', () => {
    const defs = [
      { key: 'severity', type: 'select' as const },
      { key: 'vip', type: 'checkbox' as const },
    ];

    expect(
      filtersOfDrafts(
        [
          blankDraft({ key: 'vip', type: 'checkbox' }),
          blankDraft({ key: 'severity', type: 'select' }),
          { ...blankDraft({ key: 'removed', type: 'text' }), op: 'not_set' },
        ],
        defs,
      ),
    ).toEqual([{ key: 'vip', op: 'is', value: true }]);
  });
});
