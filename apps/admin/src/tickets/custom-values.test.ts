import type { CustomFieldDef, CustomFieldType } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { draftChanges, draftOf, ticketFieldsFor, valueOfDraft } from './custom-values.js';

const def = (type: CustomFieldType, overrides: Partial<CustomFieldDef> = {}): CustomFieldDef => ({
  id: `id-${type}`,
  target: 'ticket',
  key: type,
  label: type,
  labelAr: null,
  type,
  options: type === 'select' || type === 'multi_select' ? ['a', 'b'] : [],
  required: false,
  agentVisible: true,
  sortOrder: 0,
  ...overrides,
});

describe('draftOf', () => {
  it('holds a number as the string an input shows', () => {
    expect(draftOf(def('number'), 12.5)).toBe('12.5');
  });

  it('holds nothing stored as an empty input, an unticked box and no choices', () => {
    expect(draftOf(def('text'), undefined)).toBe('');
    expect(draftOf(def('checkbox'), undefined)).toBe(false);
    expect(draftOf(def('multi_select'), undefined)).toEqual([]);
  });

  it('keeps only the strings of a stored multi-select', () => {
    expect(draftOf(def('multi_select'), ['a', 3])).toEqual(['a']);
  });
});

describe('valueOfDraft', () => {
  it('sends an emptied field as null, which clears it', () => {
    expect(valueOfDraft(def('text'), '   ')).toBeNull();
    expect(valueOfDraft(def('date'), '')).toBeNull();
    expect(valueOfDraft(def('select'), '')).toBeNull();
    expect(valueOfDraft(def('multi_select'), [])).toBeNull();
  });

  it('sends a number as a number', () => {
    expect(valueOfDraft(def('number'), '12.5')).toBe(12.5);
  });

  it('sends a number it cannot read as typed, so the api refuses it rather than it vanishing', () => {
    expect(valueOfDraft(def('number'), 'twelve')).toBe('twelve');
  });

  it('trims text, and sends dates, choices and ticks as they are', () => {
    expect(valueOfDraft(def('text'), ' ORD-1 ')).toBe('ORD-1');
    expect(valueOfDraft(def('date'), '2026-09-02')).toBe('2026-09-02');
    expect(valueOfDraft(def('multi_select'), ['a'])).toEqual(['a']);
    expect(valueOfDraft(def('checkbox'), false)).toBe(false);
  });
});

describe('draftChanges', () => {
  it('is false for a blur that changed nothing', () => {
    expect(draftChanges(def('number'), 5, '5')).toBe(false);
    expect(draftChanges(def('text'), undefined, '')).toBe(false);
    expect(draftChanges(def('text'), 'ORD-1', 'ORD-1 ')).toBe(false);
  });

  it('is true for a new value or a cleared one', () => {
    expect(draftChanges(def('number'), 5, '6')).toBe(true);
    expect(draftChanges(def('text'), 'ORD-1', '')).toBe(true);
  });
});

describe('ticketFieldsFor', () => {
  const fields = [
    def('text', { id: '1', sortOrder: 2 }),
    def('number', { id: '2', sortOrder: 1, agentVisible: false }),
    def('date', { id: '3', sortOrder: 0, target: 'contact' }),
  ];

  it('keeps the ticket’s fields in the brand’s order', () => {
    expect(ticketFieldsFor(fields, true).map((field) => field.id)).toEqual(['2', '1']);
  });

  it('leaves out a field hidden from Agents for a reader who is one', () => {
    expect(ticketFieldsFor(fields, false).map((field) => field.id)).toEqual(['1']);
  });
});
