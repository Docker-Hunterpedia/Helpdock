import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_WORDS,
  normalizeForTrigram,
  normalizeQuery,
  searchTerms,
} from './query-terms.js';

describe('normalizeQuery', () => {
  it('trims, collapses spaces and lower-cases, so one search counts once in the log', () => {
    expect(normalizeQuery('  Refund   Timelines ')).toBe('refund timelines');
  });

  it('caps a pasted paragraph at the logged length', () => {
    expect(normalizeQuery('a'.repeat(500))).toHaveLength(200);
  });
});

describe('normalizeForTrigram', () => {
  it('drops Arabic diacritics and tatweel', () => {
    expect(normalizeForTrigram('مُفِيدَة')).toBe('مفيده');
    expect(normalizeForTrigram('اســترداد')).toBe('استرداد');
  });

  it('folds the alef, yaa and taa marbuta variants the way the title column does', () => {
    expect(normalizeForTrigram('أإآٱ')).toBe('اااا');
    expect(normalizeForTrigram('على')).toBe('علي');
    expect(normalizeForTrigram('Refund')).toBe('refund');
  });
});

describe('searchTerms', () => {
  it('asks for every word, the last as a prefix, and for any word', () => {
    expect(searchTerms('refund timel')).toEqual({
      words: ['refund', 'timel'],
      all: 'refund & timel:*',
      any: 'refund | timel:*',
      fuzzy: 'refund timel',
    });
  });

  it('keeps only letters and digits, so nothing a visitor types is a tsquery operator', () => {
    const terms = searchTerms("order #8841 isn't here! & | ( ) : * \\");

    expect(terms?.words).toEqual(['order', '8841', 'isn', 't', 'here']);
    expect(terms?.all).not.toMatch(/[!()\\#]/);
  });

  it('splits Arabic into whole words even when they carry harakat', () => {
    const terms = searchTerms('مَوَاعِيد الاسترداد');

    expect(terms?.words).toEqual(['مواعيد', 'الاسترداد']);
    expect(terms?.all).toBe('مواعيد & الاسترداد:*');
  });

  it('gives the stemmer the word as typed and folds letters only for the trigram side', () => {
    const terms = searchTerms('مفيدة');

    expect(terms?.all).toBe('مفيدة:*');
    expect(terms?.fuzzy).toBe('مفيده');
  });

  it('answers null for a query with no word in it', () => {
    expect(searchTerms('  ?! ')).toBeNull();
    expect(searchTerms('')).toBeNull();
  });

  it('ignores words past the cap', () => {
    const many = Array.from({ length: 20 }, (_, index) => `w${index}`).join(' ');

    expect(searchTerms(many)?.words).toHaveLength(MAX_QUERY_WORDS);
  });
});
