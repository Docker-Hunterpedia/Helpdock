import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { hashSubject, rateLimitKey } from './redis-keys.js';

/**
 * Sliding-window counters for the sign-in form (REQUIREMENTS §5.1).
 *
 * A fixed window lets an attacker spend the whole budget at the end of one
 * window and again at the start of the next, so this keeps a sorted set of
 * attempt timestamps and counts only what is still inside the window. The set
 * can never hold more than the limit plus the attempts made in one window, and
 * it expires on its own.
 *
 * **What gets limited, and why two of them.** Per address, so one account
 * cannot be guessed at; per IP, more loosely, so a spray across many addresses
 * from one place runs out too. The address is hashed before it becomes a key:
 * Redis then holds no list of who has tried to sign in here.
 */

export interface RateLimitRule {
  readonly bucket: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** Per address: five attempts in fifteen minutes. */
export const SIGN_IN_EMAIL_RULE: RateLimitRule = {
  bucket: 'signin-email',
  limit: 5,
  windowSeconds: 15 * 60,
};

/** Per IP: twenty, because one office behind one address is a normal thing. */
export const SIGN_IN_IP_RULE: RateLimitRule = {
  bucket: 'signin-ip',
  limit: 20,
  windowSeconds: 15 * 60,
};

/** Per address, for anything that puts a message in somebody's inbox. */
export const EMAIL_DISPATCH_RULE: RateLimitRule = {
  bucket: 'email-dispatch',
  limit: 5,
  windowSeconds: 15 * 60,
};

/**
 * Per account, for the routes that re-prove a credential from inside a session:
 * the current password, and a live authenticator code before the second factor
 * is weakened.
 *
 * The sign-in second factor has a spendable challenge with three attempts and a
 * fifteen-minute lock; these have no challenge to spend, so the budget is the
 * lock. Six digits with a one-step window is three valid codes at any instant
 * out of a million — unlimited guesses would be minutes of work, and the
 * routes it protects hand back ten standalone recovery codes or turn the second
 * factor off.
 */
export const STEP_UP_RULE: RateLimitRule = {
  bucket: 'step-up',
  limit: 5,
  windowSeconds: 15 * 60,
};

/**
 * Per IP, for the two public invite routes. An invite token is 256 bits, so
 * guessing one is not the threat; what this bounds is somebody walking the
 * endpoint to find out whether a token they already hold is still live, and the
 * argon2 work an accept request costs.
 */
export const INVITE_LOOKUP_RULE: RateLimitRule = {
  bucket: 'invite-lookup',
  limit: 30,
  windowSeconds: 15 * 60,
};

/**
 * Trim, count, add, expire — in one round trip, so two requests racing cannot
 * both see a count below the limit.
 */
export const CONSUME_SCRIPT = `
local cutoff = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)
local used = redis.call('ZCARD', KEYS[1])
if used >= limit then
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
  return 0
end
redis.call('ZADD', KEYS[1], now, ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

export class RateLimiter {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /** True when the attempt is allowed and has been counted. */
  async consume(rule: RateLimitRule, subject: string): Promise<boolean> {
    const now = Date.now();
    const windowMs = rule.windowSeconds * 1000;

    const allowed = await this.#redis.eval(
      CONSUME_SCRIPT,
      1,
      rateLimitKey(rule.bucket, hashSubject(subject)),
      String(now - windowMs),
      String(now),
      String(rule.limit),
      String(windowMs),
      // A member has to be unique or two attempts in the same millisecond
      // would count as one.
      randomUUID(),
    );

    return allowed === 1;
  }

  /**
   * Gives an address its budget back. A sign-in that succeeded is not an
   * attack, and without this a busy person on a shared address could lock
   * themselves out by signing in often enough.
   */
  async reset(rule: RateLimitRule, subject: string): Promise<void> {
    await this.#redis.del(rateLimitKey(rule.bucket, hashSubject(subject)));
  }
}
