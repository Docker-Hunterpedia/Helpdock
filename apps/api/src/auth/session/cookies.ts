import type { Env } from '@helpdock/config';
import type { SessionCookiePayload } from '@helpdock/schemas';
import { sessionCookiePayloadSchema } from '@helpdock/schemas';
import { type SessionLifetime, sessionLifetime } from './lifetime.js';

/**
 * The cookies the auth service sets, and the attributes that make them safe to
 * set at all (ARCHITECTURE §7, REQUIREMENTS §5.1). The third, `hd_oauth`, lives
 * for one OAuth round trip and is described at {@link oauthNonceCookie}.
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
 *
 * **The `__Secure-` prefix, not `__Host-`** (ASVS 3.4.4). Over https both names
 * carry `__Secure-`, which a browser only accepts from a secure origin with
 * `Secure` set, so a plain-http page or a man in the middle cannot plant one.
 * `__Host-` would add "no `Domain`, `Path=/`" — and the first half already
 * holds, while the second would send the refresh token to every route in the
 * app instead of the five that read it. Narrow `Path` is worth more than the
 * stricter prefix; the deviation is recorded in `docs/completed/asvs-l2.md`.
 * Over plain http the prefix would make the browser drop the cookie, so a local
 * install keeps the bare names.
 */

/** The bare names; {@link refreshCookie} and {@link trustedDeviceCookie} add the prefix. */
export const REFRESH_COOKIE = 'hd_refresh';
export const TRUSTED_DEVICE_COOKIE = 'hd_trust';
export const OAUTH_NONCE_COOKIE = 'hd_oauth';

const SECURE_PREFIX = '__Secure-';

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

/** A cookie's name and the attributes it is set and cleared with. */
export interface CookieSpec {
  readonly name: string;
  readonly attributes: CookieAttributes;
}

const prefixed = (appUrl: string, name: string): string =>
  isSecureAppUrl(appUrl) ? `${SECURE_PREFIX}${name}` : name;

/** Lives as long as the family behind it can (`lifetime.ts`). */
export const refreshCookie = (
  appUrl: string,
  lifetime: Pick<SessionLifetime, 'maxSeconds'>,
): CookieSpec => ({
  name: prefixed(appUrl, REFRESH_COOKIE),
  attributes: cookieAttributes({ appUrl, maxAgeSeconds: lifetime.maxSeconds }),
});

/** The refresh cookie as this install's `.env` configures it. */
export const refreshCookieOf = (
  env: Pick<Env, 'APP_URL' | 'AUTH_SESSION_IDLE_MINUTES' | 'AUTH_SESSION_MAX_HOURS'>,
): CookieSpec => refreshCookie(env.APP_URL, sessionLifetime(env));

export const trustedDeviceCookie = (appUrl: string): CookieSpec => ({
  name: prefixed(appUrl, TRUSTED_DEVICE_COOKIE),
  attributes: cookieAttributes({ appUrl, maxAgeSeconds: TRUSTED_DEVICE_TTL_SECONDS }),
});

/**
 * Ties an OAuth callback to the browser that began the flow: the callback is a
 * GET the provider redirects to, so a copy of its URL would otherwise finish
 * someone else's flow in a victim's browser. `Lax` still travels on that
 * top-level redirect, and the path keeps it off every other route.
 */
export const oauthNonceCookie = (appUrl: string, ttlSeconds: number): CookieSpec => ({
  name: prefixed(appUrl, OAUTH_NONCE_COOKIE),
  attributes: {
    ...cookieAttributes({ appUrl, maxAgeSeconds: ttlSeconds }),
    path: `${AUTH_COOKIE_PATH}/oauth`,
  },
});

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
