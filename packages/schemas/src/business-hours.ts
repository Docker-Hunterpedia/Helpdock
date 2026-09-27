import { z } from 'zod';
import { timezoneSchema } from './brand.js';

/**
 * Business hours, holidays and time zones (M3-01, REQUIREMENTS §4.2), and the
 * arithmetic DOMAIN-RULES §3 counts SLA time with.
 *
 * Two halves live in this file on purpose. The schemas are what the api and the
 * admin exchange; the functions at the bottom are what the SLA engine, the
 * email channel's out-of-hours notice and the rules engine's "business hours"
 * condition all compute with. They sit in `@helpdock/schemas` rather than in the
 * api because the admin previews the same numbers the api stores, and a second
 * spelling of "when is this brand open?" would be a second answer.
 *
 * Everything is a pure function of a {@link BusinessCalendar} and instants. No
 * date library: `Intl.DateTimeFormat` already knows every IANA zone and its
 * daylight-saving rules, which is the only hard part.
 */

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

/** `HH:MM` on a 24-hour clock; `24:00` is allowed as an end, meaning midnight. */
export const clockTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'must be HH:MM between 00:00 and 24:00');

export const MAX_RANGES_PER_DAY = 4;

/** One open stretch of a day, `start` inclusive and `end` exclusive. */
export const timeRangeSchema = z
  .object({ start: clockTimeSchema, end: clockTimeSchema })
  .refine((range) => minuteOfDay(range.start) < minuteOfDay(range.end), {
    message: 'The range ends before it starts',
    path: ['end'],
  });
export type TimeRange = z.infer<typeof timeRangeSchema>;

const dayRangesSchema = z
  .array(timeRangeSchema)
  .max(MAX_RANGES_PER_DAY)
  .refine(
    (ranges) =>
      [...ranges]
        .sort((a, b) => minuteOfDay(a.start) - minuteOfDay(b.start))
        .every((range, index, sorted) => {
          const next = sorted[index + 1];
          return next === undefined || minuteOfDay(range.end) <= minuteOfDay(next.start);
        }),
    'Two ranges of one day overlap',
  );

/**
 * A week, Sunday first: index 0 is Sunday and 6 is Saturday, which is also what
 * `Date.prototype.getUTCDay` returns. An empty day is closed all day.
 */
export const weeklyHoursSchema = z
  .array(dayRangesSchema)
  .length(7)
  .refine(
    (days) => days.some((ranges) => ranges.length > 0),
    'A week needs at least one open range',
  );
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

/** A zone and a week: the brand's own hours, or one department's override. */
export const businessHoursSchema = z.object({
  timezone: timezoneSchema,
  weekly: weeklyHoursSchema,
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

/** `YYYY-MM-DD`. A holiday is a whole day in the zone of the hours it applies to. */
export const HOLIDAY_NAME_MAX = 120;
/** A year is generous for a closure, and it keeps the calendar walk bounded. */
export const MAX_HOLIDAY_DAYS = 366;

export const holidaySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** First day closed. */
  startsOn: z.iso.date(),
  /** Last day closed, inclusive. Equal to `startsOn` for a single day. */
  endsOn: z.iso.date(),
  /** Null: every department of the brand. */
  departmentId: z.uuid().nullable(),
});
export type Holiday = z.infer<typeof holidaySchema>;

export const holidayCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(HOLIDAY_NAME_MAX),
    startsOn: z.iso.date(),
    /** Optional: a single day when left out. */
    endsOn: z.iso.date().optional(),
    departmentId: z.uuid().nullable().default(null),
  })
  .refine((value) => value.endsOn === undefined || value.endsOn >= value.startsOn, {
    message: 'The last day is before the first',
    path: ['endsOn'],
  })
  .refine(
    (value) =>
      value.endsOn === undefined || daysBetween(value.startsOn, value.endsOn) <= MAX_HOLIDAY_DAYS,
    { message: 'A holiday lasts a year at most', path: ['endsOn'] },
  );
export type HolidayCreateRequest = z.input<typeof holidayCreateRequestSchema>;

export const holidayParamSchema = z.object({ brandId: z.uuid(), holidayId: z.uuid() });
export type HolidayParam = z.infer<typeof holidayParamSchema>;

