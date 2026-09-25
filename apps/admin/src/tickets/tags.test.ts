import type { Tag, TagSummary } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { sameTagSet, tagLabel, tagMatches, tagsForIds, toggleTag, withTicketTags } from './tags.js';

const summary = (id: string, name: string, sortOrder: number): TagSummary => ({
  id,
  name,
  nameAr: null,
  color: 'sand',
  sortOrder,
  ticketCount: 0,
});

const BRAND: readonly TagSummary[] = [summary('a', 'Refund', 0), summary('b', 'VIP', 1)];

describe('toggleTag', () => {
  it('adds a tag the set does not hold, at the end', () => {
    expect(toggleTag(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('takes off a tag the set holds', () => {
    expect(toggleTag(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('sameTagSet', () => {
  it('ignores order', () => {
    expect(sameTagSet(['a', 'b'], ['b', 'a'])).toBe(true);
  });

  it('tells a subset from the set', () => {
    expect(sameTagSet(['a', 'b'], ['a'])).toBe(false);
    expect(sameTagSet(['a'], ['b'])).toBe(false);
  });
});

describe('tagsForIds', () => {
  const stale: Tag = { id: 'z', name: 'Legacy', nameAr: null, color: 'stone' };

  it('draws the set in the brand’s order, whatever order it was picked in', () => {
    expect(tagsForIds(['b', 'a'], [], BRAND).map((tag) => tag.name)).toEqual(['Refund', 'VIP']);
  });

  it('keeps a chip the ticket carries but the list no longer has, last', () => {
    expect(tagsForIds(['z', 'a'], [stale], BRAND).map((tag) => tag.name)).toEqual([
      'Refund',
      'Legacy',
    ]);
  });

  it('drops an id found nowhere rather than drawing a blank chip', () => {
    expect(tagsForIds(['nope'], [], BRAND)).toEqual([]);
  });

  it('returns chips, not the settings rows', () => {
    expect(tagsForIds(['a'], [], BRAND)[0]).toEqual({
      id: 'a',
      name: 'Refund',
      nameAr: null,
      color: 'sand',
    });
  });
});

describe('tagLabel and tagMatches', () => {
  const tag = { name: 'Refund', nameAr: 'استرداد' };

  it('draws the Arabic name on an Arabic desk, and the Latin one otherwise', () => {
    expect(tagLabel(tag, 'ar')).toBe('استرداد');
    expect(tagLabel(tag, 'en')).toBe('Refund');
    expect(tagLabel({ name: 'VIP', nameAr: null }, 'ar')).toBe('VIP');
  });

  it('matches either name, ignoring case, and everything for an empty term', () => {
    expect(tagMatches(tag, 'REF')).toBe(true);
    expect(tagMatches(tag, 'استر')).toBe(true);
    expect(tagMatches(tag, '  ')).toBe(true);
    expect(tagMatches(tag, 'vip')).toBe(false);
    expect(tagMatches({ name: 'VIP', nameAr: null }, 'x')).toBe(false);
  });
});

describe('withTicketTags', () => {
  it('replaces the chips and nothing else', () => {
    const detail = { ticket: { subject: 'Hi', tags: [] as Tag[] }, other: 1 };
    const tags: Tag[] = [{ id: 'a', name: 'Refund', nameAr: null, color: 'info' }];

    expect(withTicketTags(detail, tags)).toEqual({ ticket: { subject: 'Hi', tags }, other: 1 });
  });
});
