import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Settings } from '@helpdock/config';
import type { OauthProvider } from '@helpdock/schemas';
import {
  localeSchema,
  MICROSOFT_CONSUMERS_TENANT_ID,
  oauthProviderSchema,
} from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as client from 'openid-client';
import { z } from 'zod';
import type { Logger } from '../../logging/logger.js';
import { oidcTransport } from '../../sso/oidc-transport.js';
import { entraVouchesForEmail } from '../entra.js';
import { hashToken, oauthStateKey } from '../redis-keys.js';
import { googleIsAuthoritative } from './oauth-linking.js';
import {
  GITHUB_IDENTITY,
  GOOGLE_IDENTITY,
  type HandWiredProvider,
  MICROSOFT_IDENTITY,
  OAUTH_PROVIDERS,
  oauthRedirectUri,
} from './providers.js';

/**
 * The two OAuth flows, with the three things that make them safe:
 *
 * - **State.** 256 bits of randomness, stored server-side under its own hash
 *   and spent on the callback. A callback with no matching state is somebody
 *   else's callback being replayed at this install, and it is refused.
 * - **A browser.** The state is also tied to the browser that started the flow,
 *   by a nonce it holds in a cookie and the server holds only the hash of. The
 *   callback is a plain GET, so without this a copy of its URL finishes the
 *   attacker's sign-in in a victim's browser.
 * - **PKCE.** The code verifier never leaves the server, so a stolen
 *   authorization code is not a session where the provider supports it.
 * - **A fixed redirect.** Built from `APP_URL`, never echoed from the request,
 *   so there is no open redirect to point at.
 *
 * What comes back is the provider account's stable subject, its address, and
 * whether the provider controls that address. Which staff account that is —
 * by subject first, by address only for a first link the provider can vouch
 * for — is `oauth-linking.ts`'s decision, and no account is ever created:
 * M0-05 signs people in, M0-06 invites them.
 *
 * **Microsoft** (M18-08) takes the same state, browser nonce and PKCE through
 * `openid-client`, with discovery, the token request and the key set all going
 * out through the SSRF-safe client and no redirect followed. Its tokens are
 * held to one tenant: the issuer is exactly `https://login.microsoftonline.com/
 * <tenant>/v2.0`, `tid` is that tenant, and the subject is `<tid>:<oid>`.
 *
 * A flow started from inside a session to connect a provider account carries
 * that account's id in its state, so the callback links rather than signs in.
 * One started from an invitation carries the invitation instead (M18-07): the
 * hash of its token, never the token, and the name and language typed on the
 * invite screen.
 */

export const OAUTH_STATE_TTL_SECONDS = 600;
const STATE_BYTES = 32;
const VERIFIER_BYTES = 32;
const FETCH_TIMEOUT_MS = 10_000;

const stateRecordSchema = z.object({
  provider: oauthProviderSchema,
  codeVerifier: z.string().min(1),
  browserNonceHash: z.string().min(1),
  createdAt: z.number().int(),
  /** The OpenID Connect nonce Microsoft's id token must echo. Not used by the other two. */
  nonce: z.string().min(1).optional(),
  /** Set when a signed-in person started the flow to connect this provider to their account. */
  linkUserId: z.uuid().optional(),
  /** Set when the flow accepts an invitation with this provider. */
  invite: z
    .object({
      tokenHash: z.string().min(1),
      name: z.string().min(1).max(120),
      locale: localeSchema,
    })
    .optional(),
});

export type OauthInviteState = NonNullable<z.infer<typeof stateRecordSchema>['invite']>;

const googleClaimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email(),
  email_verified: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  /** Present only on a managed Workspace account: its domain. */
  hd: z.string().optional(),
  name: z.string().optional(),
});