/** One department's row on the Business hours tab. */
export const departmentHoursSchema = z.object({
  departmentId: z.uuid(),
  name: z.string(),
  nameAr: z.string().nullable(),
  /** Null: the department follows the brand's hours and zone. */
  override: businessHoursSchema.nullable(),
});
export type DepartmentHours = z.infer<typeof departmentHoursSchema>;

/** `GET /api/brands/:brandId/business-hours`: the whole tab in one read. */
export const businessHoursOverviewSchema = z.object({
  brand: businessHoursSchema,
  departments: z.array(departmentHoursSchema),
  holidays: z.array(holidaySchema),
  /** Tickets whose clocks are counting, which is what a save recomputes. */
  runningTickets: z.int().nonnegative(),
});
export type BusinessHoursOverview = z.infer<typeof businessHoursOverviewSchema>;

/**
 * `PUT /api/brands/:brandId/business-hours`: the tab's Save. The brand's hours
 * and every override are sent together because the screen saves them together,
 * and a half-sent list would silently drop the override it left out.
 */
export const businessHoursUpdateRequestSchema = z.object({
  brand: businessHoursSchema,
  departments: z
    .array(z.object({ departmentId: z.uuid(), override: businessHoursSchema.nullable() }))
    .max(500),
});
export type BusinessHoursUpdateRequest = z.infer<typeof businessHoursUpdateRequestSchema>;

/**
 * What a brand counts in before anybody has saved its hours: Monday to Friday,
 * 09:00–17:00, in the brand's zone. A guess, but the commonest one, and the
 * Business hours tab shows it as the starting point to change.
 */
export const defaultWeeklyHours = (): WeeklyHours => {
  const day = (): TimeRange[] => [{ start: '09:00', end: '17:00' }];

  return [[], day(), day(), day(), day(), day(), []];
};

// --------------------------------------------------------------------------
// The calendar the functions compute with
// --------------------------------------------------------------------------

/**
 * What {@link isWithinBusinessHours} and {@link addBusinessTime} read.
 * `alwaysOpen` is the "Calendar hours" of an SLA policy: every minute counts,
 * holidays included, and `weekly` is ignored.
 */
export interface BusinessCalendar {
  readonly timezone: string;
  readonly weekly: WeeklyHours;
  /** Closed days as `YYYY-MM-DD` ranges, inclusive, in {@link timezone}. */
  readonly holidays: readonly { readonly startsOn: string; readonly endsOn: string }[];
  readonly alwaysOpen?: boolean;
}

/** Every minute of every day: the "Calendar hours" of a policy. */
export const alwaysOpenCalendar = (timezone: string): BusinessCalendar => ({
  timezone,
  weekly: [[], [], [], [], [], [], []],
  holidays: [],
  alwaysOpen: true,
});

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/**
 * How far the walk looks before it gives up. Ten years of closed days is a
 * calendar that will never open, and "never due" is a better answer than a
 * loop that does not end.
 */
const HORIZON_DAYS = 3_660;

// --------------------------------------------------------------------------
// Public functions
// --------------------------------------------------------------------------

/** Whether `at` falls inside an open range of the calendar, holidays excluded. */
export const isWithinBusinessHours = (calendar: BusinessCalendar, at: Date): boolean => {
  if (calendar.alwaysOpen === true) {
    return true;
  }

  const t = at.getTime();
  const date = localDateOf(calendar.timezone, t);

  return openIntervalsOn(calendar, addDays(date, -1))
    .concat(openIntervalsOn(calendar, date))
    .some(([start, end]) => start <= t && t < end);
};

/**
 * The instant `minutes` of business time after `from`. A clock started outside
 * the hours begins counting at the next opening (DOMAIN-RULES §3.1). Returns
 * `from` for zero or less, and `null` for a calendar that never opens.
 *
 * Fractional minutes are honoured, so a clock with seconds left is due to the
 * second rather than rounded to a minute it has not reached.
 */
export const addBusinessTime = (
  calendar: BusinessCalendar,
  from: Date,
  minutes: number,
): Date | null => {
  const ms = addBusinessMs(calendar, from.getTime(), minutes * MINUTE_MS);

  return ms === null ? null : new Date(ms);
};

