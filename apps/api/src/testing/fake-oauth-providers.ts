import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { vi } from 'vitest';
import { GITHUB_IDENTITY, GOOGLE_IDENTITY, OAUTH_PROVIDERS } from '../auth/oauth/providers.js';

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
  readonly email: string;
  readonly login?: string;
}

/** A `fetch` that answers GitHub's token, emails and user endpoints for one account. */
export const fakeGithubFetch = ({ id, email, login = 'octocat' }: FakeGithubAccount) =>
  vi.fn(async (url: string | URL) => {
    const target = String(url);
    if (target === OAUTH_PROVIDERS.github.tokenUrl) {
      return new Response(JSON.stringify({ access_token: 'gho_test' }));
    }
    if (target === GITHUB_IDENTITY.emailsUrl) {
      return new Response(JSON.stringify([{ email, primary: true, verified: true }]));
    }
    if (target === GITHUB_IDENTITY.userUrl) {
      return new Response(JSON.stringify({ id, name: null, login }));
    }
    throw new Error(`The fake GitHub was asked for ${target}`);
  });
