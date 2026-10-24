import { createHash } from 'node:crypto';
import { uuidv7 } from '@helpdock/db';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { totpRotationKey, totpRotationOfUserKey } from '../redis-keys.js';

/**
 * The staged secret between "the step-up was proved" and "the new app typed a
 * live code" (#373).
 *
 * It lives in Redis and not in a column of `users` because the column is the
 * *live* secret while the app is on: staging over it would switch the account's
 * factor to an app nobody has confirmed, which is the very vulnerability the
 * #371 review removed. It lives in Redis and not in the request because the
 * person has to fetch their phone, scan and type before confirming. The secret
 * arrives already encrypted, so a compromised Redis yields no working
 * authenticator; the key carries a TTL, so an abandoned rotation ends itself.
 */

/**
 * What a staged secret is bound to: a digest of the sealed secret it replaces.
 * A rotation started against one app must not finish against another, whatever
 * happened to the account in between (turned off, re-enrolled, replaced).
 */
export const replacedSecretDigest = (secretEncrypted: string): string =>
  createHash('sha256').update(secretEncrypted).digest('hex');

/** Long enough to scan a QR and type a code; the enrolment challenge gets the same. */
export const ROTATION_TTL_SECONDS = 900;

const rotationSchema = z.object({
  userId: z.uuid(),
  /** `APP_MASTER_KEY`-sealed; the store never sees it in the clear. */
  secretEncrypted: z.string().min(1),
  /** {@link replacedSecretDigest} of the live secret when the rotation was staged. */
  replaces: z.string().min(1),
  createdAt: z.number().int(),
});

export type StagedRotation = z.infer<typeof rotationSchema>;

export type RotationCheck =
  | { readonly status: 'ok'; readonly rotation: StagedRotation }
  | { readonly status: 'expired' };

export class TotpRotationStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /**
   * Stages the sealed secret and answers the id the confirmation will name.
   * An account has one open rotation: staging another ends the first.
   */
  async create({
    userId,
    secretEncrypted,
    replaces,
  }: {
    readonly userId: string;
    readonly secretEncrypted: string;
    /** {@link replacedSecretDigest} of the sealed secret now live. */
    readonly replaces: string;
  }): Promise<string> {
    await this.clearForUser(userId);
    const rotationId = uuidv7();
    const rotation: StagedRotation = {
      userId,
      secretEncrypted,
      replaces,
      createdAt: Math.floor(Date.now() / 1000),
    };

    await this.#redis.set(
      totpRotationKey(rotationId),
      JSON.stringify(rotation),
      'EX',
      ROTATION_TTL_SECONDS,
    );
    await this.#redis.set(totpRotationOfUserKey(userId), rotationId, 'EX', ROTATION_TTL_SECONDS);

    return rotationId;
  }

  async read(rotationId: string): Promise<RotationCheck> {
    const raw = await this.#redis.get(totpRotationKey(rotationId));
    if (raw === null) {
      return { status: 'expired' };
    }

    let parsed: StagedRotation;
    try {
      parsed = rotationSchema.parse(JSON.parse(raw));
    } catch {
      // A record this process cannot read is a record it should not act on.
      await this.#redis.del(totpRotationKey(rotationId));
      return { status: 'expired' };
    }

    return { status: 'ok', rotation: parsed };
  }

  /**
   * Ends whatever rotation the account has open. Every change of factor calls
   * it; the digest binding refuses a stale rotation anyway, so this is the
   * second lock on the same door.
   */
  async clearForUser(userId: string): Promise<void> {
    const open = await this.#redis.get(totpRotationOfUserKey(userId));
    if (open !== null) await this.#redis.del(totpRotationKey(open));
    await this.#redis.del(totpRotationOfUserKey(userId));
  }
}
