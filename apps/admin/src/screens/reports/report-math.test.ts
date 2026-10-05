import { describe, expect, it } from 'vitest';
import { niceMax } from './charts.js';
import { heatmapGrid, heatmapThresholds, stepOf } from './heatmap-scale.js';
import { csatShares, directionOf, relativeChange, slaTotals } from './kpis.js';
import { formatAverage, formatDuration } from './report-format.js';
import {
  daysOf,
  isoDay,
  isValidRange,
  presetRange,
  previousRange,
  rangeDays,
} from './report-range.js';

describe('the date range', () => {
  it('ends a preset today and counts today as one of its days', () => {
    const range = presetRange(30, new Date(2026, 9, 4, 23, 30));

    expect(range).toEqual({ from: '2026-09-05', to: '2026-10-04' });
    expect(rangeDays(range)).toBe(30);
  });

  it('compares with the same number of days just before', () => {
    expect(previousRange({ from: '2026-09-05', to: '2026-10-04' })).toEqual({
      from: '2026-08-06',
      to: '2026-09-04',
    });
  });

  it('accepts what the api accepts and nothing else', () => {
    expect(isValidRange({ from: '2026-01-01', to: '2026-12-31' })).toBe(true);
    expect(isValidRange({ from: '2026-10-04', to: '2026-10-03' })).toBe(false);
    expect(isValidRange({ from: '2025-01-01', to: '2026-01-03' })).toBe(false);
    expect(isValidRange({ from: '', to: '2026-01-03' })).toBe(false);
  });

  it('lists every day of a range across a month end', () => {
    expect(daysOf({ from: '2026-09-29', to: '2026-10-02' })).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('names the reader’s calendar day, not the UTC one', () => {
    expect(isoDay(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
  });
});

describe('formatDuration', () => {
  it.each([
    [20_000, '<1m'],
    [42 * 60_000, '42m'],
    [190 * 60_000, '3h 10m'],
    [120 * 60_000, '2h'],
    [495 * 60_000, '8h 15m'],
    [52 * 3_600_000, '2d 4h'],
    [48 * 3_600_000, '2d'],
  ])('writes %i ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it('writes a CSAT average to one decimal', () => {
    expect(formatAverage(4.46)).toBe('4.5');
  });
});

describe('the KPI arithmetic', () => {
  it('reads a change too small to print as no change', () => {
    expect(directionOf(0.0001)).toBe('same');
    expect(directionOf(0.08)).toBe('up');
    expect(directionOf(-0.2)).toBe('down');
    expect(directionOf(0.04, 0.05)).toBe('same');
  });

  it('has no relative change from nothing', () => {
    expect(relativeChange(10, 0)).toBeNull();
    expect(relativeChange(108, 100)).toBeCloseTo(0.08);
  });

  it('adds both SLA clocks for the headline, and has none when no clock finished', () => {
    const outcome = (met: number, breached: number) => ({ met, breached, compliance: null });

    expect(
      slaTotals({
        response: outcome(597, 31),
        resolution: outcome(520, 48),
        byPriority: [],
        countsReopens: false,
      }),
    ).toEqual({ met: 1117, breached: 79, compliance: 1117 / 1196 });
    expect(
      slaTotals({
        response: outcome(0, 0),
        resolution: outcome(0, 0),
        byPriority: [],
        countsReopens: true,
      }).compliance,
    ).toBeNull();
  });

  it('lists every rating five stars first, the ones nobody gave as empty', () => {
    expect(
      csatShares([
        { rating: 1, responses: 1 },
        { rating: 5, responses: 3 },
      ]),
    ).toEqual([
      { rating: 5, responses: 3, share: 0.75 },
      { rating: 4, responses: 0, share: 0 },
      { rating: 3, responses: 0, share: 0 },
      { rating: 2, responses: 0, share: 0 },
      { rating: 1, responses: 1, share: 0.25 },
    ]);
  });
});

describe('the heatmap scale', () => {
  it('spreads six lower bounds over the busiest hour', () => {
    expect(heatmapThresholds(30)).toEqual([0, 5, 10, 15, 20, 25]);
  });

  it('keeps the bounds apart when the counts are small', () => {
    expect(heatmapThresholds(2)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('puts a count in the last step it reaches', () => {
    const bounds = [0, 5, 10, 15, 20, 25];

    expect(stepOf(0, bounds)).toBe(0);
    expect(stepOf(9, bounds)).toBe(1);
    expect(stepOf(26, bounds)).toBe(5);
  });

  it('fills the hours the api left out with zero, Monday first', () => {
    const grid = heatmapGrid([{ weekday: 7, hour: 23, created: 4 }]);

    expect(grid).toHaveLength(7);
    expect(grid[0]).toHaveLength(24);
    expect(grid[6]?.[23]).toBe(4);
    expect(grid.flat().reduce((sum, count) => sum + count, 0)).toBe(4);
  });
});

describe('niceMax', () => {
  it.each([
    [0, 4],
    [7, 10],
    [38, 50],
    [142, 200],
    [1000, 1000],
  ])('rounds %i up to %i', (max, nice) => {
    expect(niceMax(max)).toBe(nice);
  });
});
