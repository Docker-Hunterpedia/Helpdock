import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import type { CustomFetch } from 'openid-client';
import { vi } from 'vitest';
import {
  GITHUB_IDENTITY,
  GOOGLE_IDENTITY,
  MICROSOFT_IDENTITY,
  OAUTH_PROVIDERS,
} from '../auth/oauth/providers.js';

/**
 * Google and GitHub as `fetch` sees them, for the OAuth tests. Google's id token
 * is a real RS256 JWT verified against a real key set, so the issuer, audience
 * and signature checks run as they do in production; only the hosts are faked.
 */

const KEY_ID = 'helpdock-test-key';

export interface FakeGoogle {
  /** An id token as Google would sign it for `audience`. */
  idToken(claims: JWTPayload, audience?: string): Promise<string>;
  /** A `fetch` that answers the token endpoint with `idToken` and the key set with this key. */
  fetch(idToken: string): ReturnType<typeof vi.fn>;
}

export const createFakeGoogle = async (): Promise<FakeGoogle> => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256' }] };

  return {
    idToken: (claims, audience = 'client-id') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
        .setIssuer('https://accounts.google.com')
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey),
    fetch: (idToken) =>
      vi.fn(async (url: string | URL) => {
        const target = String(url);
        if (target === GOOGLE_IDENTITY.jwksUrl) {
          return new Response(JSON.stringify(jwks));
        }
        if (target === OAUTH_PROVIDERS.google.tokenUrl) {
          return new Response(JSON.stringify({ id_token: idToken }));
        }
        throw new Error(`The fake Google was asked for ${target}`);
      }),
  };
};

export interface FakeGithubAccount {
  readonly id: number;
  /** The verified primary address. */
  readonly email: string;
  readonly login?: string;
  /** More verified, non-primary addresses on the account. */
  readonly alsoVerified?: readonly string[];
}

/** A `fetch` that answers GitHub's token, emails and user endpoints for one account. */
export const fakeGithubFetch = ({
  id,
  email,
  login = 'octocat',
  alsoVerified = [],
}: FakeGithubAccount): ReturnType<typeof vi.fn> =>
  vi.fn(async (url: string | URL) => {
    const target = String(url);
    if (target === OAUTH_PROVIDERS.github.tokenUrl) {
      return new Response(JSON.stringify({ access_token: 'gho_test' }));
    }
    if (target === GITHUB_IDENTITY.emailsUrl) {
      return new Response(
        JSON.stringify([
          { email, primary: true, verified: true },
          ...alsoVerified.map((other) => ({ email: other, primary: false, verified: true })),
        ]),
      );
    }
    if (target === GITHUB_IDENTITY.userUrl) {
      return new Response(JSON.stringify({ id, name: null, login }));
    }
    throw new Error(`The fake GitHub was asked for ${target}`);
  });

export interface FakeMicrosoftOptions {
  /** The tenant this stand-in is the directory of: its issuer and its endpoints. */
  readonly tenantId: string;
  /**
   * Serve the `common` authority, whose discovery document names a templated
   * issuer: what Microsoft does for an app that accepts personal accounts.
   */
  readonly common?: boolean;
  /** The `issuer` its discovery document claims, when a test wants it to lie. */
  readonly discoveryIssuer?: string;
  /** Where its discovery document says the token endpoint is, when a test wants it elsewhere. */
  readonly tokenEndpoint?: string;
}

export interface FakeMicrosoftToken {
  /** `iss` when it is not that of the token's `tid` (default: the tenant, or the claim's `tid`). */
  readonly issuer?: string;
  readonly audience?: string;
  /** The nonce from the authorization URL the flow was started with. */
  readonly nonce: string;
}

export interface FakeMicrosoft {
  readonly issuer: string;
  /** An id token as Entra would sign it for this tenant, unless `issuer` says otherwise. */
  idToken(claims: JWTPayload, token: FakeMicrosoftToken): Promise<string>;
  /** A transport answering discovery, the key set and the token endpoint (with `idToken`). */
  transport(idToken: string): ReturnType<typeof vi.fn<CustomFetch>>;
}

const MICROSOFT_ORIGIN = MICROSOFT_IDENTITY.authority;

/**
 * Microsoft Entra as `openid-client` sees it: the discovery document of one
 * tenant, its key set and its token endpoint, answered in place of the SSRF-safe
 * transport. The id token is a real RS256 JWT, so the library's own checks of
 * signature, issuer, audience, expiry and nonce run as in production.
 */
export const createFakeMicrosoft = async ({
  tenantId,
  common = false,
  discoveryIssuer,
  tokenEndpoint,
}: FakeMicrosoftOptions): Promise<FakeMicrosoft> => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256' }] };
  const issuer = MICROSOFT_IDENTITY.issuerFor(tenantId);
  const authority = common ? 'common' : tenantId;
  const endpoints = {
    discovery: `${MICROSOFT_IDENTITY.issuerFor(authority)}/.well-known/openid-configuration`,
    authorize: `${MICROSOFT_ORIGIN}/${authority}/oauth2/v2.0/authorize`,
    token: tokenEndpoint ?? `${MICROSOFT_ORIGIN}/${authority}/oauth2/v2.0/token`,
    keys: `${MICROSOFT_ORIGIN}/${authority}/discovery/v2.0/keys`,
  };
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  return {
    issuer,
    idToken: (claims, { issuer: iss, audience = 'client-id', nonce }) =>
      new SignJWT({ sub: 'pairwise-sub', ...claims, nonce })
        .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
        .setIssuer(
          iss ??
            (typeof claims.tid === 'string' ? MICROSOFT_IDENTITY.issuerFor(claims.tid) : issuer),
        )
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey),
    transport: (idToken) =>
      vi.fn<CustomFetch>(async (input) => {
        const target = String(input);
        if (target === endpoints.discovery) {
          return json({
            issuer:
              discoveryIssuer ?? (common ? MICROSOFT_IDENTITY.issuerFor('{tenantid}') : issuer),
            authorization_endpoint: endpoints.authorize,
            token_endpoint: endpoints.token,
            jwks_uri: endpoints.keys,
            response_types_supported: ['code', 'id_token', 'code id_token'],
            subject_types_supported: ['pairwise'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['client_secret_post'],
            code_challenge_methods_supported: ['S256'],
          });
        }
        if (target === endpoints.keys) {
          return json(jwks);
        }
        if (target === endpoints.token) {
          return json({ token_type: 'Bearer', access_token: 'opaque', id_token: idToken });
        }
        throw new Error(`The fake Microsoft was asked for ${target}`);
      }),
  };
};
