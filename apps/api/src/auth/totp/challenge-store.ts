import { uuidv7 } from '@helpdock/db';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { totpChallengeKey, totpFailuresKey, totpLockKey } from '../redis-keys.js';

/**
 * The state between "the password was right" and "the code was right".
 *
 * It lives in Redis and not in a cookie or a signed token because it has to be
 * *spendable*: three attempts and it is gone (DOMAIN-RULES §1.4), and a counter
 * the client holds is a counter the client can reset. Five minutes is long
 * enough to fetch a phone and short enough that an abandoned attempt is not a
 * standing invitation.
 *
 * A challenge carries the user id, never the address the form was filled in
 * with, so the challenge id is not a way to confirm that an address exists.
 */

export const TOTP_CHALLENGE_TTL_SECONDS = 300;
/**
 * An enrolment challenge has a QR code to scan and a code to type before it is
 * spent, so it gets longer than the five minutes a code alone needs.
 */
export const ENROLMENT_CHALLENGE_TTL_SECONDS = 900;
/** DOMAIN-RULES §1.4, and the "2 attempts left … 15-minute lock" the screen renders. */
export const TOTP_MAX_ATTEMPTS = 3;
export const TOTP_LOCK_SECONDS = 15 * 60;

const challengeSchema = z.object({
  userId: z.uuid(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  /**
   * `second-factor` is the ordinary case. `enrolment` is what an account that
   * must have a second factor and has none is handed instead of a session; the
   * enrolment screen spends it (`POST /api/auth/enrolment/*`).
   */
  kind: z.enum(['second-factor', 'enrolment']),
  /** How the password step was proved, for the audit row of the sign-in it completes. */
  firstFactor: z.string().min(1).max(32).optional(),
  ssoConnectionId: z.uuid().optional(),
});

export type TotpChallenge = z.infer<typeof challengeSchema>;

export type ChallengeCheck =
  | { readonly status: 'ok'; readonly challenge: TotpChallenge }
  | { readonly status: 'expired' }
  | { readonly status: 'locked' };

export type AttemptOutcome =
  | { readonly status: 'remaining'; readonly attemptsLeft: number }
  | { readonly status: 'locked' }
  | { readonly status: 'expired' };

/**
 * Charges one wrong value in a single step, so parallel guesses cannot read the
 * same count and overwrite each other. Two budgets are spent together: the
 * challenge's own (KEYS[1]) and the account's (KEYS[3]), which survives the
 * challenge. Without the second, someone holding the first factor could start a
 * fresh challenge for every two wrong codes and never reach the lock.
 *
 * The challenge is never recreated (a consumed or expired one answers -1), the
 * account is bound to the stored record rather than the caller's copy, and the
 * TTL is kept, not extended. ARGV: user id, limit, lock seconds.
 * Returns {status, attemptsLeft}: 1 remaining, 0 locked, -1 expired.
 */
export const SPEND_ATTEMPT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {-1, 0} end
local challenge = cjson.decode(raw)
if challenge.userId ~= ARGV[1] then return {-1, 0} end
local limit = tonumber(ARGV[2])
local lock = tonumber(ARGV[3])
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('DEL', KEYS[1])
  return {0, 0}
end
local attempts = challenge.attempts + 1
local failures = redis.call('INCR', KEYS[3])
if failures == 1 then redis.call('EXPIRE', KEYS[3], lock) end
if attempts >= limit or failures >= limit then
  redis.call('DEL', KEYS[1], KEYS[3])
  redis.call('SET', KEYS[2], '1', 'EX', lock)
  return {0, 0}
end
challenge.attempts = attempts
redis.call('SET', KEYS[1], cjson.encode(challenge), 'KEEPTTL')
return {1, limit - math.max(attempts, failures)}
`;

export class TotpChallengeStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async create({
    userId,
    kind,
    firstFactor,
    ssoConnectionId,
  }: {
    readonly userId: string;
    readonly kind: TotpChallenge['kind'];
    readonly firstFactor?: string;
    readonly ssoConnectionId?: string;
  }): Promise<string> {
    const challengeId = uuidv7();
    const challenge: TotpChallenge = {
      userId,
      attempts: 0,
      createdAt: Math.floor(Date.now() / 1000),
      kind,
      ...(firstFactor === undefined ? {} : { firstFactor }),
      ...(ssoConnectionId === undefined ? {} : { ssoConnectionId }),
    };

    await this.#redis.set(
      totpChallengeKey(challengeId),
      JSON.stringify(challenge),
      'EX',
      kind === 'enrolment' ? ENROLMENT_CHALLENGE_TTL_SECONDS : TOTP_CHALLENGE_TTL_SECONDS,
    );

    return challengeId;
  }

  async read(challengeId: string): Promise<ChallengeCheck> {
    const raw = await this.#redis.get(totpChallengeKey(challengeId));
    if (raw === null) {
      return { status: 'expired' };
    }

    let parsed: z.infer<typeof challengeSchema>;
    try {
      parsed = challengeSchema.parse(JSON.parse(raw));
    } catch {
      // A record this process cannot read is a record it should not act on.
      await this.#redis.del(totpChallengeKey(challengeId));
      return { status: 'expired' };
    }

    if (await this.isLocked(parsed.userId)) {
      return { status: 'locked' };
    }

    return { status: 'ok', challenge: parsed };
  }

  /**
   * Charges one attempt, whichever field the wrong value was typed into. A
   * recovery code and an authenticator code share the budget on purpose: the
   * lock would be trivially avoidable if switching forms bought three more
   * tries. The count the caller read is ignored; the stored one is the truth.
   */
  async spendAttempt(challengeId: string, challenge: TotpChallenge): Promise<AttemptOutcome> {
    const [status, attemptsLeft] = (await this.#redis.eval(
      SPEND_ATTEMPT_SCRIPT,
      3,
      totpChallengeKey(challengeId),
      totpLockKey(challenge.userId),
      totpFailuresKey(challenge.userId),
      challenge.userId,
      String(TOTP_MAX_ATTEMPTS),
      String(TOTP_LOCK_SECONDS),
    )) as [number, number];

    if (status === 1) return { status: 'remaining', attemptsLeft };
    return { status: status === 0 ? 'locked' : 'expired' };
  }

  /** A completed sign-in forgives earlier wrong codes; only proof of every factor does. */
  async clearFailures(userId: string): Promise<void> {
    await this.#redis.del(totpFailuresKey(userId));
  }

  /** The challenge is spent the moment it succeeds, so one code opens one session. */
  async consume(challengeId: string): Promise<void> {
    await this.#redis.del(totpChallengeKey(challengeId));
  }

  /** Checked before the password is even verified, so a locked account stays locked. */
  async isLocked(userId: string): Promise<boolean> {
    return (await this.#redis.exists(totpLockKey(userId))) === 1;
  }

  /** Used by the enrolment path, which must not leave a lock behind on success. */
  async clearLock(userId: string): Promise<void> {
    await this.#redis.del(totpLockKey(userId));
  }
}
