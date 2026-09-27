import { defaultWeeklyHours } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { brandCalendar, buildCalendars } from './calendars.js';
import type { CalendarRows } from './sla.repository.js';

const TECHNICAL = '01937f5e-7e53-7000-8000-0000000000d1';
const BILLING = '01937f5e-7e53-7000-8000-0000000000d2';
const sunday = [[{ start: '10:00', end: '14:00' }], [], [], [], [], [], []];

const rows: CalendarRows = {
  brandTimezone: 'Asia/Riyadh',
  brandWeekly: null,
  overrides: new Map([[TECHNICAL, { timezone: 'Asia/Dubai', weekly: sunday }]]),
  holidays: [
    { startsOn: '2027-02-22', endsOn: '2027-02-22', departmentId: null },
    { startsOn: '2026-12-30', endsOn: '2026-12-30', departmentId: TECHNICAL },
  ],
};

describe('buildCalendars', () => {
  it('gives a department its own hours and zone, and the holidays that apply to it', () => {
    expect(buildCalendars(rows)('business', TECHNICAL)).toEqual({
      timezone: 'Asia/Dubai',
      weekly: sunday,
      holidays: rows.holidays,
    });
  });

  it('falls back to the brand, and to the default week before any is saved', () => {
    expect(buildCalendars(rows)('business', BILLING)).toEqual({
      timezone: 'Asia/Riyadh',
      weekly: defaultWeeklyHours(),
      holidays: [rows.holidays[0]],
    });
  });

  it('counts every minute for calendar hours, keeping the zone', () => {
    expect(buildCalendars(rows)('calendar', TECHNICAL)).toMatchObject({
      timezone: 'Asia/Dubai',
      alwaysOpen: true,
    });
  });
});

describe('brandCalendar', () => {
  it('is the brand hours with the holidays of every department', () => {
    expect(brandCalendar({ ...rows, brandWeekly: sunday })).toEqual({
      timezone: 'Asia/Riyadh',
      weekly: sunday,
      holidays: [rows.holidays[0]],
    });
  });
});
