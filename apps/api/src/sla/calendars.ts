import { alwaysOpenCalendar, type BusinessCalendar, defaultWeeklyHours } from '@helpdock/schemas';
import type { CalendarRows } from './sla.repository.js';
import type { CalendarFor } from './ticket-clocks.js';

/**
 * Which calendar a clock counts in (DOMAIN-RULES §3.1): "the business hours of
 * the ticket's department (falling back to the brand's), skipping holidays".
 *
 * - A department with its own hours uses them, in its own zone.
 * - Otherwise the brand's hours, in the brand's zone — or, before anybody has
 *   saved them, `defaultWeeklyHours`.
 * - Holidays for every department apply everywhere; a department's own apply
 *   to it alone. Each is a whole day in the zone of the hours it applies to.
 * - A policy counting "calendar hours" ignores all of that and counts every
 *   minute; only the zone is kept, for display.
 */
export const buildCalendars =
  (rows: CalendarRows): CalendarFor =>
  (timeMode, departmentId) => {
    const override = rows.overrides.get(departmentId);
    const timezone = override?.timezone ?? rows.brandTimezone;
    if (timeMode === 'calendar') {
      return alwaysOpenCalendar(timezone);
    }

    return {
      timezone,
      weekly: override?.weekly ?? rows.brandWeekly ?? defaultWeeklyHours(),
      holidays: rows.holidays.filter(
        (holiday) => holiday.departmentId === null || holiday.departmentId === departmentId,
      ),
    };
  };

/** The brand's own calendar: its hours and the holidays that close every department. */
export const brandCalendar = (rows: CalendarRows): BusinessCalendar => ({
  timezone: rows.brandTimezone,
  weekly: rows.brandWeekly ?? defaultWeeklyHours(),
  holidays: rows.holidays.filter((holiday) => holiday.departmentId === null),
});
