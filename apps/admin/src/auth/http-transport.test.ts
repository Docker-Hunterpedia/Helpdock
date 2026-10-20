import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from './http-transport.js';

/**
 * Which 401 the transport answers with a refresh (#271). The auth guard's 401
 * means the bearer token is spent; a 401 that carries `error.auth` refused the
 * password or code in the body, and repeating it would spend a second attempt
 * against the step-up limit.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** What `AuthGuard` answers for a missing or expired bearer token. */
const tokenRefused = (): Response =>
  json(
    {
      error: {
        code: 'unauthenticated',
        message: 'Authentication is required for this route',
        requestId: 'r1',
      },
    },
    401,
  );

/** What a step-up answers for a wrong current password or authenticator code. */
const credentialRefused = (code: 'invalid-credentials' | 'totp-mismatch'): Response =>
  json({ error: { code: 'unauthenticated', message: 'no', requestId: 'r2', auth: { code } } }, 401);

const BRAND_ID = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const session = {
  user: {
    id: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
    name: 'Lina Haddad',
    email: 'lina@helpdock.com',
    role: 'admin',
    installAdmin: true,
  },
  brands: [{ id: BRAND_ID, name: 'Helpdock', domain: 'support.helpdock.com', ticketPrefix: 'HD' }],
  currentBrandId: BRAND_ID,
};

const fresh = (): Response => json({ session, accessToken: 'fresh', expiresInSeconds: 600 });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const urls = (): string[] => fetchMock.mock.calls.map(([url]) => String(url));

const bearerOf = (call: number): string | undefined =>
  (
    (fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined
  )?.authorization;

const signedIn = (): HttpTransport => {
  const transport = new HttpTransport();
  transport.keepSession({ accessToken: 'held', expiresInSeconds: 600 });
  return transport;
};

describe('HttpTransport on a 401', () => {
  it.each(['invalid-credentials', 'totp-mismatch'] as const)(
    'sends a step-up refused with %s once, and keeps the session',
    async (code) => {
      fetchMock.mockResolvedValueOnce(credentialRefused(code)).mockResolvedValueOnce(json({}));
      const transport = signedIn();

      await expect(
        transport.request('POST', '/me/password', { currentPassword: 'wrong' }),
      ).rejects.toMatchObject({ code });
      await transport.request('GET', '/auth/me');

      expect(urls()).toEqual(['/api/me/password', '/api/auth/me']);
      expect(bearerOf(1)).toBe('Bearer held');
    },
  );

  it('refreshes once on an expired token and repeats the request with the new one', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRefused())
      .mockResolvedValueOnce(fresh())
      .mockResolvedValueOnce(json({ ok: true }));

    await expect(signedIn().request('GET', '/auth/me')).resolves.toEqual({ ok: true });

    expect(urls()).toEqual(['/api/auth/me', '/api/auth/refresh', '/api/auth/me']);
    expect(bearerOf(2)).toBe('Bearer fresh');
  });
});

describe('429 sign-in refusals', () => {
  it.each([true, false])('carries Retry-After with an auth envelope: %s', async (envelope) => {
    const response = new Response(
      JSON.stringify(
        envelope
          ? {
              error: {
                code: 'rate_limited',
                message: 'Too many sign-in attempts',
                requestId: 'r',
                auth: { code: 'rate-limited' },
              },
            }
          : {},
      ),
      { status: 429, headers: { 'Retry-After': '121' } },
    );
    fetchMock.mockResolvedValueOnce(response);
    await expect(new HttpTransport().request('POST', '/auth/sign-in', {})).rejects.toMatchObject({
      code: 'rate-limited',
      retryAfter: 121,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
