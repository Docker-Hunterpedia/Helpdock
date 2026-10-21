import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Keyring } from '@helpdock/config';
import { UNSUBSCRIBE_TOKEN_PATTERN, UNSUBSCRIBE_TOKEN_TTL_DAYS } from '@helpdock/schemas';

/**
 * The token in a notification email's unsubscribe link (M14-11, DOMAIN-RULES
 * §4.6).
 *
 * `<payload>.<mac>`, both base64url: the payload is the user id as 16 raw bytes
 * and the issue time as seconds in 4 more, the MAC is HMAC-SHA256 over the
 * payload under a key derived from `APP_MASTER_KEY` with HKDF for the one
 * purpose `notify-unsubscribe`.
 *
 * - **Signed and purpose-bound.** A key derived for another purpose (the CSAT
 *   link's, the trusted-browser cookie's) signs nothing this accepts, and this
 *   key signs nothing they accept.
 * - **Expiring.** It names when it was issued and is refused a year after,
 *   and refused when it claims to come from the future beyond clock skew.
 * - **Stateless and idempotent.** Nothing is stored per token. Presenting one
 *   twice does what presenting it once did, because the action it authorises
 *   (turn notification email off for the user it names) is a state, not an
 *   event. It can do nothing else: no other setting is reachable with it.
 * - **Rotation.** The previous master key still verifies, so a rotation does
 *   not strand the emails already in inboxes; one older than that does.
 */

const KEY_INFO = 'helpdock:notify-unsubscribe';
const KEY_BYTES = 32;
const USER_ID_BYTES = 16;
const PAYLOAD_BYTES = USER_ID_BYTES + 4;
const DAY_SECONDS = 86_400;
/** An issue time this far ahead of now is a clock disagreement; further is a forgery. */
const FUTURE_SKEW_SECONDS = 300;

export interface UnsubscribeSubject {
  readonly userId: string;
  readonly issuedAt: Date;
}

const deriveKey = (masterKey: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), KEY_INFO, KEY_BYTES));

const macOf = (key: Buffer, payload: Buffer): Buffer =>
  createHmac('sha256', key).update(payload).digest();

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

export class UnsubscribeTokens {
  /** Current key first: it is the one that signs. */
  readonly #keys: readonly Buffer[];

  constructor(keyring: Keyring) {
    this.#keys = [
      keyring.current,
      ...(keyring.previous === undefined ? [] : [keyring.previous]),
    ].map((entry) => deriveKey(entry.key));
  }

  sign(userId: string, issuedAt: Date): string {
    const [key] = this.#keys;
    /* c8 ignore next 3 -- a keyring always has a current key. */
    if (key === undefined) {
      throw new Error('The unsubscribe token keyring is empty');
    }
    const payload = Buffer.alloc(PAYLOAD_BYTES);
    Buffer.from(userId.replaceAll('-', ''), 'hex').copy(payload);
    payload.writeUInt32BE(Math.floor(issuedAt.getTime() / 1000), USER_ID_BYTES);

    return `${payload.toString('base64url')}.${macOf(key, payload).toString('base64url')}`;
  }

  /**
   * The user a token names, or null for anything else: malformed, signed by no
   * key we hold, expired, or from the future. The caller cannot tell which, and
   * neither can the person who sent it.
   */
  verify(token: string, now: Date): UnsubscribeSubject | null {
    if (!UNSUBSCRIBE_TOKEN_PATTERN.test(token)) {
      return null;
    }
    const [payloadPart = '', macPart = ''] = token.split('.');
    const payload = Buffer.from(payloadPart, 'base64url');
    const presented = Buffer.from(macPart, 'base64url');
    if (payload.length !== PAYLOAD_BYTES || presented.length !== KEY_BYTES) {
      return null;
    }

    // Every key is tried, with no early exit, so timing does not say which signed.
    const signed = this.#keys
      .map((key) => timingSafeEqual(macOf(key, payload), presented))
      .some(Boolean);
    if (!signed) {
      return null;
    }

    const issuedSeconds = payload.readUInt32BE(USER_ID_BYTES);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (
      issuedSeconds > nowSeconds + FUTURE_SKEW_SECONDS ||
      nowSeconds - issuedSeconds >= UNSUBSCRIBE_TOKEN_TTL_DAYS * DAY_SECONDS
    ) {
      return null;
    }

    return {
      userId: uuidFrom(payload.subarray(0, USER_ID_BYTES)),
      issuedAt: new Date(issuedSeconds * 1000),
    };
  }
}

/** The two addresses one email carries, for one recipient. */
export interface UnsubscribeLinks {
  /** The confirmation page a person's click opens (a GET changes nothing). */
  readonly page: string;
  /** What `List-Unsubscribe` names and the mail client POSTs to (RFC 8058). */
  readonly oneClick: string;
}

export const unsubscribeLinks = (
  tokens: UnsubscribeTokens,
  appUrl: string,
  userId: string,
  locale: string,
  now: Date,
): UnsubscribeLinks => {
  const token = tokens.sign(userId, now);
  const page = new URL(`/unsubscribe/${token}`, appUrl);
  page.searchParams.set('lang', locale);

  return {
    page: page.toString(),
    oneClick: new URL(`/api/public/unsubscribe/${token}`, appUrl).toString(),
  };
};

/** The headers RFC 8058 asks of a message that can be unsubscribed from in one click. */
export const unsubscribeHeaders = (links: UnsubscribeLinks): Record<string, string> => ({
  'List-Unsubscribe': `<${links.oneClick}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});
