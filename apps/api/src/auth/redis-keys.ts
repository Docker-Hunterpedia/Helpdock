import { createHash } from 'node:crypto';

/**
 * Every Redis key and channel the auth service touches, in one place.
 *
 * Two rules hold across all of them. A secret is never a key: what goes into
 * the key is the SHA-256 of the token, so a `KEYS auth:*` on a compromised
 * Redis yields nothing that can be presented to the api. And a key that stands
 * for a credential always carries a TTL, so nothing outlives its purpose even
 * if the code that should have deleted it never ran.
 */

/** One refresh family: the rotating token's hash and who it belongs to. */
export const familyKey = (familyId: string): string => `sess:family:${familyId}`;

/** Every family a user holds, so "log out everywhere" has something to walk. */
export const userFamiliesKey = (userId: string): string => `sess:user:${userId}`;

/**
 * Access tokens issued by one family recently. Revoking a family marks each of
 * them, which is what makes the revocation reach a token already in a browser
 * (DOMAIN-RULES §1.6: at most ten minutes).
 */
export const familySessionsKey = (familyId: string): string => `sess:family-sids:${familyId}`;

/** Set on revoke and checked by the resolver on every request. */
export const revokedSessionKey = (sessionId: string): string => `sess:revoked:${sessionId}`;

/** A second-factor challenge between the password step and the code step. */
export const totpChallengeKey = (challengeId: string): string => `auth:totp:${challengeId}`;

/** Set when a challenge burns its last attempt; blocks sign-in for this account. */
export const totpLockKey = (userId: string): string => `auth:totp-lock:${userId}`;

/** A browser the user chose to trust, addressed by the hash of its cookie's nonce. */
export const trustedDeviceKey = (userId: string, nonceHash: string): string =>
  `auth:trust:${userId}:${nonceHash}`;

/** A magic link, a password reset or an invite, addressed by the hash of the token. */
export const emailTokenKey = (tokenHash: string): string => `auth:token:${tokenHash}`;

/** The one-time code a redirect carries instead of an access token. */
export const exchangeKey = (codeHash: string): string => `auth:exchange:${codeHash}`;

/** An OAuth flow in progress: its PKCE verifier, keyed by the hash of its state. */
export const oauthStateKey = (stateHash: string): string => `auth:oauth:${stateHash}`;

/** The brand a user last worked in, so a sign-in lands where they left off. */
export const brandPreferenceKey = (userId: string): string => `auth:brand:${userId}`;

/** Held while one replica generates the install's signing key pair. */
export const SIGNING_KEY_LOCK = 'auth:jwt-signing-key:init';

/** A sliding-window counter. The subject is already hashed when it is an address. */
export const rateLimitKey = (bucket: string, subject: string): string =>
  `auth:rate:${bucket}:${subject}`;

/**
 * "The server publishes `principal.revoked` over Redis and every replica
 * disconnects that principal's sockets within 5 seconds" (DOMAIN-RULES §1.4).
 * M0-13 subscribes; this milestone only publishes.
 */
export const PRINCIPAL_REVOKED_CHANNEL = 'principal.revoked';

/**
 * The hash a secret is stored under. SHA-256 and not argon2 on purpose: these
 * are 256-bit random tokens, not passwords, so there is nothing to slow an
 * attacker down about — there is no smaller space to search — and a lookup has
 * to be fast enough to sit in front of every request.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('base64url');

/** An address as a rate-limit subject: normalised, then hashed so Redis holds no PII. */
export const hashSubject = (value: string): string => hashToken(value.trim().toLowerCase());
