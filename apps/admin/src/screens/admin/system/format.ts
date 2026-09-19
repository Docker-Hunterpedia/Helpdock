/**
 * The numbers on the System page, formatted once so the cards, the table and
 * the tiles cannot disagree.
 *
 * Every numeral is Latin in both locales (DESIGN §7): a queue depth and a
 * version are read the same way in Arabic, and Arabic-Indic digits are a v1.1
 * setting. `en-GB` is passed explicitly rather than letting `Intl` follow the
 * document, which is what would otherwise switch them.
 */

const LATIN_NUMERALS = 'en-GB';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

const BYTES_PER_UNIT = 1024;
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

const THOUSAND = 1000;
const MILLION = 1_000_000;

/** A count, grouped: `1,204`. */
export const formatCount = (value: number): string =>
  new Intl.NumberFormat(LATIN_NUMERALS).format(value);

/** A token count, shortened the way the artboard shows it: `2.1 M`. */
export const formatCompact = (value: number): string => {
  if (value >= MILLION) {
    return `${(value / MILLION).toFixed(1)} M`;
  }
  if (value >= THOUSAND) {
    return `${(value / THOUSAND).toFixed(1)} k`;
  }

  return formatCount(value);
};

/** `18.4 GB`. Binary units, because that is what an object store reports. */
export const formatBytes = (value: number): string => {
  let size = value;
  let unit = 0;

  while (size >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    size /= BYTES_PER_UNIT;
    unit += 1;
  }

  const digits = unit === 0 || size >= 100 ? 0 : 1;
  return `${size.toFixed(digits)} ${BYTE_UNITS[unit]}`;
};

/**
 * `$6.40`. `narrowSymbol` because the default in `en-GB` is `US$`, and the
 * budget on this page is already stated in dollars by the copy beside it.
 */
export const formatUsd = (value: number): string =>
  new Intl.NumberFormat(LATIN_NUMERALS, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
  }).format(value);

/** A millisecond latency as the page shows it: `84` or `0.4`. */
export const formatMs = (value: number): string =>
  value >= 10 ? formatCount(Math.round(value)) : value.toFixed(1);

/**
 * A duration, coarsened as it grows: `12 s`, `4 m`, `3 h`, `2 d`. Ages on this
 * page are read as "is it stuck?", and a job that has waited four minutes is not
 * better understood as 247 seconds.
 */
export const formatDuration = (seconds: number): string => {
  if (seconds < SECONDS_PER_MINUTE) {
    return `${Math.max(0, Math.round(seconds))} s`;
  }
  if (seconds < SECONDS_PER_HOUR) {
    return `${Math.round(seconds / SECONDS_PER_MINUTE)} m`;
  }
  if (seconds < SECONDS_PER_DAY) {
    return `${Math.round(seconds / SECONDS_PER_HOUR)} h`;
  }

  return `${Math.round(seconds / SECONDS_PER_DAY)} d`;
};

/** Whole seconds since `iso`, never negative — a clock that is slightly ahead is "now". */
export const secondsSince = (iso: string, now: number = Date.now()): number =>
  Math.max(0, Math.round((now - Date.parse(iso)) / 1000));

/** `64` from 6.4 of 10, clamped, for a progress bar and the caption beside it. */
export const percentOf = (value: number, total: number): number => {
  if (total <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
};
