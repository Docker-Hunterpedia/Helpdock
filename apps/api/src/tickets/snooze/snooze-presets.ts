import {
  type BusinessCalendar,
  localDayNumber,
  localTimeToUtc,
  nextOpening,
  type SnoozePresetKey,
  weekdayOfDay,
} from '@helpdock/schemas';

/**
 * The four items of the Snooze menu as instants (M14-02):
 *
 * | Preset | When |
 * |---|---|
 * | In 1 hour, In 4 hours | the minute they are asked, plus the hours |
 * | Next business day | the next opening of the department calendar after today ends; else 09:00 tomorrow in the agent's zone |
 * | Next week | the first opening after the calendar's coming weekend, so Sunday in Asia/Riyadh and Monday in Europe/Berlin; else Monday 09:00 in the agent's zone |
 *
 * The coming weekend is the run of weekdays with no opening hours at all, from
 * the first such day on or after today. Holidays are not weekends, but
 * {@link nextOpening} skips them when it looks for the opening.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const NINE_AM = 9 * 60;
const MONDAY = 1;

export interface PresetInput {
  readonly now: Date;
  /** The agent's IANA zone: the fallback when the department has no hours of its own. */
  readonly agentTimeZone: string;
  /** The department's business calendar, or `null` when nobody has configured hours. */
  readonly calendar: BusinessCalendar | null;
}

const wholeMinute = (at: Date): Date => new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);

const closedWeekdays = (calendar: BusinessCalendar): ReadonlySet<number> =>
  new Set(calendar.weekly.flatMap((ranges, weekday) => (ranges.length === 0 ? [weekday] : [])));

/** The day after the coming weekend, or the next Monday when every weekday is open. */
const dayAfterWeekend = (today: number, closed: ReadonlySet<number>): number => {
  if (closed.size === 0 || closed.size === 7) {
    return today + (((MONDAY - weekdayOfDay(today) + 6) % 7) + 1);
  }

  let day = today;
  while (!closed.has(weekdayOfDay(day))) {
    day += 1;
  }
  while (closed.has(weekdayOfDay(day))) {
    day += 1;
  }

  return day;
};

export const snoozePresets = ({
  now,
  agentTimeZone,
  calendar,
}: PresetInput): Record<SnoozePresetKey, Date> => {
  const start = wholeMinute(now);
  const timeZone = calendar?.timezone ?? agentTimeZone;
  const today = localDayNumber(timeZone, now);
  const tomorrowAtNine = localTimeToUtc(timeZone, today + 1, NINE_AM);

  const closed = calendar === null ? new Set<number>() : closedWeekdays(calendar);
  const weekStart = dayAfterWeekend(today, closed);
  const opening = (day: number, fallback: Date): Date =>
    (calendar === null ? null : nextOpening(calendar, localTimeToUtc(timeZone, day, 0))) ??
    fallback;

  return {
    in_1_hour: new Date(start.getTime() + HOUR_MS),
    in_4_hours: new Date(start.getTime() + 4 * HOUR_MS),
    next_business_day: opening(today + 1, tomorrowAtNine),
    next_week: opening(weekStart, localTimeToUtc(timeZone, weekStart, NINE_AM)),
  };
};

/**
 * One preset as an instant: what a `snooze` action of a rule or a macro is
 * resolved to (#368). The same maths as {@link snoozePresets}, so a rule and
 * the menu offer the same wake time for the same moment and calendar.
 */
export const snoozePresetAt = (input: PresetInput & { readonly preset: SnoozePresetKey }): Date =>
  snoozePresets(input)[input.preset];
