import { describe, expect, it } from 'vitest';
import {
  addBusinessTime,
  alwaysOpenCalendar,
  type BusinessCalendar,
  businessHoursUpdateRequestSchema,
  businessMsBetween,
  defaultWeeklyHours,
  holidayCreateRequestSchema,
  isWithinBusinessHours,
  nextOpening,
  timeRangeSchema,
  weeklyHoursSchema,
} from './business-hours.js';

// DOMAIN-RULES §3.6: 09:00–17:00 Sunday–Thursday, Asia/Riyadh (UTC+3, no DST).
const workday = () => [{ start: '09:00', end: '17:00' }];
const riyadh: BusinessCalendar = {
  timezone: 'Asia/Riyadh',
  weekly: [workday(), workday(), workday(), workday(), workday(), [], []],
  holidays: [],
};

/** A Riyadh wall-clock time as an instant. 2026-10-01 is a Thursday. */
const ry = (local: string): Date => new Date(`${local}:00+03:00`);

const HOUR = 3_600_000;

describe('isWithinBusinessHours', () => {
  it('is open inside a range and closed at its end', () => {
    expect(isWithinBusinessHours(riyadh, ry('2026-10-01T09:00'))).toBe(true);
    expect(isWithinBusinessHours(riyadh, ry('2026-10-01T16:59'))).toBe(true);
    expect(isWithinBusinessHours(riyadh, ry('2026-10-01T17:00'))).toBe(false);
    expect(isWithinBusinessHours(riyadh, ry('2026-10-01T08:59'))).toBe(false);
  });

  it('is closed all weekend', () => {
    expect(isWithinBusinessHours(riyadh, ry('2026-10-02T12:00'))).toBe(false);
    expect(isWithinBusinessHours(riyadh, ry('2026-10-03T12:00'))).toBe(false);
  });

  it('is closed on a holiday, in the zone of the hours', () => {
    const holiday = { ...riyadh, holidays: [{ startsOn: '2026-10-01', endsOn: '2026-10-01' }] };

    expect(isWithinBusinessHours(holiday, ry('2026-10-01T10:00'))).toBe(false);
    expect(isWithinBusinessHours(holiday, ry('2026-10-04T10:00'))).toBe(true);
  });

  it('is always open for calendar hours', () => {
    expect(isWithinBusinessHours(alwaysOpenCalendar('UTC'), ry('2026-10-02T03:00'))).toBe(true);
  });

  it('reads a second range of the same day', () => {
    const split: BusinessCalendar = {
      ...riyadh,
      weekly: riyadh.weekly.map(() => [
        { start: '09:00', end: '12:00' },
        { start: '13:00', end: '17:00' },
      ]),
    };

    expect(isWithinBusinessHours(split, ry('2026-10-01T12:30'))).toBe(false);
    expect(isWithinBusinessHours(split, ry('2026-10-01T13:30'))).toBe(true);
  });
});

describe('addBusinessTime', () => {
  it('carries over the weekend: Thursday 16:00 + 2 h is Sunday 10:00 (§3.6 example 1)', () => {
    expect(addBusinessTime(riyadh, ry('2026-10-01T16:00'), 120)).toEqual(ry('2026-10-04T10:00'));
  });

  it('starts a clock created outside the hours at the next opening (§3.1)', () => {
    expect(addBusinessTime(riyadh, ry('2026-10-02T20:00'), 30)).toEqual(ry('2026-10-04T09:30'));
  });

  it('ends exactly at closing rather than rolling to the next day', () => {
    expect(addBusinessTime(riyadh, ry('2026-10-01T16:00'), 60)).toEqual(ry('2026-10-01T17:00'));
  });

  it('skips a holiday', () => {
    const holiday = { ...riyadh, holidays: [{ startsOn: '2026-10-04', endsOn: '2026-10-05' }] };

    expect(addBusinessTime(holiday, ry('2026-10-01T16:00'), 120)).toEqual(ry('2026-10-06T10:00'));
  });

  it('returns the start for no time at all', () => {
    expect(addBusinessTime(riyadh, ry('2026-10-02T20:00'), 0)).toEqual(ry('2026-10-02T20:00'));
  });

  it('keeps fractions of a minute', () => {
    expect(addBusinessTime(riyadh, ry('2026-10-01T09:00'), 0.5)?.getTime()).toBe(
      ry('2026-10-01T09:00').getTime() + 30_000,
    );
  });

  it('counts every minute for calendar hours', () => {
    expect(addBusinessTime(alwaysOpenCalendar('UTC'), ry('2026-10-02T20:00'), 120)).toEqual(
      ry('2026-10-02T22:00'),
    );
  });

  it('gives up on a calendar that never opens', () => {
    const closed = {
      ...riyadh,
      holidays: [{ startsOn: '2000-01-01', endsOn: '2099-12-31' }],
    };

    expect(addBusinessTime(closed, ry('2026-10-01T10:00'), 60)).toBeNull();
    expect(nextOpening(closed, ry('2026-10-01T10:00'))).toBeNull();
  });

  it('follows a daylight-saving change in the zone', () => {
    // Europe/London leaves BST on Sunday 25 October 2026. Friday 16:00 local is
    // 15:00 UTC; the next opening is Monday 09:00 GMT = 09:00 UTC.
    const london: BusinessCalendar = {
      timezone: 'Europe/London',
      weekly: [[], ...Array.from({ length: 5 }, () => [{ start: '09:00', end: '17:00' }]), []],
      holidays: [],
    };

    expect(addBusinessTime(london, new Date('2026-10-23T15:00:00Z'), 120)).toEqual(
      new Date('2026-10-26T10:00:00Z'),
    );
  });
});

