import {
  alwaysOpenCalendar,
  type BusinessCalendar,
  defaultWeeklyHours,
  widgetConversationHoursSchema,
} from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { calendarHours } from './widget-hours.js';

const SATURDAY_NOON = new Date('2026-09-26T12:00:00.000Z');

const weekdays = (timezone: string): BusinessCalendar => ({
  timezone,
  weekly: defaultWeeklyHours(),
  holidays: [],
});

describe('calendarHours', () => {
  it('names the next opening in the calendar’s own zone while closed', () => {
    // Friday 20:40 in Dubai, after the 17:00 close; the week opens again on Monday 09:00 (05:00Z).
    const hours = calendarHours(weekdays('Asia/Dubai'), new Date('2026-09-25T16:40:00.000Z'));

    expect(hours).toEqual({
      open: false,
      nextOpenAt: '2026-09-28T05:00:00.000Z',
      timezone: 'Asia/Dubai',
    });
    expect(widgetConversationHoursSchema.parse(hours)).toEqual(hours);
  });

  it('has no opening to name while open', () => {
    expect(calendarHours(weekdays('UTC'), new Date('2026-09-24T10:00:00.000Z'))).toEqual({
      open: true,
      nextOpenAt: null,
      timezone: 'UTC',
    });
  });

  it('counts the default Monday-to-Friday week as closed on a Saturday', () => {
    expect(calendarHours(weekdays('Asia/Riyadh'), SATURDAY_NOON)).toEqual({
      open: false,
      nextOpenAt: '2026-09-28T06:00:00.000Z',
      timezone: 'Asia/Riyadh',
    });
  });

  it('is open with no opening for 24/7 hours, which is a matter of presence and not of hours', () => {
    expect(calendarHours(alwaysOpenCalendar('Europe/Berlin'), SATURDAY_NOON)).toEqual({
      open: true,
      nextOpenAt: null,
      timezone: 'Europe/Berlin',
    });
  });

  it('is closed with a null opening for a calendar that never opens', () => {
    const everyDayClosed: BusinessCalendar = {
      timezone: 'UTC',
      weekly: [[], [], [], [], [], [], []],
      holidays: [],
    };

    expect(calendarHours(everyDayClosed, SATURDAY_NOON)).toEqual({
      open: false,
      nextOpenAt: null,
      timezone: 'UTC',
    });
  });

  it('skips a holiday when it names the opening', () => {
    const holiday = { startsOn: '2026-09-28', endsOn: '2026-09-28' };

    expect(
      calendarHours({ ...weekdays('UTC'), holidays: [holiday] }, SATURDAY_NOON).nextOpenAt,
    ).toBe('2026-09-29T09:00:00.000Z');
  });
});
