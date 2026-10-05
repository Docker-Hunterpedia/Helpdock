import { describe, expect, it } from 'vitest';
import {
  addDays,
  BACKFILL_MAX_DAYS,
  chunkDays,
  daysOf,
  localDay,
  rollupWindow,
  TRAILING_DAYS,
} from './rollup-window.js';

describe('localDay', () => {
  it('is the date on the brand’s wall clock, not in UTC', () => {
    const lateEvening = new Date('2026-10-05T22:30:00Z');

    expect(localDay(lateEvening, 'UTC')).toBe('2026-10-05');
    expect(localDay(lateEvening, 'Asia/Riyadh')).toBe('2026-10-06');
    expect(localDay(lateEvening, 'America/Los_Angeles')).toBe('2026-10-05');
  });
});

describe('addDays', () => {
  it('moves across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('rollupWindow', () => {
  it('rebuilds the trailing week once a brand has rollups', () => {
    expect(
      rollupWindow({ today: '2026-10-05', rolledUpBefore: true, firstActivityDay: '2025-01-01' }),
    ).toEqual({ from: addDays('2026-10-05', -(TRAILING_DAYS - 1)), to: '2026-10-05' });
  });

  it('backfills a brand that has none from its first ticket', () => {
    expect(
      rollupWindow({ today: '2026-10-05', rolledUpBefore: false, firstActivityDay: '2026-08-01' }),
    ).toEqual({ from: '2026-08-01', to: '2026-10-05' });
  });

  it('caps a backfill at the maximum, however old the first ticket', () => {
    const window = rollupWindow({
      today: '2026-10-05',
      rolledUpBefore: false,
      firstActivityDay: '2019-01-01',
    });

    expect(daysOf(window)).toHaveLength(BACKFILL_MAX_DAYS);
  });

  it('keeps to the trailing week for a brand with no tickets or only recent ones', () => {
    const week = { from: addDays('2026-10-05', -(TRAILING_DAYS - 1)), to: '2026-10-05' };

    expect(
      rollupWindow({ today: '2026-10-05', rolledUpBefore: false, firstActivityDay: null }),
    ).toEqual(week);
    expect(
      rollupWindow({ today: '2026-10-05', rolledUpBefore: false, firstActivityDay: '2026-10-04' }),
    ).toEqual(week);
  });
});

describe('chunkDays', () => {
  it('cuts a range into consecutive chunks that cover it exactly', () => {
    const chunks = chunkDays({ from: '2026-01-01', to: '2026-03-05' }, 31);

    expect(chunks).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-03-03' },
      { from: '2026-03-04', to: '2026-03-05' },
    ]);
  });

  it('leaves a short range whole', () => {
    expect(chunkDays({ from: '2026-10-01', to: '2026-10-05' })).toEqual([
      { from: '2026-10-01', to: '2026-10-05' },
    ]);
  });
});
