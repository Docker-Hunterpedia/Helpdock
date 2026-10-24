import type { BusinessCalendar, SnoozePresetKey, WeeklyHours } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { snoozePresetAt, snoozePresets } from './snooze-presets.js';

const range = (start: string, end: string) => [{ start, end }];

/** Sunday to Saturday. */
const week = (days: readonly boolean[]): WeeklyHours =>
  days.map((open) => (open ? range('09:00', '17:00') : [])) as unknown as WeeklyHours;

/** Open Monday to Friday, closed Saturday and Sunday. */
const berlin: BusinessCalendar = {
  timezone: 'Europe/Berlin',
  weekly: week([false, true, true, true, true, true, false]),
  holidays: [],
};

/** Open Sunday to Thursday, closed Friday and Saturday. */
const riyadh: BusinessCalendar = {
  timezone: 'Asia/Riyadh',
  weekly: week([true, true, true, true, true, false, false]),
  holidays: [],
};

const iso = (date: Date) => date.toISOString();

describe('snoozePresets', () => {
  it('adds one and four hours to the minute it was asked', () => {
    const presets = snoozePresets({
      now: new Date('2026-10-21T10:07:42Z'),
      agentTimeZone: 'UTC',
      calendar: berlin,
    });

    expect(iso(presets.in_1_hour)).toBe('2026-10-21T11:07:00.000Z');
    expect(iso(presets.in_4_hours)).toBe('2026-10-21T14:07:00.000Z');
  });

  it('opens Berlin next on Thursday morning after a Wednesday afternoon, and next week on Monday', () => {
    // Wednesday 21 Oct 2026, 15:00 in Berlin (CEST, +2 until 25 Oct).
    const presets = snoozePresets({
      now: new Date('2026-10-21T13:00:00Z'),
      agentTimeZone: 'UTC',
      calendar: berlin,
    });

    expect(iso(presets.next_business_day)).toBe('2026-10-22T07:00:00.000Z');
    expect(iso(presets.next_week)).toBe('2026-10-26T08:00:00.000Z');
  });

  it('lands next week on Sunday in Riyadh', () => {
    // Monday 19 Oct 2026, 12:00 in Riyadh (+3).
    const presets = snoozePresets({
      now: new Date('2026-10-19T09:00:00Z'),
      agentTimeZone: 'Europe/Berlin',
      calendar: riyadh,
    });

    expect(iso(presets.next_business_day)).toBe('2026-10-20T06:00:00.000Z');
    expect(iso(presets.next_week)).toBe('2026-10-25T06:00:00.000Z');
  });

  it('skips the weekend for the next business day on a Friday in Berlin', () => {
    // Friday 23 Oct 2026, 16:00 in Berlin.
    const presets = snoozePresets({
      now: new Date('2026-10-23T14:00:00Z'),
      agentTimeZone: 'UTC',
      calendar: berlin,
    });

    expect(iso(presets.next_business_day)).toBe('2026-10-26T08:00:00.000Z');
    expect(iso(presets.next_week)).toBe('2026-10-26T08:00:00.000Z');
  });

  it('follows the clocks going back in Berlin', () => {
    // Saturday 24 Oct 2026; DST ends on Sunday 25 Oct, so Monday opens at 08:00 UTC+1.
    const presets = snoozePresets({
      now: new Date('2026-10-24T10:00:00Z'),
      agentTimeZone: 'UTC',
      calendar: berlin,
    });

    expect(iso(presets.next_business_day)).toBe('2026-10-26T08:00:00.000Z');
  });

  it('skips a holiday when looking for the opening', () => {
    const holiday: BusinessCalendar = {
      ...berlin,
      holidays: [{ startsOn: '2026-10-22', endsOn: '2026-10-22' }],
    };
    const presets = snoozePresets({
      now: new Date('2026-10-21T13:00:00Z'),
      agentTimeZone: 'UTC',
      calendar: holiday,
    });

    expect(iso(presets.next_business_day)).toBe('2026-10-23T07:00:00.000Z');
  });

  it('falls back to 09:00 tomorrow and next Monday in the agent zone without a calendar', () => {
    // Wednesday 21 Oct 2026, 23:30 in Riyadh is already Thursday 02:30 UTC... use 20:30 UTC.
    const presets = snoozePresets({
      now: new Date('2026-10-21T20:30:00Z'),
      agentTimeZone: 'Asia/Riyadh',
      calendar: null,
    });

    // 21 Oct 23:30 in Riyadh, so tomorrow is Thursday 22 Oct, 09:00 +3.
    expect(iso(presets.next_business_day)).toBe('2026-10-22T06:00:00.000Z');
    expect(iso(presets.next_week)).toBe('2026-10-26T06:00:00.000Z');
  });

  it('uses the next Monday when the calendar is open every day', () => {
    const always: BusinessCalendar = {
      timezone: 'UTC',
      weekly: week([true, true, true, true, true, true, true]),
      holidays: [],
    };
    const presets = snoozePresets({
      now: new Date('2026-10-21T10:00:00Z'),
      agentTimeZone: 'UTC',
      calendar: always,
    });

    expect(iso(presets.next_week)).toBe('2026-10-26T09:00:00.000Z');
  });

  it('falls back when the calendar never opens', () => {
    const closed: BusinessCalendar = {
      timezone: 'UTC',
      weekly: week([false, false, false, false, false, false, false]),
      holidays: [],
    };
    const presets = snoozePresets({
      now: new Date('2026-10-21T10:00:00Z'),
      agentTimeZone: 'UTC',
      calendar: closed,
    });

    expect(iso(presets.next_business_day)).toBe('2026-10-22T09:00:00.000Z');
    expect(iso(presets.next_week)).toBe('2026-10-26T09:00:00.000Z');
  });
});

describe('snoozePresetAt', () => {
  // What a rule's or a macro's `snooze` action is resolved to (#368): the same
  // maths as the menu, so each preset is the menu's own instant.
  const input = {
    now: new Date('2026-10-21T13:00:00Z'),
    agentTimeZone: 'Asia/Riyadh',
    calendar: berlin,
  };

  it.each(['in_1_hour', 'in_4_hours', 'next_business_day', 'next_week'] as const)(
    'resolves %s to the menu instant',
    (preset: SnoozePresetKey) => {
      expect(iso(snoozePresetAt({ ...input, preset }))).toBe(iso(snoozePresets(input)[preset]));
    },
  );

  it('resolves next business day to Thursday morning after a Wednesday afternoon in Berlin', () => {
    expect(iso(snoozePresetAt({ ...input, preset: 'next_business_day' }))).toBe(
      '2026-10-22T07:00:00.000Z',
    );
  });
});
