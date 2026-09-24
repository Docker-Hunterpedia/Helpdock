import { MAX_TIME_ENTRY_SECONDS } from '@helpdock/schemas';

/**
 * How the Time card and the Log time dialog print time (`AdminTicketDialogs`,
 * panels 6 and 8). Latin digits in both locales, as DESIGN §7 has it for every
 * number on the desk.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/** `1h 25m`, `45m`, `30s`: what an entry and the total read as. Minutes round down. */
export const durationOf = (seconds: number): string => {
  if (seconds < MINUTE) {
    return `${seconds}s`;
  }

  const hours = Math.floor(seconds / HOUR);
  const minutes = Math.floor((seconds % HOUR) / MINUTE);

  if (hours === 0) {
    return `${minutes}m`;
  }

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};

/** `00:12:40`, the running timer. */
export const clockOf = (seconds: number): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${pad(Math.floor(seconds / HOUR))}:${pad(Math.floor((seconds % HOUR) / MINUTE))}:${pad(seconds % MINUTE)}`;
};

/**
 * The dialog's two fields as seconds, or null when they break its rule:
 * "Minutes 0–59, hours 0–24. The total must be above zero."
 */
export const secondsFrom = (hours: number, minutes: number): number | null => {
  const valid =
    Number.isInteger(hours) &&
    Number.isInteger(minutes) &&
    hours >= 0 &&
    hours <= 24 &&
    minutes >= 0 &&
    minutes <= 59;
  const total = hours * HOUR + minutes * MINUTE;

  return valid && total > 0 ? total : null;
};

/**
 * What the timer may send. A timer left running over a weekend is capped at
 * the longest entry the api accepts rather than refused, because the reply it
 * rides on must not fail over it.
 */
export const loggableSeconds = (seconds: number): number | null =>
  seconds < 1 ? null : Math.min(seconds, MAX_TIME_ENTRY_SECONDS);
