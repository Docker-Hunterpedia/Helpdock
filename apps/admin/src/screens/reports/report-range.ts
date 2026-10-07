import { REPORT_MAX_DAYS, reportRangeDays } from '@helpdock/schemas';

/**
 * The date range of `Admin/Reports` (M8-04): ISO dates, inclusive at both
 * ends, read by the api as the brand's local days. The presets end today in
 * the reader's calendar, which for every brand but a far-away one is also the
 * brand's.
 */

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export const RANGE_PRESETS = [7, 30, 90] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const DEFAULT_PRESET: RangePreset = 30;

const DAY_MS = 86_400_000;

/** `2026-10-04` for the calendar day `date` falls on where the reader is. */
export const isoDay = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
};

/** `day` moved by `days`, in whole calendar days. */
export const shiftDay = (day: string, days: number): string =>
  new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);

/** The last `days` days, today included. */
export const presetRange = (days: number, today: Date = new Date()): DateRange => {
  const to = isoDay(today);

  return { from: shiftDay(to, -(days - 1)), to };
};

/** The same number of days immediately before, for "compared with". */
export const previousRange = (range: DateRange): DateRange => {
  const days = reportRangeDays(range.from, range.to);

  return { from: shiftDay(range.from, -days), to: shiftDay(range.from, -1) };
};

export const rangeDays = (range: DateRange): number => reportRangeDays(range.from, range.to);

/** A custom range the api would accept: in order, and at most a year and a day. */
export const isValidRange = (range: DateRange): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(range.from) &&
  /^\d{4}-\d{2}-\d{2}$/.test(range.to) &&
  range.from <= range.to &&
  rangeDays(range) <= REPORT_MAX_DAYS;

/** Every day of the range, in order, for a chart that must show the empty ones. */
export const daysOf = (range: DateRange): string[] =>
  Array.from({ length: rangeDays(range) }, (_unused, index) => shiftDay(range.from, index));
