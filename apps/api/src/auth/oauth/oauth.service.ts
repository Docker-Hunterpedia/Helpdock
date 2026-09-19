import { createHash, randomBytes } from 'node:crypto';
import type { Settings } from '@helpdock/config';
import type { OauthProvider } from '@helpdock/schemas';
import { oauthProviderSchema } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Logger } from '../../logging/logger.js';
import { hashToken, oauthStateKey } from '../redis-keys.js';
import {
  GITHUB_IDENTITY,
  GOOGLE_IDENTITY,
  OAUTH_PROVIDERS,
  oauthRedirectUri,
} from './providers.js';

/**
 * The two OAuth flows, with the three things that make them safe:
 *
 * - **State.** 256 bits of randomness, stored server-side under its own hash
 *   and spent on the callback. A callback with no matching state is somebody
 *   else's callback being replayed at this install, and it is refused.
 * - **PKCE.** The code verifier never leaves the server, so a stolen
 *   authorization code is not a session where the provider supports it.
 * - **A fixed redirect.** Built from `APP_URL`, never echoed from the request,
 *   so there is no open redirect to point at.
 *
 * Matching is by **verified address only**, and no account is created: M0-05
 * signs people in, M0-06 invites them. An unrecognised address is `no-account`,
 * which is the honest answer and does not quietly make an admin out of anyone
 * who happens to own a Google account.
 */

export const OAUTH_STATE_TTL_SECONDS = 600;
const STATE_BYTES = 32;
const VERIFIER_BYTES = 32;
const FETCH_TIMEOUT_MS = 10_000;

const stateRecordSchema = z.object({
  provider: oauthProviderSchema,
  codeVerifier: z.string().min(1),
  createdAt: z.number().int(),
});

const googleClaimsSchema = z.object({
  email: z.email(),
  email_verified: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  name: z.string().optional(),
});

const githubEmailsSchema = z.array(
  z.object({ email: z.email(), primary: z.boolean(), verified: z.boolean() }),
);

const githubUserSchema = z.object({ name: z.string().nullable(), login: z.string() });

export interface OauthIdentity {
  readonly email: string;
  readonly name: string | undefined;
}

export interface OauthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Thrown for anything the provider did that this install cannot act on. */
export class OauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OauthError';
  }
}

const base64url = (input: Buffer): string => input.toString('base64url');

const challengeFor = (verifier: string): string =>
  base64url(createHash('sha256').update(verifier).digest());

/** One timeout for every provider call, so a hung provider is not a hung request. */
const postForm = async (url: string, body: URLSearchParams): Promise<unknown> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new OauthError(`The provider answered ${response.status} to the token request`);
  }

  return response.json();
};

const getJson = async (url: string, accessToken: string): Promise<unknown> => {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'helpdock',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new OauthError(`The provider answered ${response.status} to the identity request`);
  }

  return response.json();
};

const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  id_token: z.string().optional(),
});