/** Milliseconds of business time between two instants; zero when `to` is not after `from`. */
export const businessMsBetween = (calendar: BusinessCalendar, from: Date, to: Date): number => {
  const start = from.getTime();
  const end = to.getTime();
  if (end <= start) {
    return 0;
  }
  if (calendar.alwaysOpen === true) {
    return end - start;
  }

  let total = 0;
  const last = localDateOf(calendar.timezone, end);
  for (let date = addDays(localDateOf(calendar.timezone, start), -1); date <= last; ) {
    for (const [open, close] of openIntervalsOn(calendar, date)) {
      total += Math.max(0, Math.min(close, end) - Math.max(open, start));
    }
    date = addDays(date, 1);
  }

  return total;
};

/** The first open instant at or after `at`, or `null` for a calendar that never opens. */
export const nextOpening = (calendar: BusinessCalendar, at: Date): Date | null => {
  const ms = addBusinessMs(calendar, at.getTime(), 0, true);

  return ms === null ? null : new Date(ms);
};

// --------------------------------------------------------------------------
// The walk
// --------------------------------------------------------------------------

const addBusinessMs = (
  calendar: BusinessCalendar,
  from: number,
  amount: number,
  findOpening = false,
): number | null => {
  if (calendar.alwaysOpen === true) {
    return from + Math.max(0, amount);
  }
  if (amount <= 0 && !findOpening) {
    return from;
  }

  let remaining = amount;
  let date = addDays(localDateOf(calendar.timezone, from), -1);
  for (let day = 0; day < HORIZON_DAYS; day += 1) {
    for (const [open, close] of openIntervalsOn(calendar, date)) {
      if (close <= from) {
        continue;
      }
      const start = Math.max(open, from);
      if (findOpening) {
        return start;
      }
      const available = close - start;
      if (remaining <= available) {
        return start + remaining;
      }
      remaining -= available;
    }
    date = addDays(date, 1);
  }

  return null;
};

/** A calendar date with no zone attached, as days since 1970-01-01. */
type LocalDate = number;

const addDays = (date: LocalDate, days: number): LocalDate => date + days;

/**
 * The open intervals of one local date, as UTC milliseconds, in order. A
 * holiday closes the whole date; otherwise the weekday's ranges apply.
 */
const openIntervalsOn = (calendar: BusinessCalendar, date: LocalDate): [number, number][] => {
  const iso = isoOf(date);
  if (calendar.holidays.some(({ startsOn, endsOn }) => startsOn <= iso && iso <= endsOn)) {
    return [];
  }

  const weekday = new Date(date * DAY_MS).getUTCDay();
  const ranges = calendar.weekly[weekday] ?? [];

  return ranges
    .map((range): [number, number] => [
      zonedToUtc(calendar.timezone, date, minuteOfDay(range.start)),
      zonedToUtc(calendar.timezone, date, minuteOfDay(range.end)),
    ])
    .filter(([open, close]) => open < close)
    .sort((a, b) => a[0] - b[0]);
};

/** `09:30` → 570. */
export const minuteOfDay = (time: string): number => {
  const [hours = '0', minutes = '0'] = time.split(':');

  return Number(hours) * 60 + Number(minutes);
};

const isoOf = (date: LocalDate): string => new Date(date * DAY_MS).toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

// --------------------------------------------------------------------------
// Zones
// --------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timezone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, formatter);
  }

  return formatter;
};

/** The wall clock in `timezone` at instant `t`, read back as if it were UTC. */
const wallClockAsUtc = (timezone: string, t: number): number => {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(t))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }

  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
};

/** The zone's offset from UTC at instant `t`, in milliseconds (Riyadh: +3 h). */
const offsetAt = (timezone: string, t: number): number =>
  wallClockAsUtc(timezone, Math.floor(t / 1000) * 1000) - Math.floor(t / 1000) * 1000;

const localDateOf = (timezone: string, t: number): LocalDate =>
  Math.floor(wallClockAsUtc(timezone, t) / DAY_MS);

/**
 * The instant a wall-clock time on a local date happens in `timezone`. A time
 * skipped by a daylight-saving jump resolves to the instant just after the
 * jump, and a repeated one to its first occurrence — the usual reading, and the
 * one that never loses an open minute.
 */
const zonedToUtc = (timezone: string, date: LocalDate, minute: number): number => {
  const wall = date * DAY_MS + minute * MINUTE_MS;
  const first = wall - offsetAt(timezone, wall);
  const second = wall - offsetAt(timezone, first);

  return Math.min(first, second);
};
