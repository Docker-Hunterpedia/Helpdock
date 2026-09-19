import { uuidv7 } from '@helpdock/db';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { totpChallengeKey, totpLockKey } from '../redis-keys.js';

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
/** DOMAIN-RULES §1.4, and the "2 attempts left … 15-minute lock" the screen renders. */
export const TOTP_MAX_ATTEMPTS = 3;
export const TOTP_LOCK_SECONDS = 15 * 60;

const challengeSchema = z.object({
  userId: z.uuid(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  /**
   * `second-factor` is the ordinary case. `enrolment` is what an install with
   * `auth.require2fa` on hands an account that has no authenticator yet; M0-06
   * spends it from the enrolment screen.
   */
  kind: z.enum(['second-factor', 'enrolment']),
});

export type TotpChallenge = z.infer<typeof challengeSchema>;

export type ChallengeCheck =
  | { readonly status: 'ok'; readonly challenge: TotpChallenge }
  | { readonly status: 'expired' }
  | { readonly status: 'locked' };

export type AttemptOutcome =
  | { readonly status: 'remaining'; readonly attemptsLeft: number }
  | { readonly status: 'locked' };

export class TotpChallengeStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async create({
    userId,
    kind,
  }: {
    readonly userId: string;
    readonly kind: TotpChallenge['kind'];
  }): Promise<string> {
    const challengeId = uuidv7();
    const challenge: TotpChallenge = {
      userId,
      attempts: 0,
      createdAt: Math.floor(Date.now() / 1000),
      kind,
    };

    await this.#redis.set(
      totpChallengeKey(challengeId),
      JSON.stringify(challenge),
      'EX',
      TOTP_CHALLENGE_TTL_SECONDS,
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
   * tries.
   */
  async spendAttempt(challengeId: string, challenge: TotpChallenge): Promise<AttemptOutcome> {
    const attempts = challenge.attempts + 1;
    const attemptsLeft = TOTP_MAX_ATTEMPTS - attempts;

    if (attemptsLeft <= 0) {
      await this.#redis
        .multi()
        .del(totpChallengeKey(challengeId))
        .set(totpLockKey(challenge.userId), '1', 'EX', TOTP_LOCK_SECONDS)
        .exec();

      return { status: 'locked' };
    }

    // The TTL is kept, not extended: wrong answers must not be a way to hold a
    // challenge open indefinitely.
    await this.#redis.set(
      totpChallengeKey(challengeId),
      JSON.stringify({ ...challenge, attempts }),
      'KEEPTTL',
    );

    return { status: 'remaining', attemptsLeft };
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