export class OauthService {
  readonly #settings: Settings;
  readonly #redis: Redis;
  readonly #logger: Logger;
  readonly #appUrl: string;
  readonly #jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor({
    settings,
    redis,
    logger,
    appUrl,
  }: {
    readonly settings: Settings;
    readonly redis: Redis;
    readonly logger: Logger;
    readonly appUrl: string;
  }) {
    this.#settings = settings;
    this.#redis = redis;
    this.#logger = logger;
    this.#appUrl = appUrl;
  }

  /** A provider with no client id is off, and `GET /api/auth/methods` says so. */
  async isEnabled(provider: OauthProvider): Promise<boolean> {
    const { clientId } = await this.#credentials(provider);
    return clientId !== '';
  }

  /** The provider URL to redirect the browser to, with the state already stored. */
  async start(provider: OauthProvider): Promise<string> {
    const { clientId } = await this.#credentials(provider);
    if (clientId === '') {
      throw new OauthError(`${provider} sign-in is not configured on this install`);
    }

    const config = OAUTH_PROVIDERS[provider];
    const state = base64url(randomBytes(STATE_BYTES));
    const codeVerifier = base64url(randomBytes(VERIFIER_BYTES));

    await this.#redis.set(
      oauthStateKey(hashToken(state)),
      JSON.stringify({ provider, codeVerifier, createdAt: Math.floor(Date.now() / 1000) }),
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );

    const url = new URL(config.authorizeUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', oauthRedirectUri(this.#appUrl, provider));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', config.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challengeFor(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');

    return url.toString();
  }

  /**
   * Spends the state and the code and answers with the verified address. A
   * state that does not belong to this provider is refused even if it is
   * otherwise valid, so one provider's callback cannot complete another's flow.
   */
  async complete({
    provider,
    code,
    state,
  }: {
    readonly provider: OauthProvider;
    readonly code: string;
    readonly state: string;
  }): Promise<OauthIdentity> {
    const raw = await this.#redis.getdel(oauthStateKey(hashToken(state)));
    if (raw === null) {
      throw new OauthError('This sign-in attempt has expired or was already completed');
    }

    const record = stateRecordSchema.safeParse(JSON.parse(raw));
    if (!record.success || record.data.provider !== provider) {
      throw new OauthError('The state does not belong to this provider');
    }

    const { clientId, clientSecret } = await this.#credentials(provider);
    if (clientId === '' || clientSecret === '') {
      throw new OauthError(`${provider} sign-in is not configured on this install`);
    }

    const tokens = tokenResponseSchema.parse(
      await postForm(
        OAUTH_PROVIDERS[provider].tokenUrl,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: oauthRedirectUri(this.#appUrl, provider),
          code_verifier: record.data.codeVerifier,
        }),
      ),
    );

    try {
      return provider === 'google'
        ? await this.#googleIdentity(tokens.id_token, clientId)
        : await this.#githubIdentity(tokens.access_token);
    } catch (error) {
      if (error instanceof OauthError) {
        throw error;
      }

      // A provider that answered with a shape this install does not recognise,
      // or an id token that did not verify. Either way it is a failed sign-in
      // and not an api fault, so it gets the same answer as the rest.
      throw new OauthError(`${provider} did not return an identity this install can use`);
    }
  }

  async #googleIdentity(idToken: string | undefined, clientId: string): Promise<OauthIdentity> {
    if (idToken === undefined) {
      throw new OauthError('Google returned no id token');
    }

    const { payload } = await jwtVerify(idToken, this.#jwksFor(GOOGLE_IDENTITY.jwksUrl), {
      issuer: [...GOOGLE_IDENTITY.issuers],
      // The audience check is what stops an id token minted for a different
      // application from signing somebody in here.
      audience: clientId,
    });

    const claims = googleClaimsSchema.parse(payload);
    // Google sends `email_verified` as a boolean, and as the string "true" in
    // some older responses. Anything else counts as unverified.
    if (claims.email_verified !== true && claims.email_verified !== 'true') {
      throw new OauthError('Google has not verified that address');
    }

    return { email: claims.email, name: claims.name };
  }

  async #githubIdentity(accessToken: string | undefined): Promise<OauthIdentity> {
    if (accessToken === undefined) {
      throw new OauthError('GitHub returned no access token');
    }

    const emails = githubEmailsSchema.parse(await getJson(GITHUB_IDENTITY.emailsUrl, accessToken));
    const primary = emails.find((entry) => entry.primary && entry.verified);
    if (primary === undefined) {
      throw new OauthError('This GitHub account has no verified primary address');
    }

    const user = githubUserSchema.parse(await getJson(GITHUB_IDENTITY.userUrl, accessToken));

    return { email: primary.email, name: user.name ?? user.login };
  }

  #jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
    // One key set per URL for the life of the process: it caches the keys and
    // refetches on a `kid` it has not seen, which is the rotation story.
    const existing = this.#jwks.get(url);
    if (existing !== undefined) {
      return existing;
    }

    const created = createRemoteJWKSet(new URL(url));
    this.#jwks.set(url, created);
    this.#logger.debug({ url }, 'Opened a remote JWKS for an OAuth provider');

    return created;
  }

  async #credentials(provider: OauthProvider): Promise<OauthCredentials> {
    const [clientId, clientSecret] = await Promise.all(
      provider === 'google'
        ? [
            this.#settings.get('oauth.google.clientId'),
            this.#settings.get('oauth.google.clientSecret'),
          ]
        : [
            this.#settings.get('oauth.github.clientId'),
            this.#settings.get('oauth.github.clientSecret'),
          ],
    );

    return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  }
}