const microsoftClaimsSchema = z.object({
  iss: z.string(),
  tid: z.string().min(1),
  /** The object id: stable per account within a tenant, unlike the per-application `sub`. */
  oid: z.guid(),
  /** Present only when the operator added the optional `email` claim. */
  email: z.email().optional(),
  /** The sign-in name. Editable by the tenant's admins, so never what makes a first link. */
  preferred_username: z.string().optional(),
  name: z.string().optional(),
});

const githubEmailsSchema = z.array(
  z.object({ email: z.email(), primary: z.boolean(), verified: z.boolean() }),
);

const githubUserSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable(),
  login: z.string(),
});

export interface OauthIdentity {
  readonly provider: OauthProvider;
  /** Google's `sub`, GitHub's numeric id: what the account is bound by. */
  readonly subject: string;
  readonly email: string;
  readonly name: string | undefined;
  /** Whether the provider controls `email`, which is what may make a first link. */
  readonly authoritative: boolean;
  /** Google's `hd` claim: the Workspace domain of a managed account. Absent otherwise. */
  readonly hostedDomain: string | undefined;
  /**
   * Every address the provider says is verified for this account: Google's one
   * address when verified, every verified address of a GitHub account. Only an
   * invitation reads it, to tell the invited address is this account's.
   */
  readonly verifiedEmails: readonly string[];
}

export interface OauthCompletion {
  readonly identity: OauthIdentity;
  /** The signed-in account that started this flow to connect the provider, if one did. */
  readonly linkUserId: string | undefined;
  /** The invitation this flow accepts, if it was started from one. */
  readonly invite: OauthInviteState | undefined;
}

export interface OauthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Microsoft's directory id. Empty for the other providers, which have none. */
  readonly tenantId: string;
  /** Whether personal Microsoft accounts (the consumers tenant) are accepted too. */
  readonly allowConsumers: boolean;
}

/** How long a discovered Microsoft configuration is reused: its keys rotate, and `openid-client` refetches on a `kid` it lacks. */
const DISCOVERY_TTL_MS = 3_600_000;
const MICROSOFT_HOST = new URL(MICROSOFT_IDENTITY.authority).host;

/** Whether `openid-client` refused a token because its `iss` was not the expected issuer. */
const isIssuerMismatch = (error: unknown): boolean => {
  if (
    !(error instanceof client.ClientError) ||
    error.code !== 'OAUTH_JWT_CLAIM_COMPARISON_FAILED'
  ) {
    return false;
  }
  const detail = z.object({ cause: z.object({ claim: z.string() }) }).safeParse(error.cause);
  return detail.success && detail.data.cause.claim === 'iss';
};

/** Thrown for anything the provider did that this install cannot act on. */
export class OauthError extends Error {
  /** Set when the screen can say more than "this did not work" without saying anything about accounts. */
  readonly reason: 'tenant-mismatch' | undefined;

  constructor(message: string, reason?: 'tenant-mismatch') {
    super(message);
    this.name = 'OauthError';
    this.reason = reason;
  }
}

const base64url = (input: Buffer): string => input.toString('base64url');

const challengeFor = (verifier: string): string =>
  base64url(createHash('sha256').update(verifier).digest());

