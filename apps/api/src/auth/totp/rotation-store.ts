import { uuidv7 } from '@helpdock/db';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { totpRotationKey } from '../redis-keys.js';

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

/** Long enough to scan a QR and type a code; the enrolment challenge gets the same. */
export const ROTATION_TTL_SECONDS = 900;

const rotationSchema = z.object({
  userId: z.uuid(),
  /** `APP_MASTER_KEY`-sealed; the store never sees it in the clear. */
  secretEncrypted: z.string().min(1),
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

  /** Stages the sealed secret and answers the id the confirmation will name. */
  async create({
    userId,
    secretEncrypted,
  }: {
    readonly userId: string;
    readonly secretEncrypted: string;
  }): Promise<string> {
    const rotationId = uuidv7();
    const rotation: StagedRotation = {
      userId,
      secretEncrypted,
      createdAt: Math.floor(Date.now() / 1000),
    };

    await this.#redis.set(
      totpRotationKey(rotationId),
      JSON.stringify(rotation),
      'EX',
      ROTATION_TTL_SECONDS,
    );

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

  /** Spends the staged secret, only for the account it was staged for. */
  async consume(rotationId: string, userId: string): Promise<void> {
    const raw = await this.#redis.get(totpRotationKey(rotationId));
    if (raw !== null && rotationSchema.safeParse(JSON.parse(raw)).data?.userId === userId) {
      await this.#redis.del(totpRotationKey(rotationId));
    }
  }
}
