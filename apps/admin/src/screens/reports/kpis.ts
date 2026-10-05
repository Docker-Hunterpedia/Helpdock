import { CSAT_RATING_MAX, CSAT_RATING_MIN, type ReportSummary } from '@helpdock/schemas';

/**
 * The arithmetic behind the KPI tiles and the SLA card of `Admin/Reports`
 * (M8-04). The comparison with the previous period is said in words by the
 * tile; this only decides which way it went and by how much.
 */

export type Direction = 'up' | 'down' | 'same';

/** Below this a change rounds to nothing on the tile, so it reads as unchanged. */
const SAME_EPSILON = 0.0005;

export const directionOf = (delta: number, epsilon = SAME_EPSILON): Direction => {
  if (Math.abs(delta) < epsilon) {
    return 'same';
  }
  return delta > 0 ? 'up' : 'down';
};

/** The change as a share of the previous value; null when there was nothing before. */
export const relativeChange = (current: number, previous: number): number | null =>
  previous === 0 ? null : (current - previous) / previous;

export interface SlaTotals {
  readonly met: number;
  readonly breached: number;
  /** Met over every clock that finished; null when none did. */
  readonly compliance: number | null;
}

/** Response and resolution clocks together: the headline "SLA met". */
export const slaTotals = (sla: ReportSummary['sla']): SlaTotals => {
  const met = sla.response.met + sla.resolution.met;
  const breached = sla.response.breached + sla.resolution.breached;

  return { met, breached, compliance: met + breached === 0 ? null : met / (met + breached) };
};

/**
 * Each rating's share of every answer, five stars first, with a rating
 * nobody gave drawn as an empty row rather than left out.
 */
export const csatShares = (
  distribution: ReportSummary['csat']['distribution'],
): { readonly rating: number; readonly responses: number; readonly share: number }[] => {
  const total = distribution.reduce((sum, row) => sum + row.responses, 0);

  return [CSAT_RATING_MAX, 4, 3, 2, CSAT_RATING_MIN].map((rating) => {
    const responses = distribution.find((row) => row.rating === rating)?.responses ?? 0;
    return { rating, responses, share: total === 0 ? 0 : responses / total };
  });
};