const holdsNonce = (nonce: string | undefined, expectedHash: string): boolean => {
  if (nonce === undefined) {
    return false;
  }
  const presented = Buffer.from(hashToken(nonce));
  const expected = Buffer.from(expectedHash);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

/** One timeout for every provider call, so a hung provider is not a hung request. */
const postForm = async (url: string, body: URLSearchParams): Promise<unknown> => {
  // The providers' fixed token endpoints, never a URL a user supplied.
  // nosemgrep: helpdock-fetch-non-constant-url
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
  // The providers' fixed user endpoints, never a URL a user supplied.
  // nosemgrep: helpdock-fetch-non-constant-url
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
  readonly #transport: client.CustomFetch;
  readonly #jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  #microsoft: { key: string; expires: number; configuration: client.Configuration } | undefined;

  constructor({
    settings,
    redis,
    logger,
    appUrl,
    transport = oidcTransport([]),
  }: {
    readonly settings: Settings;
    readonly redis: Redis;
    readonly logger: Logger;
    readonly appUrl: string;
    /** Every request Microsoft's flow makes. The SSRF-safe client unless a test supplies a stand-in. */
    readonly transport?: client.CustomFetch;
  }) {
    this.#settings = settings;
    this.#redis = redis;
    this.#logger = logger;
    this.#appUrl = appUrl;
    this.#transport = transport;
  }

  /**
   * A provider with no client id is off, and `GET /api/auth/methods` says so.
   * Microsoft is also off without a tenant, where there is no issuer to trust,
   * and without a secret, which its flow cannot start without.
   */
  async isEnabled(provider: OauthProvider): Promise<boolean> {
    const { clientId, clientSecret, tenantId } = await this.#credentials(provider);
    return (
      clientId !== '' && (provider !== 'microsoft' || (tenantId !== '' && clientSecret !== ''))
    );
  }

  /**
   * The provider URL to redirect the browser to, with the state already stored,
   * and the nonce that browser must present on the callback.
   */
  async start(
    provider: OauthProvider,
    {
      linkUserId,
      invite,
    }: { readonly linkUserId?: string; readonly invite?: OauthInviteState } = {},
  ): Promise<{ url: string; browserNonce: string }> {
    const { clientId } = await this.#credentials(provider);
    if (!(await this.isEnabled(provider))) {
      throw new OauthError(`${provider} sign-in is not configured on this install`);
    }

    const state = base64url(randomBytes(STATE_BYTES));
    const codeVerifier = base64url(randomBytes(VERIFIER_BYTES));
    const browserNonce = base64url(randomBytes(STATE_BYTES));
    const nonce = base64url(randomBytes(STATE_BYTES));
    const challenge = challengeFor(codeVerifier);
    // Discovery can fail, and a failed start must not leave a state behind.
    const authorizationUrl =
      provider === 'microsoft'
        ? client
            .buildAuthorizationUrl(await this.#microsoftConfiguration(), {
              redirect_uri: oauthRedirectUri(this.#appUrl, provider),
              response_type: 'code',
              scope: MICROSOFT_IDENTITY.scope,
              state,
              nonce,
              code_challenge: challenge,
              code_challenge_method: 'S256',
            })
            .toString()
        : this.#handWiredUrl(provider, { clientId, state, challenge });

    await this.#redis.set(
      oauthStateKey(hashToken(state)),
      JSON.stringify({
        provider,
        codeVerifier,
        browserNonceHash: hashToken(browserNonce),
        createdAt: Math.floor(Date.now() / 1000),
        ...(provider === 'microsoft' ? { nonce } : {}),
        ...(linkUserId === undefined ? {} : { linkUserId }),
        ...(invite === undefined ? {} : { invite }),
      }),
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );

    return { url: authorizationUrl, browserNonce };
  }

  #handWiredUrl(
    provider: HandWiredProvider,
    { clientId, state, challenge }: { clientId: string; state: string; challenge: string },
  ): string {
    const config = OAUTH_PROVIDERS[provider];
    const url = new URL(config.authorizeUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', oauthRedirectUri(this.#appUrl, provider));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', config.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return url.toString();
  }

  /**
   * Spends the state and the code and answers with the provider account. A
   * state that does not belong to this provider is refused even if it is
   * otherwise valid, so one provider's callback cannot complete another's flow,
   * and so is one from a browser that does not hold the flow's nonce.
   */
  async complete({
    provider,
    code,
    state,
    browserNonce,
  }: {
    readonly provider: OauthProvider;
    readonly code: string;
    readonly state: string;
    readonly browserNonce: string | undefined;
  }): Promise<OauthCompletion> {
    const raw = await this.#redis.getdel(oauthStateKey(hashToken(state)));
    if (raw === null) {
      throw new OauthError('This sign-in attempt has expired or was already completed');
    }

    const record = stateRecordSchema.safeParse(JSON.parse(raw));
    if (!record.success || record.data.provider !== provider) {
      throw new OauthError('The state does not belong to this provider');
    }
    if (!holdsNonce(browserNonce, record.data.browserNonceHash)) {
      throw new OauthError('This sign-in was not started in this browser');
    }

    const { clientId, clientSecret } = await this.#credentials(provider);
    if (!(await this.isEnabled(provider)) || clientSecret === '') {
      throw new OauthError(`${provider} sign-in is not configured on this install`);
    }

    if (provider === 'microsoft') {
      return this.#completeMicrosoft(record.data, { code, state });
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
      return {
        identity:
          provider === 'google'
            ? await this.#googleIdentity(tokens.id_token, clientId)
            : await this.#githubIdentity(tokens.access_token),
        linkUserId: record.data.linkUserId,
        invite: record.data.invite,
      };
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

  /**
   * The code exchange, the id token's signature, `iss`, `aud`, `exp`, `nonce`
   * and the PKCE verifier are `openid-client`'s. What it cannot know is this
   * install's tenant, so `iss` and `tid` are checked here too, and the first
   * link is allowed only when Microsoft vouches for the address.
   */
  async #completeMicrosoft(
    record: z.infer<typeof stateRecordSchema>,
    { code, state }: { readonly code: string; readonly state: string },
  ): Promise<OauthCompletion> {
    const { tenantId, allowConsumers } = await this.#credentials('microsoft');
    if (record.nonce === undefined) {
      throw new OauthError('The state carries no nonce for this provider');
    }
    try {
      const configuration = await this.#microsoftConfiguration();
      const callback = new URL(oauthRedirectUri(this.#appUrl, 'microsoft'));
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      const tokens = await client.authorizationCodeGrant(configuration, callback, {
        pkceCodeVerifier: record.codeVerifier,
        expectedState: state,
        expectedNonce: record.nonce,
        idTokenExpected: true,
      });
      const raw = tokens.claims() ?? {};
      const claims = microsoftClaimsSchema.parse(raw);
      const tid = claims.tid.toLowerCase();

      // Exactly the pinned tenant, and the consumers tenant only when allowed,
      // each with its own exact issuer: nothing else Microsoft issues for.
      const accepted =
        tid === tenantId || (allowConsumers && tid === MICROSOFT_CONSUMERS_TENANT_ID);
      if (!accepted || claims.iss !== MICROSOFT_IDENTITY.issuerFor(tid)) {
        throw new OauthError('The id token is from another Microsoft tenant', 'tenant-mismatch');
      }

      return {
        identity: this.#microsoftIdentity(claims, raw, tid),
        linkUserId: record.linkUserId,
        invite: record.invite,
      };
    } catch (error) {
      if (error instanceof OauthError) {
        throw error;
      }
      if (isIssuerMismatch(error)) {
        throw new OauthError('The id token is from another Microsoft tenant', 'tenant-mismatch');
      }

      // `openid-client`'s messages can carry the provider's body; none is kept.
      throw new OauthError('microsoft did not return an identity this install can use');
    }
  }

  #microsoftIdentity(
    claims: z.infer<typeof microsoftClaimsSchema>,
    raw: Record<string, unknown>,
    tid: string,
  ): OauthIdentity {
    // `preferred_username` stands in for a missing `email` claim so a bound
    // account can still sign in, but it is not evidence of the mailbox.
    const email = claims.email ?? z.email().safeParse(claims.preferred_username).data;
    if (email === undefined) {
      throw new OauthError('This Microsoft account has no email address in its token');
    }
    // The one rule the SSO preset uses (`entra.ts`): a verified-domain member of
    // the pinned tenant. A personal account is never vouched for, so it can
    // only be connected from a session.
    const authoritative =
      claims.email !== undefined && entraVouchesForEmail(MICROSOFT_IDENTITY.issuerFor(tid), raw);

    return {
      provider: 'microsoft',
      subject: `${tid}:${claims.oid.toLowerCase()}`,
      email,
      name: claims.name,
      authoritative,
      hostedDomain: undefined,
      verifiedEmails: authoritative ? [email] : [],
    };
  }

  /**
   * Discovery of the install's tenant, cached for an hour and rebuilt when the
   * tenant, client id or secret changes. Every endpoint it names must be on
   * Microsoft's host over https: a discovery document is an input, and nothing
   * in it may point the install's token request, or its secret, elsewhere.
   */
  async #microsoftConfiguration(): Promise<client.Configuration> {
    const { clientId, clientSecret, tenantId, allowConsumers } =
      await this.#credentials('microsoft');
    const key = hashToken(JSON.stringify([tenantId, allowConsumers, clientId, clientSecret]));
    if (this.#microsoft?.key === key && this.#microsoft.expires > Date.now()) {
      return this.#microsoft.configuration;
    }

    // Personal accounts sign in at the `common` authority, which Microsoft
    // documents with a templated issuer; the id token's own `tid` and `iss`
    // are still held to the accepted tenants afterwards.
    const issuer = MICROSOFT_IDENTITY.issuerFor(allowConsumers ? 'common' : tenantId);
    const expectedMetadataIssuer = allowConsumers
      ? MICROSOFT_IDENTITY.issuerFor('{tenantid}')
      : issuer;
    const configuration = await client.discovery(
      new URL(issuer),
      clientId,
      undefined,
      client.ClientSecretPost(clientSecret),
      { [client.customFetch]: this.#transport, timeout: FETCH_TIMEOUT_MS / 1000 },
    );

    const metadata = configuration.serverMetadata();
    const endpoints = [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri];
    if (
      metadata.issuer !== expectedMetadataIssuer ||
      endpoints.some((endpoint) => !this.#isMicrosoftEndpoint(endpoint))
    ) {
      throw new OauthError('Microsoft discovery named an endpoint this install does not trust');
    }

    this.#microsoft = { key, expires: Date.now() + DISCOVERY_TTL_MS, configuration };
    return configuration;
  }

  #isMicrosoftEndpoint(endpoint: string | undefined): boolean {
    if (endpoint === undefined) {
      return false;
    }
    const url = new URL(endpoint);
    return url.protocol === 'https:' && url.host === MICROSOFT_HOST;
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
    // some older responses. Anything else counts as unverified, which keeps a
    // bound subject signing in but can never make a first link.
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';

    return {
      provider: 'google',
      subject: claims.sub,
      email: claims.email,
      name: claims.name,
      authoritative: googleIsAuthoritative({
        email: claims.email,
        emailVerified,
        hostedDomain: claims.hd,
      }),
      hostedDomain: claims.hd,
      verifiedEmails: emailVerified ? [claims.email] : [],
    };
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

    return {
      provider: 'github',
      subject: String(user.id),
      email: primary.email,
      name: user.name ?? user.login,
      // A GitHub address stays "verified" after its owner loses the mailbox, so
      // GitHub never vouches for one: it links from inside a session only.
      authoritative: false,
      hostedDomain: undefined,
      verifiedEmails: emails.filter((entry) => entry.verified).map((entry) => entry.email),
    };
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
    const [clientId, clientSecret, tenantId, allowConsumers] = await Promise.all([
      this.#settings.get(`oauth.${provider}.clientId`),
      this.#settings.get(`oauth.${provider}.clientSecret`),
      provider === 'microsoft' ? this.#settings.get('oauth.microsoft.tenantId') : '',
      provider === 'microsoft' ? this.#settings.get('oauth.microsoft.allowConsumers') : false,
    ]);

    return {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      tenantId: tenantId.trim().toLowerCase(),
      allowConsumers,
    };
  }
}
