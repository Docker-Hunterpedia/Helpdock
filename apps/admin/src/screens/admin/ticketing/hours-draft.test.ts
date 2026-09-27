import type { BusinessHoursOverview, WeeklyHours } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  addRange,
  copyFirstDayToOpenDays,
  draftOf,
  firstInvalidDay,
  holidayDates,
  problemOf,
  removeRange,
  requestOf,
  sameDraft,
  setDayOpen,
  setRange,
  summarizeWeek,
  zoneLabel,
} from './hours-draft.js';

const day = () => [{ start: '09:00', end: '17:00' }];
const sunToThu: WeeklyHours = [day(), day(), day(), day(), day(), [], []];
const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (index: number): string => names[index] ?? '';
const BILLING = '0192c3f0-1a2b-7c3d-8e4f-0000000000d2';

const overview: BusinessHoursOverview = {
  brand: { timezone: 'Asia/Riyadh', weekly: sunToThu },
  departments: [{ departmentId: BILLING, name: 'Billing', nameAr: null, override: null }],
  holidays: [],
  runningTickets: 41,
};

describe('the draft', () => {
  it('round-trips the overview into the request the Save sends', () => {
    expect(requestOf(draftOf(overview))).toEqual({
      brand: overview.brand,
      departments: [{ departmentId: BILLING, override: null }],
    });
    expect(sameDraft(draftOf(overview), draftOf(overview))).toBe(true);
  });

  it('names the first range that cannot be saved, and where', () => {
    const backwards = setRange(sunToThu, 6, 0, { start: '10:00', end: '09:00' });
    expect(firstInvalidDay(backwards)).toBeNull();

    const saturday = setDayOpen(sunToThu, 6, true);
    const broken = setRange(saturday, 6, 0, { start: '10:00', end: '09:00' });
    expect(firstInvalidDay(broken)).toBe(6);
    expect(
      problemOf({
        brand: overview.brand,
        overrides: { [BILLING]: { timezone: 'UTC', weekly: broken } },
      }),
    ).toEqual({ kind: 'range', day: 6, departmentId: BILLING });
  });

  it('refuses a week with no open range, and overlapping ranges', () => {
    const closed = [[], [], [], [], [], [], []];
    expect(problemOf({ brand: { ...overview.brand, weekly: closed }, overrides: {} })).toEqual({
      kind: 'closed',
      departmentId: null,
    });

    const overlapping = setRange(addRange(sunToThu, 0), 0, 1, { start: '12:00', end: '18:00' });
    expect(firstInvalidDay(overlapping)).toBe(0);
    expect(problemOf(draftOf(overview))).toBeNull();
  });
});

describe('editing a week', () => {
  it('opens a day with a working day, closes it, adds and removes ranges', () => {
    expect(setDayOpen(sunToThu, 5, true)[5]).toEqual([{ start: '09:00', end: '17:00' }]);
    expect(setDayOpen(sunToThu, 0, false)[0]).toEqual([]);
    expect(addRange(sunToThu, 0)[0]).toEqual([
      { start: '09:00', end: '17:00' },
      { start: '18:00', end: '19:00' },
    ]);
    expect(addRange(sunToThu, 5)[5]).toEqual([{ start: '09:00', end: '10:00' }]);
    expect(removeRange(sunToThu, 0, 0)[0]).toEqual([]);
  });

  it('copies Sunday onto every other open day', () => {
    const split = setRange(sunToThu, 0, 0, { start: '08:00', end: '20:00' });
    const copied = copyFirstDayToOpenDays(split);

    expect(copied[3]).toEqual([{ start: '08:00', end: '20:00' }]);
    expect(copied[5]).toEqual([]);
  });
});

describe('summarizeWeek', () => {
  it('reads a regular stretch as days and hours', () => {
    expect(summarizeWeek(sunToThu, dayName)).toBe('Sun–Thu 09:00–17:00');
    expect(summarizeWeek([day(), [], [], [], [], [], []], dayName)).toBe('Sun 09:00–17:00');
  });

  it('gives up on anything less regular', () => {
    expect(
      summarizeWeek(setRange(sunToThu, 2, 0, { start: '10:00', end: '17:00' }), dayName),
    ).toBeNull();
    expect(summarizeWeek([day(), [], day(), [], [], [], []], dayName)).toBeNull();
  });
});

describe('labels', () => {
  it('names a zone with its offset', () => {
    expect(zoneLabel('Asia/Riyadh')).toBe('Asia/Riyadh (GMT+03:00)');
    expect(zoneLabel('UTC')).toBe('UTC (GMT+00:00)');
  });

  it('prints a holiday as one day, a stretch in a month, or across months', () => {
    expect(holidayDates('2027-02-22', '2027-02-22', 'en')).toBe('22 Feb 2027');
    expect(holidayDates('2027-03-09', '2027-03-11', 'en')).toBe('9–11 Mar 2027');
    expect(holidayDates('2027-03-30', '2027-04-02', 'en')).toBe('30 Mar 2027 – 2 Apr 2027');
    expect(holidayDates('2027-02-22', '2027-02-22', 'ar')).toMatch(/22/);
  });
});
