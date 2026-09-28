import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  canonicalIdentityJson,
  SIGNED_IDENTITY_WINDOW_SECONDS,
  type SignedIdentity,
  VISITOR_AUTH_SCHEME,
  visitorSecretSchema,
} from '@helpdock/schemas';

/**
 * The two credentials of DOMAIN-RULES §4.1–4.2, as pure functions.
 *
 * - **The visitor secret** is 256 random bits, handed to the widget once and
 *   stored by the server only as `sha256(secret)`.
 * - **A signed identity** is the host site's HMAC-SHA256 over the canonical
 *   payload, valid within five minutes of the server's clock.
 */

const SECRET_BYTES = 32;

/** A new visitor secret: 32 random bytes, base64url, 43 characters. */
export const issueVisitorSecret = (): string => randomBytes(SECRET_BYTES).toString('base64url');

/** What `widget_visitors.secret_hash` stores and is looked up by. */
export const hashVisitorSecret = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

/**
 * The secret out of `Authorization: Visitor <secret>`, or null for anything
 * else — a missing header, another scheme, or a value that is not one of ours.
 */
export const visitorSecretFrom = (header: string | string[] | undefined): string | null => {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    return null;
  }

  const match = /^(\S+)\s+(\S+)$/.exec(value.trim());
  if (match === null || match[1]?.toLowerCase() !== VISITOR_AUTH_SCHEME.toLowerCase()) {
    return null;
  }

  const parsed = visitorSecretSchema.safeParse(match[2]);
  return parsed.success ? parsed.data : null;
};

export type IdentityCheck = 'valid' | 'bad_signature' | 'expired';

/**
 * Whether the host site really signed this identity, recently (§4.2). The
 * signature is compared in constant time; the clock check comes second so a
 * forged signature and a stale real one are told apart only in the log.
 */
export const checkSignedIdentity = (
  identity: SignedIdentity,
  signingSecret: string,
  now: Date,
): IdentityCheck => {
  const expected = createHmac('sha256', signingSecret)
    .update(canonicalIdentityJson(identity.payload), 'utf8')
    .digest();
  const presented = Buffer.from(identity.signature, 'hex');

  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return 'bad_signature';
  }

  const skew = Math.abs(Math.floor(now.getTime() / 1000) - identity.payload.ts);
  return skew <= SIGNED_IDENTITY_WINDOW_SECONDS ? 'valid' : 'expired';
};

/**
 * A new signing secret for a brand: 32 random bytes, base64url, shown once.
 * `hdws_` ("Helpdock widget secret") names it as ours, so a secret scanner
 * that finds a leaked one does not report it as another product's key. The
 * whole string is the HMAC key, so secrets issued with the earlier `whsec_`
 * prefix keep verifying.
 */
export const issueSigningSecret = (): string => `hdws_${randomBytes(32).toString('base64url')}`;
