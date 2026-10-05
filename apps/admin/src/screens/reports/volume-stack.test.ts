import { describe, expect, it } from 'vitest';
import { OTHER_SERIES, stackByDay } from './volume-stack.js';

const DAYS = ['2026-10-01', '2026-10-02'];

describe('stackByDay', () => {
  it('puts the largest series first and fills the days the api left out with zeroes', () => {
    const stack = stackByDay(
      DAYS,
      [
        { day: '2026-10-01', key: 'chat', count: 1 },
        { day: '2026-10-02', key: 'email', count: 3 },
      ],
      ['email', 'chat'],
    );

    expect(stack.series).toEqual([
      { key: 'email', index: 0, total: 3 },
      { key: 'chat', index: 1, total: 1 },
    ]);
    expect(stack.days).toEqual([
      { day: '2026-10-01', counts: [0, 1] },
      { day: '2026-10-02', counts: [3, 0] },
    ]);
  });

  it('keeps the natural order between series of the same size', () => {
    const stack = stackByDay(
      DAYS,
      [
        { day: '2026-10-01', key: 'low', count: 2 },
        { day: '2026-10-01', key: 'urgent', count: 2 },
      ],
      ['urgent', 'high', 'medium', 'low'],
    );

    expect(stack.series.map((series) => series.key)).toEqual(['urgent', 'low']);
  });

  it('folds a sixth series and beyond into Other', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const stack = stackByDay(
      DAYS,
      keys.map((key, index) => ({ day: '2026-10-01', key, count: 10 - index })),
      keys,
    );

    expect(stack.series.map((series) => series.key)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      OTHER_SERIES,
    ]);
    expect(stack.series.at(-1)?.total).toBe(5 + 4);
    expect(stack.days[0]?.counts).toEqual([10, 9, 8, 7, 6, 9]);
  });

  it('draws no series for a range with no tickets', () => {
    expect(stackByDay(DAYS, [], ['email'])).toEqual({
      series: [],
      days: [
        { day: '2026-10-01', counts: [] },
        { day: '2026-10-02', counts: [] },
      ],
    });
  });
});
