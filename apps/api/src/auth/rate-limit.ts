import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { rateLimitRefusals } from '../observability/rate-limit-refusals.js';
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

/** Ten failures allow ordinary typos while bounding guesses against one account. */
export const SIGN_IN_EMAIL_RULE: RateLimitRule = {
  bucket: 'signin-email',
  limit: 10,
  windowSeconds: 15 * 60,
};

/** A spray guard: 100 failures, allowing a whole office to share an IP. */
export const SIGN_IN_IP_RULE: RateLimitRule = {
  bucket: 'signin-ip',
  limit: 100,
  windowSeconds: 15 * 60,
};

/** SSO traffic never spends the local credential budget. */
export const SSO_DISCOVERY_RULE: RateLimitRule = {
  bucket: 'sso-discovery',
  limit: 20,
  windowSeconds: 60,
};
export const SSO_START_RULE: RateLimitRule = { bucket: 'sso-start', limit: 20, windowSeconds: 60 };
export const SSO_CALLBACK_RULE: RateLimitRule = {
  bucket: 'sso-callback',
  limit: 40,
  windowSeconds: 60,
};
export const SSO_SAML_ACS_RULE: RateLimitRule = {
  bucket: 'sso-saml-acs',
  limit: 40,
  windowSeconds: 60,
};
export const SSO_SAML_COMPLETE_RULE: RateLimitRule = {
  bucket: 'sso-saml-complete',
  limit: 40,
  windowSeconds: 60,
};
export const SSO_SAML_METADATA_RULE: RateLimitRule = {
  bucket: 'sso-saml-metadata',
  limit: 30,
  windowSeconds: 60,
};

/** Seconds until the oldest entry expires; HTTP Retry-After must round up. */
export const retryAfterSeconds = (retryAt: number, now: number): number =>
  Math.max(1, Math.ceil((retryAt - now) / 1000));

/**
 * Reserve before verification: in-flight guesses occupy slots, so
 * parallel requests cannot all verify below the limit. A proved password removes
 * its own IP member; only a complete sign-in resets the address failures.
 * Both buckets are checked in one script before either is changed. A refusal
 * therefore spends neither bucket and does identical work for every address.
 */
export const RESERVE_SIGN_IN_SCRIPT = `
local now = tonumber(ARGV[1])
-- Both credential rules share this window; rate-limit.test.ts guards the invariant.
local window = tonumber(ARGV[2])
local retry = 0
local blocked = {0, 0}
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - window)
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i + 2]) then
    blocked[i] = 1
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    retry = math.max(retry, tonumber(oldest[2]) + window)
  end
end
if retry > 0 then return {retry, blocked[1], blocked[2]} end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], now, ARGV[5])
  redis.call('PEXPIRE', KEYS[i], window)
end
return {0, 0, 0}
`;

export interface SignInAttempt {
  readonly member: string;
  readonly ip: string;
  readonly email: string | undefined;
}

/** Per address, for anything that puts a message in somebody's inbox. */
export const EMAIL_DISPATCH_RULE: RateLimitRule = {
  bucket: 'email-dispatch',
  limit: 5,
  windowSeconds: 15 * 60,
};

/**
 * Per IP, for the sign-in link and password reset requests (M18-11). The
 * per-address rule above stops one inbox being flooded; this stops one source
 * walking many addresses. Its own bucket, so a burst of link requests does not
 * spend the office's sign-in budget, and looser than that one for the same
 * reason: many people behind one address forget a password on the same day.
 */
export const EMAIL_DISPATCH_IP_RULE: RateLimitRule = {
  bucket: 'email-dispatch-ip',
  limit: 30,
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
 * Per IP, for the sign-in link's confirm screen: the preview it loads and the
 * click that spends the link (M9-01 F6). The same reasoning and the same
 * figure as {@link INVITE_LOOKUP_RULE}: a 256-bit token is not guessed, so
 * this bounds somebody asking whether a link they hold is still live.
 */
export const MAGIC_LINK_LOOKUP_RULE: RateLimitRule = {
  bucket: 'magic-link-lookup',
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

  async reserveSignIn(
    ip: string,
    email?: string,
  ): Promise<{ attempt: SignInAttempt; retryAfter: number }> {
    const attempt = { member: randomUUID(), ip, email };
    const keys = [rateLimitKey(SIGN_IN_IP_RULE.bucket, hashSubject(ip))];
    if (email !== undefined) keys.push(rateLimitKey(SIGN_IN_EMAIL_RULE.bucket, hashSubject(email)));
    const now = Date.now();
    const [retryAt, blockedIp, blockedEmail] = (await this.#redis.eval(
      RESERVE_SIGN_IN_SCRIPT,
      keys.length,
      ...keys,
      String(now),
      String(SIGN_IN_IP_RULE.windowSeconds * 1000),
      String(SIGN_IN_IP_RULE.limit),
      String(SIGN_IN_EMAIL_RULE.limit),
      attempt.member,
    )) as [number, number, number];
    if (blockedIp) rateLimitRefusals().record(SIGN_IN_IP_RULE.bucket);
    if (blockedEmail) rateLimitRefusals().record(SIGN_IN_EMAIL_RULE.bucket);
    return { attempt, retryAfter: retryAt > 0 ? retryAfterSeconds(retryAt, now) : 0 };
  }

  async refundSignInIp(attempt: SignInAttempt): Promise<void> {
    await this.#redis.zrem(
      rateLimitKey(SIGN_IN_IP_RULE.bucket, hashSubject(attempt.ip)),
      attempt.member,
    );
  }

  async signInSucceeded(attempt: SignInAttempt): Promise<void> {
    await this.refundSignInIp(attempt);
    if (attempt.email !== undefined) await this.reset(SIGN_IN_EMAIL_RULE, attempt.email);
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

    if (allowed !== 1) {
      rateLimitRefusals().record(rule.bucket);
      return false;
    }

    return true;
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
