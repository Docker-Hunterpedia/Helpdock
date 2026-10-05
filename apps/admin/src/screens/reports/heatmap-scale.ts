import type { ReportSummary } from '@helpdock/schemas';

/**
 * The Heatmap's six sequential steps (DESIGN §6.3): lower bounds spread over
 * the busiest hour, so the scale fits this range rather than a fixed guess.
 * Brands have no week-start setting, so rows run Monday to Sunday (ISO), the
 * order the api numbers them in.
 */

export const HEATMAP_STEPS = 6;
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

/** `[0, 4, 8, 14, 20, 28]`-style lower bounds, strictly increasing from 0. */
export const heatmapThresholds = (max: number): number[] => {
  const bounds = [0];
  for (let step = 1; step < HEATMAP_STEPS; step += 1) {
    const previous = bounds[step - 1] ?? 0;
    bounds.push(Math.max(previous + 1, Math.round((max * step) / HEATMAP_STEPS)));
  }
  return bounds;
};

/** Which step a count falls in: the last bound it reaches. */
export const stepOf = (count: number, thresholds: readonly number[]): number =>
  thresholds.reduce((found, bound, index) => (count >= bound ? index : found), 0);

/** Created tickets per weekday and hour, the cells the api left out as zero. */
export const heatmapGrid = (busiest: ReportSummary['busiestHours']): number[][] =>
  WEEKDAYS.map((weekday) =>
    HOURS.map(
      (hour) =>
        busiest.find((cell) => cell.weekday === weekday && cell.hour === hour)?.created ?? 0,
    ),
  );
