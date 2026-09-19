import { randomBytes } from 'node:crypto';
import type { EmailTokenPayload, EmailTokenPurpose } from '@helpdock/schemas';
import { emailTokenPayloadSchema } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { emailTokenKey, hashToken } from './redis-keys.js';

/**
 * Tokens that travel by email: magic links, password resets and, from M0-06,
 * invites. DOMAIN-RULES §4.6 says what they all have in common — single use,
 * bound to one address, expiring — so they share one store rather than three
 * that drift.
 *
 * The token is 256 bits of randomness and Redis holds only its hash, so the
 * store cannot produce a working link even to somebody who can read it.
 * Spending one is a single `GETDEL`: two clicks on the same link race in Redis,
 * and exactly one of them wins.
 */

const TOKEN_BYTES = 32;

export class EmailTokenStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /** Returns the token to put in the link. It is never stored in this form. */
  async issue(payload: EmailTokenPayload, ttlSeconds: number): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await this.#redis.set(
      emailTokenKey(hashToken(token)),
      JSON.stringify(payload),
      'EX',
      ttlSeconds,
    );

    return token;
  }

  /**
   * Spends the token, or answers `null`. The expected purpose is checked
   * against the record and not only against the key, so a magic link cannot be
   * posted to the password-reset endpoint.
   */
  async consume(token: string, purpose: EmailTokenPurpose): Promise<EmailTokenPayload | null> {
    const raw = await this.#redis.getdel(emailTokenKey(hashToken(token)));
    if (raw === null) {
      return null;
    }

    let payload: EmailTokenPayload;
    try {
      payload = emailTokenPayloadSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }

    return payload.purpose === purpose ? payload : null;
  }
}
