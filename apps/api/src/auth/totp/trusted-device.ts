import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { hashToken, trustedDeviceKey } from '../redis-keys.js';
import { TRUSTED_DEVICE_TTL_SECONDS } from '../session/cookies.js';

/**
 * "Trust this browser for 30 days": the cookie that lets a known browser skip
 * the second factor.
 *
 * The cookie is `<userId>.<nonce>.<mac>`, where the MAC is HMAC-SHA256 over the
 * first two parts under a key derived from `APP_MASTER_KEY`. The nonce's hash
 * is also a Redis key, and both have to check out.
 *
 * Either one alone would do less. Without the MAC, anyone who can list Redis
 * keys can mint a cookie. Without Redis, the cookie could not be revoked and
 * "log out everywhere" would leave the second factor skipped on a browser
 * somebody else has. With both, revoking is a `DEL` and forging needs the
 * master key.
 */

const MAC_KEY_BYTES = 32;
const MAC_KEY_INFO = 'helpdock:auth:trusted-device';
const NONCE_BYTES = 32;

export const deriveTrustedDeviceKey = (masterKey: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), MAC_KEY_INFO, MAC_KEY_BYTES));

const mac = (key: Buffer, body: string): string =>
  createHmac('sha256', key).update(body, 'utf8').digest('base64url');

/** Constant time, and false rather than a throw when the lengths differ. */
const macMatches = (expected: string, presented: string): boolean => {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
};

export class TrustedDeviceStore {
  readonly #redis: Redis;
  readonly #key: Buffer;

  constructor({ redis, masterKey }: { readonly redis: Redis; readonly masterKey: Buffer }) {
    this.#redis = redis;
    this.#key = deriveTrustedDeviceKey(masterKey);
  }

  /** Mints the cookie value and records the browser. */
  async trust(userId: string): Promise<string> {
    const nonce = randomBytes(NONCE_BYTES).toString('base64url');
    const body = `${userId}.${nonce}`;

    await this.#redis.set(
      trustedDeviceKey(userId, hashToken(nonce)),
      '1',
      'EX',
      TRUSTED_DEVICE_TTL_SECONDS,
    );

    return `${body}.${mac(this.#key, body)}`;
  }

  /**
   * Whether this cookie lets `userId` past the second factor. The user id is
   * taken from the sign-in that is happening, never from the cookie, so a
   * cookie minted for one account cannot be presented for another.
   */
  async isTrusted(userId: string, cookie: string | undefined): Promise<boolean> {
    if (typeof cookie !== 'string') {
      return false;
    }

    const [cookieUserId, nonce, presented, ...rest] = cookie.split('.');
    if (rest.length > 0 || cookieUserId !== userId || !nonce || !presented) {
      return false;
    }

    if (!macMatches(mac(this.#key, `${cookieUserId}.${nonce}`), presented)) {
      return false;
    }

    return (await this.#redis.exists(trustedDeviceKey(userId, hashToken(nonce)))) === 1;
  }

  /**
   * Forgets every browser this user trusted. "Log out everywhere" has to do
   * this too, or a second factor that was skipped stays skipped.
   */
  async revokeAll(userId: string): Promise<void> {
    const pattern = trustedDeviceKey(userId, '*');
    let cursor = '0';

    do {
      const [next, keys] = await this.#redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        await this.#redis.del(...keys);
      }
    } while (cursor !== '0');
  }
}
