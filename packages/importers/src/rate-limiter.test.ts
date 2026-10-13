import { expect, it } from 'vitest';
import { RateLimited } from './errors.js';
import { ImportRateLimiter, retryAfterMs } from './rate-limiter.js';

it.each([
  ['12', 12000],
  ['Wed, 01 Jan 2020 00:00:10 GMT', 10000],
  ['invalid', 1000],
  ['0', 1000],
  [undefined, 1000],
] as const)('turns Retry-After %s into a resumable delay', (header, delay) => {
  expect(retryAfterMs(header, Date.parse('2020-01-01T00:00:00Z'))).toBe(delay);
});

it('refills tokens without blocking and preserves a vendor-imposed pause', () => {
  let now = 0;
  const limiter = new ImportRateLimiter({ capacity: 1, perMinute: 60, now: () => now });
  limiter.reserve();
  expect(() => limiter.reserve()).toThrow(RateLimited);
  now = 1000;
  limiter.reserve();
  limiter.defer(5000);
  now = 2000;
  expect(() => limiter.reserve()).toThrow(expect.objectContaining({ retryAfterMs: 4000 }));
  now = 6000;
  expect(() => limiter.reserve()).not.toThrow();
});
