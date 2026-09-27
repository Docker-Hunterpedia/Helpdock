import { describe, expect, it } from 'vitest';
import { setupKeyMatches } from './setup-key.js';

const KEY = 'q6c2mW1zXk9vT3yRb0nLd8sF4hJ7pA5e';

describe('setupKeyMatches', () => {
  it('accepts the configured key', () => {
    expect(setupKeyMatches(KEY, KEY)).toBe(true);
  });

  it('refuses a wrong key of the same length', () => {
    expect(setupKeyMatches(KEY, `${KEY.slice(0, -1)}x`)).toBe(false);
  });

  it('refuses a key of another length without throwing', () => {
    // A raw `timingSafeEqual` would throw here, which is itself a length oracle.
    expect(setupKeyMatches(KEY, KEY.slice(0, 5))).toBe(false);
    expect(setupKeyMatches(KEY, `${KEY}${KEY}`)).toBe(false);
  });

  it('refuses a missing or empty key', () => {
    expect(setupKeyMatches(KEY, undefined)).toBe(false);
    expect(setupKeyMatches(KEY, '')).toBe(false);
  });
});
