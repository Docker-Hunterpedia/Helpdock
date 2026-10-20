import { expect, it } from 'vitest';
import { retryAfterMinutes } from './auth-error.js';

it.each([
  [undefined, 15],
  [0, 1],
  [1, 1],
  [60, 1],
  [61, 2],
  [900, 15],
])('shows %s retry seconds as %s whole minutes', (seconds, minutes) => {
  expect(retryAfterMinutes(seconds)).toBe(minutes);
});
