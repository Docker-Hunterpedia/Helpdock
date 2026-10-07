/**
 * The numbers on `Admin/Reports`, formatted once so a tile, a chart's label
 * and its table cannot disagree. Latin digits in both languages (DESIGN §7).
 * Counts and dollars use the System page's formatters (`system/format.ts`).
 */

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_HOURS = 24;

/**
 * A duration the way the artboard prints one: `42m`, `3h 10m`, `2d 4h`.
 * Under a minute is `<1m`: a reply measured in seconds is not a figure a
 * support team acts on.
 */
export const formatDuration = (ms: number): string => {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 1) {
    return '<1m';
  }
  if (minutes < HOUR_MINUTES) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / HOUR_MINUTES);
  if (hours < DAY_HOURS) {
    const rest = minutes % HOUR_MINUTES;
    return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, '0')}m`;
  }
  const days = Math.floor(hours / DAY_HOURS);
  const restHours = hours % DAY_HOURS;

  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
};

/** `4.5`: a CSAT average, one decimal. */
export const formatAverage = (value: number): string => value.toFixed(1);
