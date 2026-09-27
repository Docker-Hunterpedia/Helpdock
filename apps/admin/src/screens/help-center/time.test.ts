import { describe, expect, it } from 'vitest';
import { formatDay, formatStamp, fromWallClock, toWallClock } from './time.js';

describe('the brand’s wall clock', () => {
  it('reads an instant in the brand’s zone and back', () => {
    const iso = '2026-10-01T06:00:00.000Z';

    expect(toWallClock(iso, 'Asia/Riyadh')).toEqual({ date: '2026-10-01', time: '09:00' });
    expect(fromWallClock({ date: '2026-10-01', time: '09:00' }, 'Asia/Riyadh')).toBe(iso);
  });

  it('follows a zone with summer time', () => {
    expect(fromWallClock({ date: '2026-07-01', time: '09:00' }, 'Europe/London')).toBe(
      '2026-07-01T08:00:00.000Z',
    );
    expect(fromWallClock({ date: '2026-12-01', time: '09:00' }, 'Europe/London')).toBe(
      '2026-12-01T09:00:00.000Z',
    );
  });

  it('refuses what is not a date and a time', () => {
    expect(fromWallClock({ date: '1 Oct', time: '09:00' }, 'UTC')).toBeNull();
    expect(fromWallClock({ date: '2026-10-01', time: '25:00' }, 'UTC')).toBeNull();
    expect(fromWallClock({ date: '2026-13-01', time: '09:00' }, 'UTC')).toBeNull();
  });

  it('formats with Latin digits in both languages', () => {
    const iso = '2026-09-12T07:02:00.000Z';

    expect(formatStamp(iso, 'en', 'Asia/Riyadh')).toBe('12 Sep 10:02');
    expect(formatStamp(iso, 'ar', 'Asia/Riyadh')).toMatch(/12.*10:02/);
    expect(formatDay(iso, 'en', 'UTC')).toBe('12 Sep');
  });
});
