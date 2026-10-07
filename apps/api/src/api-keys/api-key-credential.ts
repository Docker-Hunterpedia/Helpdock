import { createHash, randomBytes } from 'node:crypto';
import { API_KEY_DISPLAY_LENGTH, API_KEY_PREFIX } from '@helpdock/schemas';

/**
 * The key of ARCHITECTURE §7: `hd_live_` and 32 random bytes in base64url.
 * Only its SHA-256 is stored. A key has 256 bits of entropy, so a fast hash is
 * the right one: there is nothing for a slow hash to stretch, and a slow one
 * would cost every request it authenticates. CodeQL reads "key" as a password
 * here; `.github/codeql/codeql-config.yml` says why that query is off.
 */

const KEY_BYTES = 32;

export interface IssuedApiKey {
  /** Shown once, in the create response, and never again. */
  readonly key: string;
  readonly hash: string;
  readonly prefix: string;
}

export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export const isApiKey = (token: string): boolean => token.startsWith(API_KEY_PREFIX);

export const issueApiKey = (): IssuedApiKey => {
  const key = `${API_KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;

  return { key, hash: hashApiKey(key), prefix: key.slice(0, API_KEY_DISPLAY_LENGTH) };
};
