import type {
  BusinessHours,
  BusinessHoursOverview,
  BusinessHoursUpdateRequest,
  TimeRange,
  WeeklyHours,
} from '@helpdock/schemas';
import { minuteOfDay } from '@helpdock/schemas';

/**
 * The Business hours tab's form state (M3-01, `Admin/Ticketing-BusinessHours`)
 * and the small decisions about it, kept out of the components so they can be
 * tested without rendering.
 *
 * A week is Sunday first, index 0 to 6, as `weeklyHoursSchema` stores it.
 */

export interface HoursDraft {
  readonly brand: BusinessHours;
  /** Keyed by department; `null` follows the brand. */
  readonly overrides: Readonly<Record<string, BusinessHours | null>>;
}

export const WEEKDAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export const draftOf = (overview: BusinessHoursOverview): HoursDraft => ({
  brand: overview.brand,
  overrides: Object.fromEntries(
    overview.departments.map((department) => [department.departmentId, department.override]),
  ),
});

export const requestOf = (draft: HoursDraft): BusinessHoursUpdateRequest => ({
  brand: draft.brand,
  departments: Object.entries(draft.overrides).map(([departmentId, override]) => ({
    departmentId,
    override,
  })),
});

export const sameDraft = (a: HoursDraft, b: HoursDraft): boolean =>
  JSON.stringify(requestOf(a)) === JSON.stringify(requestOf(b));

/** "The range ends before it starts": the one mistake a range can have on its own. */
export const rangeBackwards = (range: TimeRange): boolean =>
  minuteOfDay(range.start) >= minuteOfDay(range.end);

/** The first day of a week whose ranges cannot be saved, or `null`. */
export const firstInvalidDay = (weekly: WeeklyHours): number | null => {
  for (const [day, ranges] of weekly.entries()) {
    const sorted = [...ranges].sort((a, b) => minuteOfDay(a.start) - minuteOfDay(b.start));
    const overlaps = sorted.some((range, index) => {
      const next = sorted[index + 1];
      return next !== undefined && minuteOfDay(range.end) > minuteOfDay(next.start);
    });
    if (ranges.some(rangeBackwards) || overlaps) {
      return day;
    }
  }
  return null;
};

export const weekIsClosed = (weekly: WeeklyHours): boolean =>
  weekly.every((ranges) => ranges.length === 0);

/** What stops the Save, with where it is, or `null` when nothing does. */
export type DraftProblem =
  | { readonly kind: 'range'; readonly day: number; readonly departmentId: string | null }
  | { readonly kind: 'closed'; readonly departmentId: string | null };

export const problemOf = (draft: HoursDraft): DraftProblem | null => {
  const weeks: [string | null, WeeklyHours][] = [
    [null, draft.brand.weekly],
    ...Object.entries(draft.overrides).flatMap(([departmentId, override]) =>
      override === null ? [] : [[departmentId, override.weekly] as [string, WeeklyHours]],
    ),
  ];

  for (const [departmentId, weekly] of weeks) {
    const day = firstInvalidDay(weekly);
    if (day !== null) {
      return { kind: 'range', day, departmentId };
    }
    if (weekIsClosed(weekly)) {
      return { kind: 'closed', departmentId };
    }
  }
  return null;
};

/** One day switched open (with a working day's range) or closed. */
export const setDayOpen = (weekly: WeeklyHours, day: number, open: boolean): WeeklyHours =>
  weekly.map((ranges, index) =>
    index !== day ? ranges : open ? [{ start: '09:00', end: '17:00' }] : [],
  );

export const setRange = (
  weekly: WeeklyHours,
  day: number,
  index: number,
  range: TimeRange,
): WeeklyHours =>
  weekly.map((ranges, current) =>
    current !== day ? ranges : ranges.map((existing, at) => (at === index ? range : existing)),
  );

export const removeRange = (weekly: WeeklyHours, day: number, index: number): WeeklyHours =>
  weekly.map((ranges, current) =>
    current !== day ? ranges : ranges.filter((_range, at) => at !== index),
  );

/** A second range starts an hour after the last one ends, capped at midnight. */
export const addRange = (weekly: WeeklyHours, day: number): WeeklyHours =>
  weekly.map((ranges, current) => {
    if (current !== day) {
      return ranges;
    }
    const last = ranges.at(-1);
    const start = last === undefined ? 9 * 60 : Math.min(minuteOfDay(last.end) + 60, 23 * 60);
    return [...ranges, { start: clock(start), end: clock(Math.min(start + 60, 24 * 60)) }];
  });

/** "Copy Sunday to weekdays": Sunday's ranges onto every other day that is open. */
export const copyFirstDayToOpenDays = (weekly: WeeklyHours): WeeklyHours => {
  const first = weekly[0] ?? [];
  return weekly.map((ranges, day) =>
    day === 0 || ranges.length === 0 ? ranges : first.map((range) => ({ ...range })),
  );
};

const clock = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * "Sun–Thu 09:00–17:00" for a week whose open days run in one stretch with the
 * same ranges; `null` for anything less regular, which the row then calls
 * "custom hours".
 */
export const summarizeWeek = (
  weekly: WeeklyHours,
  dayName: (day: number) => string,
): string | null => {
  const open = weekly.flatMap((ranges, day) => (ranges.length === 0 ? [] : [day]));
  const first = open[0];
  const last = open.at(-1);
  if (first === undefined || last === undefined || last - first + 1 !== open.length) {
    return null;
  }
  const signature = JSON.stringify(weekly[first]);
  if (open.some((day) => JSON.stringify(weekly[day]) !== signature)) {
    return null;
  }
  const ranges = (weekly[first] ?? []).map((range) => `${range.start}–${range.end}`).join(', ');
  const days = first === last ? dayName(first) : `${dayName(first)}–${dayName(last)}`;
  return `${days} ${ranges}`;
};

/** "Asia/Riyadh (GMT+03:00)". */
export const zoneLabel = (timezone: string, at: Date = new Date()): string => {
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  return `${timezone} (${offset === 'GMT' ? 'GMT+00:00' : offset})`;
};

/** Every zone the browser and the api both know, with `UTC` first. */
export const timeZoneOptions = (): readonly string[] => [
  'UTC',
  ...Intl.supportedValuesOf('timeZone').filter((zone) => zone !== 'UTC'),
];

/**
 * A holiday's dates as the table prints them: `22 Feb 2027`, and `9–11 Mar
 * 2027` for a stretch inside one month. Latin digits in both locales (DESIGN §7).
 */
export const holidayDates = (startsOn: string, endsOn: string, locale: 'en' | 'ar'): string => {
  const format = (iso: string, options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
      ...options,
      timeZone: 'UTC',
    }).format(new Date(`${iso}T00:00:00Z`));

  const full = { day: 'numeric', month: 'short', year: 'numeric' } as const;
  if (startsOn === endsOn) {
    return format(startsOn, full);
  }
  if (startsOn.slice(0, 7) === endsOn.slice(0, 7)) {
    return `${format(startsOn, { day: 'numeric' })}–${format(endsOn, full)}`;
  }
  return `${format(startsOn, full)} – ${format(endsOn, full)}`;
};
