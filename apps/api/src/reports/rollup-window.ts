/**
 * Which local days one `stats.rollup` run rebuilds (M8-04). Pure, so the rules
 * can be read and tested without a database.
 *
 * - **The trailing week, every hour.** Most of what a report counts happens on
 *   the day it is counted — a ticket created, a reply sent — but a ticket
 *   marked spam, merged or deleted a few days later should drop out of the days
 *   it was counted in, so the last {@link TRAILING_DAYS} days are rebuilt each
 *   run rather than today alone.
 * - **Everything, once.** A brand with no rollups yet (an install upgraded to
 *   M8, or a brand whose history predates its first run), or with rollups built
 *   at an older grain (`REPORT_ROLLUP_VERSION`), is backfilled from its first
 *   ticket, at most {@link BACKFILL_MAX_DAYS} days back.
 * - **In chunks.** Each chunk is one transaction, so a backfill of a year is
 *   twelve short transactions rather than one long one.
 */

export const TRAILING_DAYS = 7;
export const BACKFILL_MAX_DAYS = 400;
export const CHUNK_DAYS = 31;

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of `now` on the brand's wall clock. */
export const localDay = (now: Date, timeZone: string): string =>
  // `en-CA` formats a date as ISO `YYYY-MM-DD`.
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

/** `day` moved by `days`, as calendar dates with no time zone involved. */
export const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export interface RollupWindowInput {
  /** The brand's today. */
  readonly today: string;
  /** Whether the brand has rollup rows, at the current grain. */
  readonly rolledUpBefore: boolean;
  /** The local day of the brand's first ticket, or null when it has none. */
  readonly firstActivityDay: string | null;
}

export interface DayRange {
  readonly from: string;
  readonly to: string;
}

/** The days to rebuild, oldest first. */
export const rollupWindow = ({
  today,
  rolledUpBefore,
  firstActivityDay,
}: RollupWindowInput): DayRange => {
  const trailing = addDays(today, -(TRAILING_DAYS - 1));
  if (rolledUpBefore || firstActivityDay === null || firstActivityDay >= trailing) {
    return { from: trailing, to: today };
  }

  const earliest = addDays(today, -(BACKFILL_MAX_DAYS - 1));
  return { from: firstActivityDay < earliest ? earliest : firstActivityDay, to: today };
};

/** `range` cut into consecutive chunks of at most {@link CHUNK_DAYS} days. */
export const chunkDays = (range: DayRange, size: number = CHUNK_DAYS): readonly DayRange[] => {
  const chunks: DayRange[] = [];
  for (let from = range.from; from <= range.to; from = addDays(from, size)) {
    const end = addDays(from, size - 1);
    chunks.push({ from, to: end < range.to ? end : range.to });
  }

  return chunks;
};

/** Every day of `range`, oldest first. */
export const daysOf = (range: DayRange): readonly string[] => {
  const days: string[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    days.push(day);
  }

  return days;
};
