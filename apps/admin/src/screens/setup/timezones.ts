import { supportedTimeZones } from '@helpdock/schemas';

/**
 * The timezone picker's options, and the guess it starts on.
 *
 * The list is whatever this browser knows, which is the same list the api
 * validates against (`supportedTimeZones` wraps `Intl.supportedValuesOf`), so
 * nothing on screen can be refused on submit. It is read once: 400-odd strings
 * built on every keystroke would be the most expensive thing on the step.
 */

let sorted: readonly string[] | undefined;

export const timeZoneOptions = (): readonly string[] => {
  sorted ??= [...supportedTimeZones()].sort((a, b) => a.localeCompare(b, 'en'));

  return sorted;
};

/**
 * What the browser is set to, when Helpdock knows the name; `UTC` otherwise,
 * which is also the column's default.
 */
export const currentTimeZone = (): string => {
  const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return guess !== undefined && supportedTimeZones().has(guess) ? guess : 'UTC';
};
