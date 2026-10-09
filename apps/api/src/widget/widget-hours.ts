import {
  type BusinessCalendar,
  isWithinBusinessHours,
  nextOpening,
  type WidgetConversationHours,
} from '@helpdock/schemas';

/**
 * Whether a calendar is open at `now`, and if not when it next is (M7-06).
 * The one place that decides it: the brand's availability and a
 * conversation's hours both come from here, so the header's "Back Monday" and
 * the handoff line can never be judged by different rules.
 *
 * `nextOpenAt` is null while open, and for a calendar that never opens (every
 * day closed, or holidays past the ten-year horizon of `nextOpening`).
 */
export const calendarHours = (calendar: BusinessCalendar, now: Date): WidgetConversationHours => {
  const open = isWithinBusinessHours(calendar, now);

  return {
    open,
    nextOpenAt: open ? null : (nextOpening(calendar, now)?.toISOString() ?? null),
    timezone: calendar.timezone,
  };
};
