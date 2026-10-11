import { randomBytes } from 'node:crypto';
import { hashToken } from '../auth/redis-keys.js';
import { OAUTH_STATE_TTL_MS } from './oauth-state.js';

/**
 * A knowledge OAuth `state` is good for one callback (ASVS 13.1.3). The signed
 * state already says who asked and for which source; this is what makes it
 * single-use, so a callback URL that lands in a browser history, a proxy log or
 * a referrer cannot be played again within its ten minutes. The nonce is stored
 * under its hash, and spending it is one `GETDEL`, so two callbacks racing for
 * it cannot both win.
 */

const nonceKey = (nonce: string): string => `knowledge:oauth:${hashToken(nonce)}`;

/** The two Redis commands the store uses, so a test can stand in for it. */
export interface NonceRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

export class OAuthNonceStore {
  readonly #redis: NonceRedis;

  constructor(redis: NonceRedis) {
    this.#redis = redis;
  }

  /** A fresh nonce, remembered for as long as the state it goes into lives. */
  async issue(): Promise<string> {
    const nonce = randomBytes(16).toString('base64url');
    await this.#redis.set(nonceKey(nonce), '1', 'EX', OAUTH_STATE_TTL_MS / 1_000);
    return nonce;
  }

  /** Whether this nonce was issued and had not been spent; spends it. */
  async consume(nonce: string): Promise<boolean> {
    return (await this.#redis.getdel(nonceKey(nonce))) !== null;
  }
}
