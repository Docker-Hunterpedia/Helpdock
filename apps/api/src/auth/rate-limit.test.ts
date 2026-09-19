import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authRedis } from '../testing/auth-redis.js';
import type { RedisStub } from '../testing/redis-stub.js';
import {
  RateLimiter,
  type RateLimitRule,
  SIGN_IN_EMAIL_RULE,
  SIGN_IN_IP_RULE,
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
  it('matches REQUIREMENTS §5.1: five per address and twenty per IP, each in fifteen minutes', () => {
    expect(SIGN_IN_EMAIL_RULE).toMatchObject({ limit: 5, windowSeconds: 900 });
    expect(SIGN_IN_IP_RULE).toMatchObject({ limit: 20, windowSeconds: 900 });
  });

  it('counts an address and an IP in different buckets', () => {
    expect(SIGN_IN_EMAIL_RULE.bucket).not.toBe(SIGN_IN_IP_RULE.bucket);
  });
});
