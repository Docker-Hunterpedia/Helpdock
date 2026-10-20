import { hkdfSync } from 'node:crypto';
import {
  type CaptchaSurface,
  createPowChallenge,
  type PowChallenge,
  type PowDifficulty,
  verifyPowSolution,
} from '@helpdock/channels';
import type { Keyring } from '@helpdock/config';
import type { Redis } from 'ioredis';

/**
 * The built-in CAPTCHA's two server halves (ADR 0052): issuing a brand's
 * challenge and spending a solution once.
 *
 * Each brand signs under its own key, derived from `APP_MASTER_KEY` with HKDF
 * as the pepper and the trusted-browser MAC are, so a challenge one brand
 * issued is no solution for another. A key rotation strands the challenges
 * already out; they live fifteen minutes and the widget fetches another.
 *
 * Single use is a Redis `SET NX` on the challenge, kept until the challenge
 * would have expired anyway: two posts of one solution race to that key and
 * only one wins, whichever replica they reach.
 */

const KEY_INFO = 'helpdock:captcha:pow:';
const KEY_BYTES = 32;

/** The challenge is a SHA-256 hex digest already, so it is not hashed again. */
export const powSpentKey = (challenge: string): string => `captcha:pow:${challenge}`;

export type PowCheck =
  | { readonly success: true }
  | { readonly success: false; readonly errorCodes: readonly string[] };

export class PowCaptcha {
  readonly #masterKey: Buffer;
  readonly #redis: Redis;

  constructor(keyring: Keyring, redis: Redis) {
    this.#masterKey = keyring.current.key;
    this.#redis = redis;
  }

  issue(brandId: string, difficulty: PowDifficulty, surface: CaptchaSurface): PowChallenge {
    return createPowChallenge({ key: this.#keyFor(brandId), difficulty, surface });
  }

  async spend(brandId: string, token: string, surface: CaptchaSurface): Promise<PowCheck> {
    const verdict = verifyPowSolution({ key: this.#keyFor(brandId), token, surface });
    if (!verdict.success) {
      return verdict;
    }
    const first = await this.#redis.set(
      powSpentKey(verdict.challenge),
      '1',
      'PX',
      verdict.remainingMs,
      'NX',
    );
    return first === 'OK' ? { success: true } : { success: false, errorCodes: ['already-spent'] };
  }

  #keyFor(brandId: string): Buffer {
    return Buffer.from(
      hkdfSync('sha256', this.#masterKey, Buffer.alloc(0), `${KEY_INFO}${brandId}`, KEY_BYTES),
    );
  }
}
