import type { ReportSummary, SlaOutcome } from '@helpdock/schemas';
import type { DayRow } from './reports.repository.js';
import { daysOf } from './rollup-window.js';

/**
 * The arithmetic between the rollups and the report: shares, averages and
 * the days a range has no row for. Pure, so it is tested without a database.
 */

/** Met over every outcome, or null when nothing ended in the range. */
export const slaOutcome = (met: number, breached: number): SlaOutcome => ({
  met,
  breached,
  compliance: met + breached === 0 ? null : met / (met + breached),
});

/** The CSAT block from the counts of ratings 1 to 5. */
export const csatSummary = (counts: readonly number[]): ReportSummary['csat'] => {
  const distribution = counts.map((responses, index) => ({ rating: index + 1, responses }));
  const responses = counts.reduce((sum, value) => sum + value, 0);
  const points = distribution.reduce((sum, row) => sum + row.rating * row.responses, 0);
  const satisfied = distribution
    .filter((row) => row.rating >= 4)
    .reduce((sum, row) => sum + row.responses, 0);

  return {
    responses,
    average: responses === 0 ? null : points / responses,
    satisfied: responses === 0 ? null : satisfied / responses,
    distribution,
  };
};

/**
 * Every day of the range, with zeroes where the rollups have no row. A day
 * with no row had no ticket created, resolved or open — a rollup writes a row
 * for every slice that had any of them.
 */
export const fillDays = (from: string, to: string, rows: readonly DayRow[]): DayRow[] => {
  const byDay = new Map(rows.map((row) => [row.day, row]));

  return daysOf({ from, to }).map(
    (day) => byDay.get(day) ?? { day, created: 0, resolved: 0, backlog: 0 },
  );
};

/** Opened over searched, null when nothing was searched. */
export const openedRate = (opened: number, searches: number): number | null =>
  searches === 0 ? null : Math.min(1, opened / searches);
