import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The customer portal's small pure rules (M21-02, ADR 0059): token making and
 * hashing, lifetimes, the cookie's name, the CSRF token and the `next` target.
 * Nothing here reads the database or the request, so each rule is proved alone.
 */

/** A sign-in link lives 15 minutes (ADR 0059 §2). */
export const SIGN_IN_TOKEN_TTL_MS = 15 * 60 * 1000;
/** A session ends 30 days after its last use (ADR 0059 §5, D-67). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most this often, so a page view is not a write. */
export const SESSION_TOUCH_INTERVAL_MS = 15 * 60 * 1000;
/** The pre-session nonce of the sign-in form and the Continue page. */
export const NONCE_TTL_SECONDS = 60 * 60;

/** 256 random bits, as the 43 characters of unpadded base64url. */
export const newToken = (): string => randomBytes(32).toString('base64url');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Whether a string can be a token this module made; anything else is not looked up. */
export const isTokenShaped = (value: string | undefined): value is string =>
  value !== undefined && TOKEN_PATTERN.test(value);

/** What the database stores in place of a token: its SHA-256, hex. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Compares two hex digests without leaking where they differ. */
export const sameHash = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const signInExpiry = (now: Date): Date => new Date(now.getTime() + SIGN_IN_TOKEN_TTL_MS);

/** The sliding expiry: 30 days from `now`. */
export const sessionExpiry = (now: Date): Date => new Date(now.getTime() + SESSION_TTL_MS);

/** Whether a request at `now` should push `last_seen_at` and the expiry forward. */
export const shouldTouch = (lastSeenAt: Date, now: Date): boolean =>
  now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;

export const isExpired = (expiresAt: Date, now: Date): boolean =>
  expiresAt.getTime() <= now.getTime();

/**
 * The session cookie's name and whether it carries the `__Host-` prefix.
 *
 * Over https the name is `__Host-hd_cs`: no `Domain`, `Path=/`, `Secure`, which
 * a browser enforces. On the install's shared host the pages live under
 * `/hc/<brandId>`, so two brands share one cookie jar; the brand id in the name
 * keeps their sessions apart (and the guard still checks the session's brand
 * against the path). Over plain http a prefixed name would be dropped, so a
 * local install keeps the bare name, as the staff cookies do.
 */
export const sessionCookieName = (options: {
  readonly secure: boolean;
  readonly brandId: string | null;
}): string =>
  `${options.secure ? '__Host-' : ''}hd_cs${options.brandId === null ? '' : `_${options.brandId}`}`;

/** The sign-in form's pre-session nonce cookie, named the same way. */
export const nonceCookieName = (options: {
  readonly secure: boolean;
  readonly brandId: string | null;
}): string =>
  `${options.secure ? '__Host-' : ''}hd_cn${options.brandId === null ? '' : `_${options.brandId}`}`;

/**
 * Where Continue may send a customer: a portal page, never anything else. The
 * allow-list is a pattern, not "starts with a slash", so `//evil.example`,
 * `/\evil`, a scheme or an encoded newline cannot pass. M21-03 and M21-04 widen
 * it to the ticket pages. The returned path is relative to the help center's
 * base (`''` or `/hc/<brandId>`).
 */
const NEXT_PATTERN = /^\/tickets(?:\/[A-Za-z0-9-]{1,64})?$/;

export const safePortalNext = (next: string | undefined): string | null =>
  next !== undefined && NEXT_PATTERN.test(next) ? next : null;

/** The key CSRF tokens are made under, derived from `APP_MASTER_KEY` like the built-in CAPTCHA's. */
export const csrfKeyFrom = (masterKey: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'helpdock:portal:csrf', 32));

/**
 * A CSRF token bound to a cookie's value: the session token once signed in, the
 * pre-session nonce on the sign-in and Continue forms. Another site cannot read
 * the page it is printed on, and a token printed for one cookie fails for any
 * other, so a forged form post (which carries the victim's cookie but not a
 * valid token) is refused.
 */
export const csrfToken = (key: Buffer, cookieValue: string): string =>
  createHmac('sha256', key).update(`csrf\n${cookieValue}`).digest('base64url');

export const csrfValid = (
  key: Buffer,
  cookieValue: string | undefined,
  presented: string,
): boolean =>
  cookieValue !== undefined &&
  cookieValue !== '' &&
  presented !== '' &&
  sameHash(csrfToken(key, cookieValue), presented);
