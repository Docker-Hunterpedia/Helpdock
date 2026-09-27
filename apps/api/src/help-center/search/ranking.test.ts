import { describe, expect, it } from 'vitest';
import { CANDIDATE_LIMIT, type Candidate, mergeRankings } from './ranking.js';

const candidate = (articleId: string, locale: 'en' | 'ar' = 'en'): Candidate => ({
  articleId,
  locale,
});
const ids = (list: readonly Candidate[]) => list.map((entry) => entry.articleId);

describe('mergeRankings', () => {
  it('keeps a single list in its own order', () => {
    expect(ids(mergeRankings([[candidate('a'), candidate('b'), candidate('c')]]))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('ranks an article both sources found above one only a single source found', () => {
    const lexical = [candidate('a'), candidate('b'), candidate('c')];
    const semantic = [candidate('c'), candidate('d')];

    // b and d are both second in their list: a tie, which the first seen wins.
    expect(ids(mergeRankings([lexical, semantic]))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('breaks a tie by who was seen first, so the order is stable', () => {
    expect(ids(mergeRankings([[candidate('a')], [candidate('b')]]))).toEqual(['a', 'b']);
  });

  it('keeps the language of the first list that found the article', () => {
    const [merged] = mergeRankings([[candidate('a', 'ar')], [candidate('a', 'en')]]);

    expect(merged).toEqual(candidate('a', 'ar'));
  });

  it('answers nothing for no lists, and at most the candidate limit', () => {
    const long = Array.from({ length: CANDIDATE_LIMIT + 10 }, (_, index) =>
      candidate(`id-${index}`),
    );

    expect(mergeRankings([])).toEqual([]);
    expect(mergeRankings([long])).toHaveLength(CANDIDATE_LIMIT);
  });
});
