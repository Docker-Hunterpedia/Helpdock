import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Keyring } from '@helpdock/config';

/**
 * The CSAT link's token (DOMAIN-RULES §4.6: "single-use, signed, bound to one
 * ticket … and expire").
 *
 * `<ids>.<mac>`, both base64url of 32 bytes: the brand id and the survey id
 * packed as raw UUID bytes, and HMAC-SHA256 over them under a key derived from
 * `APP_MASTER_KEY` with HKDF — the shape `auth/totp/trusted-device.ts` uses for
 * the trusted-browser cookie.
 *
 * - **Signed**, so a guessed or altered token is refused before any query runs.
 * - **Bound to one ticket**, because a survey belongs to one ticket and the
 *   token names the survey. It also names the brand, which is how a public
 *   request with no session knows which tenant to open a transaction for.
 * - **Single-use and expiring** are properties of the survey row (`rated_at`,
 *   `expires_at`), not of the token: those have to be decided under a lock.
 *
 * It is deterministic, which is deliberate: the details panel shows the agent
 * the link to share until channels deliver it (M8-06), and only a hash is
 * stored, so the link has to be recomputable. A token can therefore be verified
 * under the previous master key too, so a rotation does not strand the surveys
 * already out; one signed under a key older than that no longer verifies.
 */

const MAC_KEY_INFO = 'helpdock:csat:link';
const MAC_KEY_BYTES = 32;
const UUID_BYTES = 16;

export interface CsatTokenSubject {
  readonly brandId: string;
  readonly surveyId: string;
}

const deriveKey = (masterKey: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), MAC_KEY_INFO, MAC_KEY_BYTES));

const uuidBytes = (id: string): Buffer => Buffer.from(id.replaceAll('-', ''), 'hex');

const uuidFrom = (bytes: Buffer): string => {
  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};

const macOf = (key: Buffer, ids: Buffer): Buffer => createHmac('sha256', key).update(ids).digest();

/** What is stored in `csat_responses.token_hash`. */
export const hashCsatToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export class CsatTokens {
  /** Current key first: it is the one that signs. */
  readonly #keys: readonly Buffer[];

  constructor(keyring: Keyring) {
    this.#keys = [
      keyring.current,
      ...(keyring.previous === undefined ? [] : [keyring.previous]),
    ].map((entry) => deriveKey(entry.key));
  }

  /** The token under the current key. */
  sign(subject: CsatTokenSubject): string {
    return this.#signWith(this.#currentKey(), subject);
  }

  /**
   * Every token this process would accept for `subject`, current key first.
   * The agent's link is whichever of them matches the stored hash.
   */
  candidates(subject: CsatTokenSubject): readonly string[] {
    return this.#keys.map((key) => this.#signWith(key, subject));
  }

  /** The ids a token names, or null when it is malformed or signed by no key we hold. */
  verify(token: string): CsatTokenSubject | null {
    const [idsPart, macPart, ...rest] = token.split('.');
    if (idsPart === undefined || macPart === undefined || rest.length > 0) {
      return null;
    }

    const ids = Buffer.from(idsPart, 'base64url');
    const presented = Buffer.from(macPart, 'base64url');
    if (ids.length !== UUID_BYTES * 2 || presented.length !== MAC_KEY_BYTES) {
      return null;
    }

    const signed = this.#keys.some((key) => timingSafeEqual(macOf(key, ids), presented));
    if (!signed) {
      return null;
    }

    return {
      brandId: uuidFrom(ids.subarray(0, UUID_BYTES)),
      surveyId: uuidFrom(ids.subarray(UUID_BYTES)),
    };
  }

  #currentKey(): Buffer {
    const [current] = this.#keys;
    /* c8 ignore next 3 -- a keyring always has a current key. */
    if (current === undefined) {
      throw new Error('The CSAT token keyring is empty');
    }

    return current;
  }

  #signWith(key: Buffer, { brandId, surveyId }: CsatTokenSubject): string {
    const ids = Buffer.concat([uuidBytes(brandId), uuidBytes(surveyId)]);

    return `${ids.toString('base64url')}.${macOf(key, ids).toString('base64url')}`;
  }
}
