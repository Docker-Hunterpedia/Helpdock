import { describe, expect, it } from 'vitest';
import { backoffDelay, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from './backoff.js';

describe('backoffDelay', () => {
  it('doubles the ceiling with each attempt', () => {
    const ceiling = (attempt: number) => backoffDelay(attempt, () => 1);

    expect([ceiling(0), ceiling(1), ceiling(2), ceiling(3)]).toEqual([
      RECONNECT_BASE_MS,
      RECONNECT_BASE_MS * 2,
      RECONNECT_BASE_MS * 4,
      RECONNECT_BASE_MS * 8,
    ]);
  });

  it('caps the wait, so the end of a long outage is not followed by a long silence', () => {
    expect(backoffDelay(20, () => 1)).toBe(RECONNECT_MAX_MS);
  });

  it('jitters across the whole window, so tabs do not return in lockstep', () => {
    expect(backoffDelay(3, () => 0)).toBe(0);
    expect(backoffDelay(3, () => 0.5)).toBe((RECONNECT_BASE_MS * 8) / 2);
  });

  it('treats a negative attempt as the first one', () => {
    expect(backoffDelay(-5, () => 1)).toBe(RECONNECT_BASE_MS);
  });
});
