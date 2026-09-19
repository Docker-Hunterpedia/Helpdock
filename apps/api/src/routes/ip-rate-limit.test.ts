import { describe, expect, it } from 'vitest';
import { createIpRateLimiter } from './ip-rate-limit.js';

const limiterAt = (clock: { now: number }, overrides = {}) =>
  createIpRateLimiter({
    limit: 3,
    windowMs: 1000,
    maxTrackedIps: 2,
    now: () => clock.now,
    ...overrides,
  });

describe('createIpRateLimiter', () => {
  it('allows up to the limit and refuses the next request', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    expect([1, 2, 3].map(() => limiter.allow('10.0.0.1'))).toEqual([true, true, true]);
    expect(limiter.allow('10.0.0.1')).toBe(false);
  });

  it('counts each address on its own', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    for (const _ of [1, 2, 3]) {
      limiter.allow('10.0.0.1');
    }

    expect(limiter.allow('10.0.0.1')).toBe(false);
    expect(limiter.allow('10.0.0.2')).toBe(true);
  });

  it('starts a new window once the old one has passed', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    for (const _ of [1, 2, 3, 4]) {
      limiter.allow('10.0.0.1');
    }
    expect(limiter.allow('10.0.0.1')).toBe(false);

    clock.now = 1000;
    expect(limiter.allow('10.0.0.1')).toBe(true);
  });

  it('drops the table rather than growing with the number of addresses', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    limiter.allow('10.0.0.1');
    limiter.allow('10.0.0.2');
    // A third address reaches `maxTrackedIps`, so the counters are dropped.
    // A caller that can mint addresses gets a clean window, which is the
    // trade: bounded memory over an exact count for a spoofable key.
    limiter.allow('10.0.0.3');

    expect(limiter.allow('10.0.0.1')).toBe(true);
  });
});
