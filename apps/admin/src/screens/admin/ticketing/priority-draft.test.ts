import { describe, expect, it } from 'vitest';
import {
  draftOf,
  duplicateIssues,
  firstInvalid,
  formatIssues,
  hasOverride,
  isDirty,
  pillName,
  resetRow,
  showsDefault,
  toRequest,
  withField,
} from './priority-draft.js';

const stored = { high: { en: 'P2', ar: 'عالية جدًا' }, urgent: { en: 'P1' } };

describe('priority draft', () => {
  it('starts from the stored names, with empty fields for the defaults', () => {
    const draft = draftOf(stored);

    expect(draft.high).toEqual({ en: 'P2', ar: 'عالية جدًا' });
    expect(draft.urgent).toEqual({ en: 'P1', ar: '' });
    expect(draft.low).toEqual({ en: '', ar: '' });
  });

  it('is clean until something differs from what is stored, ignoring spaces', () => {
    const draft = draftOf(stored);

    expect(isDirty(draft, stored)).toBe(false);
    expect(isDirty(withField(draft, { priority: 'high', locale: 'en' }, ' P2 '), stored)).toBe(
      false,
    );
    expect(isDirty(withField(draft, { priority: 'low', locale: 'en' }, '   '), stored)).toBe(false);
    expect(isDirty(withField(draft, { priority: 'low', locale: 'en' }, 'Meh'), stored)).toBe(true);
  });

  it('resets a row to nothing, which is a change that still needs Save', () => {
    const reset = resetRow(draftOf(stored), 'high');

    expect(reset.high).toEqual({ en: '', ar: '' });
    expect(hasOverride(reset, 'high')).toBe(false);
    expect(hasOverride(reset, 'urgent')).toBe(true);
    expect(isDirty(reset, stored)).toBe(true);
    expect(toRequest(reset)).toEqual({ urgent: { en: 'P1' } });
  });

  it('shows the typed name on the pill and the default under it, per language', () => {
    const draft = draftOf(stored);

    expect(pillName(draft, 'high', 'en')).toBe('P2');
    expect(showsDefault(draft, 'high', 'en')).toBe(true);
    expect(pillName(draft, 'low', 'ar')).toBe('منخفضة');
    expect(showsDefault(draft, 'low', 'ar')).toBe(false);
    expect(pillName(draft, 'urgent', 'ar')).toBe('عاجلة');
  });

  describe('duplicates', () => {
    it('places the error on the field edited last when it is one of the two', () => {
      const draft = withField(draftOf(stored), { priority: 'high', locale: 'en' }, 'P1');

      expect(duplicateIssues(draft, { priority: 'high', locale: 'en' })).toEqual([
        { key: { priority: 'high', locale: 'en' }, takenBy: 'urgent' },
      ]);
      expect(duplicateIssues(draft, { priority: 'urgent', locale: 'en' })).toEqual([
        { key: { priority: 'urgent', locale: 'en' }, takenBy: 'high' },
      ]);
    });

    it('falls back to the field the shared rule names when the last edit is elsewhere', () => {
      const draft = withField(draftOf({}), { priority: 'low', locale: 'en' }, 'high');

      expect(duplicateIssues(draft, { priority: 'urgent', locale: 'ar' })).toEqual([
        { key: { priority: 'low', locale: 'en' }, takenBy: 'high' },
      ]);
      expect(duplicateIssues(draft, null)).toHaveLength(1);
    });

    it('finds none when the names differ or are the swapped defaults', () => {
      expect(duplicateIssues(draftOf(stored), null)).toEqual([]);
      const swapped = withField(
        withField(draftOf({}), { priority: 'high', locale: 'en' }, 'Urgent'),
        { priority: 'urgent', locale: 'en' },
        'High',
      );
      expect(duplicateIssues(swapped, null)).toEqual([]);
    });
  });

  it('puts focus on the first invalid field in reading order', () => {
    expect(
      firstInvalid([
        { priority: 'urgent', locale: 'en' },
        { priority: 'high', locale: 'ar' },
        { priority: 'high', locale: 'en' },
      ]),
    ).toEqual({ priority: 'high', locale: 'en' });
    expect(firstInvalid([])).toBeUndefined();
  });

  it('finds names the api would refuse for their form', () => {
    const draft = withField(
      withField(draftOf({}), { priority: 'low', locale: 'en' }, 'Minor\u200b'),
      { priority: 'high', locale: 'ar' },
      'x'.repeat(30),
    );

    expect(formatIssues(draft)).toEqual([
      { priority: 'low', locale: 'en' },
      { priority: 'high', locale: 'ar' },
    ]);
    expect(formatIssues(withField(draftOf({}), { priority: 'low', locale: 'en' }, '  '))).toEqual(
      [],
    );
  });
});