describe('businessMsBetween', () => {
  it('counts only the open minutes (§3.6 example 2: Thursday 16:00 to Sunday 09:30 is 1.5 h)', () => {
    expect(businessMsBetween(riyadh, ry('2026-10-01T16:00'), ry('2026-10-04T09:30'))).toBe(
      1.5 * HOUR,
    );
  });

  it('is zero when the end is not after the start', () => {
    expect(businessMsBetween(riyadh, ry('2026-10-04T10:00'), ry('2026-10-04T09:00'))).toBe(0);
  });

  it('counts wall time for calendar hours', () => {
    expect(
      businessMsBetween(alwaysOpenCalendar('UTC'), ry('2026-10-02T20:00'), ry('2026-10-02T22:00')),
    ).toBe(2 * HOUR);
  });
});

describe('nextOpening', () => {
  it('is the instant itself inside the hours', () => {
    expect(nextOpening(riyadh, ry('2026-10-01T10:00'))).toEqual(ry('2026-10-01T10:00'));
  });

  it('is the next range outside them', () => {
    expect(nextOpening(riyadh, ry('2026-10-01T18:00'))).toEqual(ry('2026-10-04T09:00'));
  });
});

describe('schemas', () => {
  it('refuses a range that ends before it starts', () => {
    expect(timeRangeSchema.safeParse({ start: '17:00', end: '09:00' }).success).toBe(false);
    expect(timeRangeSchema.safeParse({ start: '09:00', end: '24:00' }).success).toBe(true);
    expect(timeRangeSchema.safeParse({ start: '9:00', end: '10:00' }).success).toBe(false);
  });

  it('refuses overlapping ranges on one day and a week with no hours', () => {
    const overlap = defaultWeeklyHours();
    overlap[0] = [
      { start: '09:00', end: '12:00' },
      { start: '11:00', end: '13:00' },
    ];

    expect(weeklyHoursSchema.safeParse(overlap).success).toBe(false);
    expect(weeklyHoursSchema.safeParse([[], [], [], [], [], [], []]).success).toBe(false);
    expect(weeklyHoursSchema.safeParse(defaultWeeklyHours()).success).toBe(true);
  });

  it('starts a brand on Monday to Friday, 09:00–17:00', () => {
    expect(defaultWeeklyHours().map((ranges) => ranges.length)).toEqual([0, 1, 1, 1, 1, 1, 0]);
  });

  it('refuses an unknown zone', () => {
    expect(
      businessHoursUpdateRequestSchema.safeParse({
        brand: { timezone: 'Mars/Olympus', weekly: defaultWeeklyHours() },
        departments: [],
      }).success,
    ).toBe(false);
  });

  it('defaults a holiday to every department and refuses one that ends first', () => {
    expect(
      holidayCreateRequestSchema.parse({ name: 'Founding Day', startsOn: '2027-02-22' })
        .departmentId,
    ).toBeNull();
    expect(
      holidayCreateRequestSchema.safeParse({
        name: 'Eid',
        startsOn: '2027-03-11',
        endsOn: '2027-03-09',
      }).success,
    ).toBe(false);
    expect(
      holidayCreateRequestSchema.safeParse({
        name: 'Forever',
        startsOn: '2027-01-01',
        endsOn: '2029-01-01',
      }).success,
    ).toBe(false);
  });
});
