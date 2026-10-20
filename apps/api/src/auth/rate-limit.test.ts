import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../observability/metrics.js';
import { countRateLimitRefusalsIn } from '../observability/rate-limit-refusals.js';
import { authRedis } from '../testing/auth-redis.js';
import type { RedisStub } from '../testing/redis-stub.js';
import {
  RateLimiter,
  type RateLimitRule,
  retryAfterSeconds,
  SIGN_IN_EMAIL_RULE,
  SIGN_IN_IP_RULE,
  SSO_DISCOVERY_RULE,
  SSO_START_RULE,
} from './rate-limit.js';
import { rateLimitKey } from './redis-keys.js';

const SHORT: RateLimitRule = { bucket: 'test', limit: 3, windowSeconds: 60 };

/**
 * The key shape written out rather than imported, so the test states what it
 * expects instead of repeating the implementation's own call.
 */
const hashOf = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

let stub: RedisStub;
let limiter: RateLimiter;

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  limiter = new RateLimiter(created.redis);
});

afterEach(() => {
  vi.useRealTimers();
});

const spend = async (count: number, subject = 'lina@helpdock.com'): Promise<boolean[]> => {
  const results: boolean[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    results.push(await limiter.consume(SHORT, subject));
  }

  return results;
};

describe('RateLimiter', () => {
  it('allows exactly the limit and then refuses', async () => {
    expect(await spend(4)).toEqual([true, true, true, false]);
  });

  it('counts every refusal in rate_limit_refusals_total under its bucket (ASVS 8.1.4)', async () => {
    const metrics = createMetrics();
    countRateLimitRefusalsIn(metrics.rateLimitRefusals);

    await spend(5);

    expect((await metrics.rateLimitRefusals.get()).values).toEqual([
      { value: 2, labels: { bucket: 'test' } },
    ]);
    countRateLimitRefusalsIn(createMetrics().rateLimitRefusals);
  });

  it('counts each subject separately', async () => {
    await spend(3, 'lina@helpdock.com');

    await expect(limiter.consume(SHORT, 'sam@helpdock.com')).resolves.toBe(true);
  });

  it('is a sliding window: the budget returns as attempts age out, not all at once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T10:00:00Z'));
    await spend(3);

    vi.setSystemTime(new Date('2026-09-19T10:00:30Z'));
    await expect(limiter.consume(SHORT, 'lina@helpdock.com')).resolves.toBe(false);

    // The first three are now older than the window, so three come back.
    vi.setSystemTime(new Date('2026-09-19T10:01:01Z'));
    expect(await spend(4)).toEqual([true, true, true, false]);
  });

  it('counts two attempts in the same millisecond as two', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T10:00:00Z'));

    expect(await spend(4)).toEqual([true, true, true, false]);
  });

  it('hashes the subject, so Redis holds no list of who tried to sign in', async () => {
    await limiter.consume(SHORT, 'lina@helpdock.com');

    expect(stub.keys().join(' ')).not.toContain('lina@helpdock.com');
  });

  it('reads an address the same however it was typed', async () => {
    await limiter.consume(SHORT, '  LINA@helpdock.com ');

    expect(stub.keys()).toContain(rateLimitKey(SHORT.bucket, hashOf('lina@helpdock.com')));
  });

  it('gives the budget back when a sign-in succeeds', async () => {
    await spend(3);

    await limiter.reset(SHORT, 'lina@helpdock.com');

    await expect(limiter.consume(SHORT, 'lina@helpdock.com')).resolves.toBe(true);
  });

  it('keeps the counter alive only as long as its window', async () => {
    await limiter.consume(SHORT, 'lina@helpdock.com');

    expect(stub.ttlOf(rateLimitKey(SHORT.bucket, hashOf('lina@helpdock.com')))).toBe(
      SHORT.windowSeconds,
    );
  });
});

describe('the rules the sign-in form runs under', () => {
  it('matches REQUIREMENTS §5.1: ten failures per address and one hundred per IP, each in fifteen minutes', () => {
    expect(SIGN_IN_EMAIL_RULE).toMatchObject({ limit: 10, windowSeconds: 900 });
    expect(SIGN_IN_IP_RULE).toMatchObject({ limit: 100, windowSeconds: 900 });
    // The atomic reservation script uses one window for both buckets.
    expect(SIGN_IN_EMAIL_RULE.windowSeconds).toBe(SIGN_IN_IP_RULE.windowSeconds);
  });

  it('counts an address and an IP in different buckets', () => {
    expect(SIGN_IN_EMAIL_RULE.bucket).not.toBe(SIGN_IN_IP_RULE.bucket);
  });
});

describe('sign-in reservations', () => {
  it('rounds Retry-After up, including the expiry boundary', () => {
    expect(retryAfterSeconds(910_000, 10_001)).toBe(900);
    expect(retryAfterSeconds(910_000, 909_001)).toBe(1);
    expect(retryAfterSeconds(910_000, 910_000)).toBe(1);
  });

  it('a proved first factor refunds only its own entries from both buckets', async () => {
    await limiter.reserveSignIn('office', 'person@example.com');
    const password = await limiter.reserveSignIn('office', 'person@example.com');
    await limiter.refundSignIn(password.attempt);
    expect(await stub.zcard(rateLimitKey(SIGN_IN_IP_RULE.bucket, hashOf('office')))).toBe(1);
    expect(
      await stub.zcard(rateLimitKey(SIGN_IN_EMAIL_RULE.bucket, hashOf('person@example.com'))),
    ).toBe(1);
  });

  it('success refunds only its own IP entry and clears the address', async () => {
    await limiter.reserveSignIn('office', 'typo@example.com');
    const success = await limiter.reserveSignIn('office', 'person@example.com');
    await limiter.signInSucceeded(success.attempt);
    expect(await stub.zcard(rateLimitKey(SIGN_IN_IP_RULE.bucket, hashOf('office')))).toBe(1);
    expect(
      await stub.zcard(rateLimitKey(SIGN_IN_EMAIL_RULE.bucket, hashOf('person@example.com'))),
    ).toBe(0);
  });

  it('uses the larger blocking wait and does not spend the other bucket on refusal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    for (let i = 0; i < 100; i++) await limiter.reserveSignIn('office', `person-${i}@example.com`);
    vi.setSystemTime(1_030_000);
    for (let i = 0; i < 10; i++) await limiter.reserveSignIn('elsewhere', 'victim@example.com');
    const refused = await limiter.reserveSignIn('office', 'victim@example.com');
    expect(refused.retryAfter).toBe(900);
    expect((await limiter.reserveSignIn('office', 'fresh@example.com')).retryAfter).toBe(870);
    expect(
      await stub.zcard(rateLimitKey(SIGN_IN_EMAIL_RULE.bucket, hashOf('fresh@example.com'))),
    ).toBe(0);
  });

  it('keeps SSO discovery and starts separate from credential attempts', () => {
    expect(
      new Set([
        SSO_START_RULE.bucket,
        SSO_DISCOVERY_RULE.bucket,
        SIGN_IN_IP_RULE.bucket,
        SIGN_IN_EMAIL_RULE.bucket,
      ]).size,
    ).toBe(4);
  });
});
