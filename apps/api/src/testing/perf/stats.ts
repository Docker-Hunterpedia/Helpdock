/**
 * Latency percentiles for the performance gate (DOMAIN-RULES §14: "p95
 * reported").
 *
 * Nearest-rank, not interpolated: the p95 of a run is a latency some request
 * actually had, which is the number a reader can reproduce by sorting the
 * samples and counting.
 */

export interface LatencySummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** The `p`th percentile (0 < p ≤ 100) of samples that are already sorted ascending. */
export const percentile = (sorted: readonly number[], p: number): number => {
  if (!(p > 0 && p <= 100)) {
    throw new RangeError(`A percentile is between 0 (exclusive) and 100, not ${p}`);
  }

  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] ?? Number.NaN;
};

export const summarise = (samples: readonly number[]): LatencySummary => {
  const sorted = [...samples].sort((a, b) => a - b);

  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? Number.NaN,
  };
};
