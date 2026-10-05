import type { ReportSummary, SlaOutcome } from '@helpdock/schemas';
import type { AgentRow, DayRow } from './reports.repository.js';
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

/** The average rating from the sum of ratings and how many there were; null for none. */
export const csatAverage = (points: number, responses: number): number | null =>
  responses === 0 ? null : points / responses;

/** One Agent workload row as the summary carries it. */
export const agentSummary = (row: AgentRow): ReportSummary['agents'][number] => ({
  agentId: row.agentId,
  name: row.name,
  replies: row.replies,
  resolved: row.resolved,
  assignedOpen: row.assignedOpen,
  firstResponse: row.firstResponse,
  resolution: row.resolution,
  sla: slaOutcome(row.slaMet, row.slaBreached),
  csat: {
    responses: row.csatResponses,
    average: csatAverage(row.csatPoints, row.csatResponses),
  },
});
