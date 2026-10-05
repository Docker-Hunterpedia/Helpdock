import { describe, expect, it } from 'vitest';
import { fuseRankings, LOCALE_BOOST, RRF_K } from './fusion.js';

const en = (id: string) => ({ id, locale: 'en' });
const ar = (id: string) => ({ id, locale: 'ar' });

describe('fuseRankings', () => {
  it('puts a chunk both rankers found above one only one of them found', () => {
    const fused = fuseRankings(
      [
        [en('a'), en('b')],
        [en('b'), en('c')],
      ],
      { locale: 'en' },
    );

    expect(fused.map((chunk) => chunk.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0]?.score).toBeCloseTo((1 / (RRF_K + 2) + 1 / (RRF_K + 1)) * LOCALE_BOOST);
  });

  it('keeps one list’s order, ties broken by first appearance', () => {
    expect(fuseRankings([[en('a'), en('b')]], { locale: 'en' }).map((chunk) => chunk.id)).toEqual([
      'a',
      'b',
    ]);
    expect(fuseRankings([[en('a')], [en('b')]], { locale: 'en' }).map((chunk) => chunk.id)).toEqual(
      ['a', 'b'],
    );
  });

  it('lifts a chunk in the reader’s language over a neighbour in the other', () => {
    const fused = fuseRankings([[en('english'), ar('arabic')]], { locale: 'ar' });

    expect(fused.map((chunk) => chunk.id)).toEqual(['arabic', 'english']);
  });

  it('does not let the boost overturn a much stronger match', () => {
    const fused = fuseRankings([[en('strong'), en('x'), ar('weak')], [en('strong')]], {
      locale: 'ar',
    });

    expect(fused[0]?.id).toBe('strong');
  });
});
