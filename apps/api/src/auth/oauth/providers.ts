import type { OauthProvider } from '@helpdock/schemas';

/**
 * Google and GitHub, hand-wired.
 *
 * **Why not passport.** ARCHITECTURE §1 lists passport, and M0-05 weighed it
 * against writing the two flows directly. The strategies that would carry it —
 * `passport-github2` and `passport-google-oauth20` — were last published in
 * 2022 and 2023, neither implements PKCE, and both are Express-middleware
 * shaped, which on Fastify means a shim around the one part of the codebase
 * that must be easiest to read. What they would replace is two `fetch` calls to
 * fixed hosts and one `jwtVerify`, and `jose` is already a dependency. So the
 * flows are written here, with the state and PKCE handling visible in one file,
 * and passport is not installed. `docs/guides/authentication.md` records the
 * decision where an operator will look for it.
 *
 * Every URL below is a constant. Nothing in this file ever fetches a host that
 * came out of a request, which is why the SSRF-safe client of `@helpdock/net`
 * is not in the path (DOMAIN-RULES §13 is about user-supplied URLs).
 */

export interface OauthProviderConfig {
  readonly id: OauthProvider;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scope: string;
}

export const OAUTH_PROVIDERS: Readonly<Record<OauthProvider, OauthProviderConfig>> = Object.freeze({
  google: {
    id: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  github: {
    id: 'github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    // `user:email` and nothing else: the only thing this install wants from
    // GitHub is which verified address is signing in.
    scope: 'read:user user:email',
  },
});

/**
 * How each provider says who is signing in. Separate constants rather than a
 * discriminated field on the config above, because the code that reads them is
 * already provider-specific: a union would only add a branch that can never be
 * taken.
 */
export const GOOGLE_IDENTITY = Object.freeze({
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  // Google has issued both spellings for years and documents both as valid.
  issuers: Object.freeze(['https://accounts.google.com', 'accounts.google.com']),
});

export const GITHUB_IDENTITY = Object.freeze({
  emailsUrl: 'https://api.github.com/user/emails',
  userUrl: 'https://api.github.com/user',
});

/** Where the provider sends the browser back. Fixed per install, never from a request. */
export const oauthRedirectUri = (appUrl: string, provider: OauthProvider): string =>
  new URL(`/api/auth/oauth/${provider}/callback`, appUrl).toString();
