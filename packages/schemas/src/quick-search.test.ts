import { describe, expect, it } from 'vitest';
import {
  QUICK_SEARCH_LIMIT_DEFAULT,
  quickSearchQuerySchema,
  quickSearchSchema,
} from './quick-search.js';

describe('quickSearchQuerySchema', () => {
  it('trims the text and defaults the limit', () => {
    expect(quickSearchQuerySchema.parse({ q: '  HD-1042 ' })).toEqual({
      q: 'HD-1042',
      limit: QUICK_SEARCH_LIMIT_DEFAULT,
      locale: 'en',
    });
  });

  it('reads the limit from a query string', () => {
    expect(quickSearchQuerySchema.parse({ q: 'a', limit: '3' }).limit).toBe(3);
  });

  it('takes the locale and refuses one the install does not speak', () => {
    expect(quickSearchQuerySchema.parse({ q: 'a', locale: 'ar' }).locale).toBe('ar');
    expect(quickSearchQuerySchema.safeParse({ q: 'a', locale: 'fr' }).success).toBe(false);
  });

  it('refuses an empty text, an over-long one and a limit out of range', () => {
    expect(quickSearchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(quickSearchQuerySchema.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
    expect(quickSearchQuerySchema.safeParse({ q: 'a', limit: 11 }).success).toBe(false);
    expect(quickSearchQuerySchema.safeParse({ q: 'a', limit: 0 }).success).toBe(false);
  });
});

describe('quickSearchSchema', () => {
  it('takes each section as ok, skipped or failed', () => {
    const parsed = quickSearchSchema.parse({
      tickets: { status: 'ok', items: [] },
      contacts: { status: 'skipped' },
      articles: { status: 'failed' },
    });
    expect(parsed.contacts.status).toBe('skipped');
  });

  it('drops a field a section should not carry and refuses an unknown status', () => {
    expect(
      quickSearchSchema.safeParse({
        tickets: { status: 'late' },
        contacts: { status: 'skipped' },
        articles: { status: 'skipped' },
      }).success,
    ).toBe(false);
  });
});
