import type { Redis } from 'ioredis';
import { z } from 'zod';
import { pendingInviteKey } from '../auth/redis-keys.js';

/**
 * The invite that is outstanding for one person in one brand.
 *
 * The token itself lives in {@link ../auth/email-token.store.js EmailTokenStore}
 * keyed by its own hash, which is what makes it single-use and unguessable.
 * That is the wrong shape for two things M0-06 needs:
 *
 * 1. **The staff list prints "Invited 3 days ago · expires in 4 days".** It has
 *    a user and a brand in hand, not a token, and it must not be able to get
 *    from one to the other — a list that could produce the link would be a way
 *    to walk into somebody else's account.
 * 2. **Resending has to kill the previous link.** DOMAIN-RULES §12 says single
 *    use; two live invitations for one person would make that a half-truth.
 *
 * So this holds the token's *hash* — enough to delete it, never enough to
 * present it — and the two timestamps. Its TTL is the invite's own, so a record
 * that says "pending" can never outlive the link it describes.
 */

/** DOMAIN-RULES §12: "Email with single-use 7-day token". */
export const INVITE_TTL_DAYS = 7;

const SECONDS_PER_DAY = 24 * 60 * 60;

export const INVITE_TTL_SECONDS = INVITE_TTL_DAYS * SECONDS_PER_DAY;
export const INVITE_TTL_MS = INVITE_TTL_SECONDS * 1000;

const recordSchema = z.object({
  tokenHash: z.string().min(1),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
});

export type PendingInvite = z.infer<typeof recordSchema>;

export class InviteStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async remember(
    brandId: string,
    userId: string,
    record: PendingInvite,
    ttlSeconds: number,
  ): Promise<void> {
    await this.#redis.set(
      pendingInviteKey(brandId, userId),
      JSON.stringify(record),
      'EX',
      ttlSeconds,
    );
  }

  async read(brandId: string, userId: string): Promise<PendingInvite | null> {
    return this.#parse(await this.#redis.get(pendingInviteKey(brandId, userId)));
  }

  /** Every outstanding invite in a brand, so the staff list costs one round trip. */
  async readMany(brandId: string, userIds: readonly string[]): Promise<Map<string, PendingInvite>> {
    const found = new Map<string, PendingInvite>();
    if (userIds.length === 0) {
      return found;
    }

    const raw = await this.#redis.mget(
      ...userIds.map((userId) => pendingInviteKey(brandId, userId)),
    );

    for (const [index, userId] of userIds.entries()) {
      const record = this.#parse(raw[index] ?? null);
      if (record !== null) {
        found.set(userId, record);
      }
    }

    return found;
  }

  /** Forgets the record and returns what it held, so the caller can kill the token. */
  async take(brandId: string, userId: string): Promise<PendingInvite | null> {
    return this.#parse(await this.#redis.getdel(pendingInviteKey(brandId, userId)));
  }

  #parse(raw: string | null): PendingInvite | null {
    if (raw === null) {
      return null;
    }

    const parsed = recordSchema.safeParse(JSON.parse(raw) as unknown);

    return parsed.success ? parsed.data : null;
  }
}
