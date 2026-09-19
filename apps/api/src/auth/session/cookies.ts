import type { SessionCookiePayload } from '@helpdock/schemas';
import { sessionCookiePayloadSchema } from '@helpdock/schemas';
import { REFRESH_TOKEN_TTL_SECONDS } from './refresh-store.js';

/**
 * The two cookies the auth service sets, and the attributes that make them
 * safe to set at all (ARCHITECTURE §7, REQUIREMENTS §5.1).
 *
 * | | |
 * |---|---|
 * | `HttpOnly` | Script cannot read either of them, so an XSS does not walk away with a thirty-day session. |
 * | `SameSite=Lax` | A cross-site POST carries neither, which is what makes the refresh endpoint not need a CSRF token of its own. |
 * | `Secure` | Set when `APP_URL` is https. Not unconditionally: a `Secure` cookie is silently dropped over plain http, and a local `http://localhost` install would be unable to sign in with no visible reason. |
 * | `Path=/api/auth` | The only routes that read them. Nothing else in the app ever receives them, so nothing else can leak them. |
 *
 * There is deliberately no `Domain`: without one a cookie is host-only, and a
 * sibling subdomain of the install cannot set or read it.
 */

export const REFRESH_COOKIE = 'hd_refresh';
export const TRUSTED_DEVICE_COOKIE = 'hd_trust';

/** Every route that reads a cookie lives here; nothing else is sent one. */
export const AUTH_COOKIE_PATH = '/api/auth';

/** Thirty days, matching the family behind it (ARCHITECTURE §7). */
export const TRUSTED_DEVICE_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CookieAttributes {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly path: string;
  readonly maxAge: number;
}

export const isSecureAppUrl = (appUrl: string): boolean => {
  try {
    return new URL(appUrl).protocol === 'https:';
  } catch {
    return false;
  }
};

export const cookieAttributes = ({
  appUrl,
  maxAgeSeconds,
}: {
  readonly appUrl: string;
  readonly maxAgeSeconds: number;
}): CookieAttributes => ({
  httpOnly: true,
  secure: isSecureAppUrl(appUrl),
  sameSite: 'lax',
  path: AUTH_COOKIE_PATH,
  maxAge: maxAgeSeconds,
});

export const refreshCookieAttributes = (appUrl: string): CookieAttributes =>
  cookieAttributes({ appUrl, maxAgeSeconds: REFRESH_TOKEN_TTL_SECONDS });

export const trustedDeviceCookieAttributes = (appUrl: string): CookieAttributes =>
  cookieAttributes({ appUrl, maxAgeSeconds: TRUSTED_DEVICE_TTL_SECONDS });

/**
 * `<family>.<token>` — the family says which chain to look up and the token is
 * the credential. Both are opaque and neither contains a dot, so one split is
 * unambiguous.
 */
export const encodeRefreshCookie = ({ fam, token }: SessionCookiePayload): string =>
  `${fam}.${token}`;

export const decodeRefreshCookie = (value: string | undefined): SessionCookiePayload | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const [fam, token, ...rest] = value.split('.');
  if (rest.length > 0) {
    return null;
  }

  const parsed = sessionCookiePayloadSchema.safeParse({ fam, token });
  return parsed.success ? parsed.data : null;
};
