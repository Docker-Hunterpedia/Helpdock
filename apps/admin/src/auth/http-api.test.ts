import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthError } from './api.js';
import { HttpAuthApi } from './http-api.js';

/**
 * The adapter is tested against a stubbed `fetch` rather than a server: what
 * matters here is what it sends, what it keeps, and what it does with a 401.
 * That the endpoints behind it behave is the api's integration suite.
 */

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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const authFailure = (code: string, status = 401, attemptsLeft?: number): Response =>
  json(
    {
      error: {
        code: 'unauthenticated',
        message: 'no',
        requestId: 'r1',
        auth: { code, ...(attemptsLeft === undefined ? {} : { attemptsLeft }) },
      },
    },
    status,
  );

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = (): { url: string; init: RequestInit }[] =>
  fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));

const headerOf = (init: RequestInit, name: string): string | undefined =>
  (init.headers as Record<string, string> | undefined)?.[name];

describe('HttpAuthApi', () => {
  it('keeps the access token out of the value it hands the screens', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ kind: 'session', session, accessToken: 'a.b.c', expiresInSeconds: 600 }),
    );
    const api = new HttpAuthApi();

    const result = await api.signInWithPassword(' LINA@helpdock.com ', 'correct horse');

    expect(result).toEqual({ kind: 'session', session });
    expect(JSON.stringify(result)).not.toContain('a.b.c');
  });

  it('trims the address it sends, so a pasted one still matches', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ kind: 'session', session, accessToken: 'a.b.c', expiresInSeconds: 600 }),
    );

    await new HttpAuthApi().signInWithPassword('  lina@helpdock.com ', 'correct horse');

    expect(JSON.parse(String(calls()[0]?.init.body))).toMatchObject({
      email: 'lina@helpdock.com',
    });
  });

  it('attaches the token it was given to the next request', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ kind: 'session', session, accessToken: 'a.b.c', expiresInSeconds: 600 }),
      )
      .mockResolvedValueOnce(json(session));
    const api = new HttpAuthApi();

    await api.signInWithPassword('lina@helpdock.com', 'correct horse');
    await api.me();

    expect(headerOf(calls()[1]?.init ?? {}, 'authorization')).toBe('Bearer a.b.c');
  });

  it('refreshes once on a 401 and repeats the request with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ kind: 'session', session, accessToken: 'stale', expiresInSeconds: 600 }),
      )
      .mockResolvedValueOnce(authFailure('invalid-credentials'))
      .mockResolvedValueOnce(json({ session, accessToken: 'fresh', expiresInSeconds: 600 }))
      .mockResolvedValueOnce(json(session));
    const api = new HttpAuthApi();

    await api.signInWithPassword('lina@helpdock.com', 'correct horse');
    await expect(api.me()).resolves.toMatchObject({ currentBrandId: BRAND_ID });

    const urls = calls().map((call) => call.url);
    expect(urls).toEqual([
      '/api/auth/sign-in',
      '/api/auth/me',
      '/api/auth/refresh',
      '/api/auth/me',
    ]);
    expect(headerOf(calls()[3]?.init ?? {}, 'authorization')).toBe('Bearer fresh');
  });

  it('gives up rather than looping when the refresh itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ kind: 'session', session, accessToken: 'stale', expiresInSeconds: 600 }),
      )
      .mockResolvedValueOnce(authFailure('invalid-credentials'))
      .mockResolvedValueOnce(authFailure('challenge-expired'));
    const api = new HttpAuthApi();

    await api.signInWithPassword('lina@helpdock.com', 'correct horse');

    await expect(api.me()).resolves.toBeNull();
    expect(calls()).toHaveLength(3);
  });

  it('reads the session on a cold load by refreshing first', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ session, accessToken: 'fresh', expiresInSeconds: 600 }))
      .mockResolvedValueOnce(json(session));

    await expect(new HttpAuthApi().me()).resolves.toMatchObject({ currentBrandId: BRAND_ID });
    expect(calls().map((call) => call.url)).toEqual(['/api/auth/refresh', '/api/auth/me']);
  });

  it('answers null, not an error, when there is no session to refresh', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));

    await expect(new HttpAuthApi().me()).resolves.toBeNull();
  });

  it('turns the api failure detail into the code and count the screens read', async () => {
    // No token has been issued yet at the second-factor step, so this 401 is
    // the answer and not an expiry: it must not be refreshed and retried.
    fetchMock.mockResolvedValueOnce(authFailure('totp-mismatch', 401, 2));

    const error = (await new HttpAuthApi()
      .verifyTotp('c1', '000000', { trustDevice: false })
      .catch((caught: AuthError) => caught)) as AuthError;

    expect([error.code, error.attemptsLeft]).toEqual(['totp-mismatch', 2]);
  });

  it('falls back to "unavailable" for a failure that is not the api speaking', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));

    await expect(new HttpAuthApi().authMethods()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('forgets the token even when the sign-out request fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ kind: 'session', session, accessToken: 'a.b.c', expiresInSeconds: 600 }),
      )
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    const api = new HttpAuthApi();

    await api.signInWithPassword('lina@helpdock.com', 'correct horse');
    await expect(api.signOut()).rejects.toBeDefined();

    await expect(api.me()).resolves.toBeNull();
    expect(headerOf(calls()[2]?.init ?? {}, 'authorization')).toBeUndefined();
  });

  it('sends the one-time code from a redirect and keeps what comes back', async () => {
    fetchMock.mockResolvedValueOnce(json({ session, accessToken: 'a.b.c', expiresInSeconds: 600 }));

    await expect(new HttpAuthApi().exchange('one-time')).resolves.toMatchObject({
      currentBrandId: BRAND_ID,
    });
    expect(JSON.parse(String(calls()[0]?.init.body))).toEqual({ code: 'one-time' });
  });

  it('carries the cookie on every request, which is what the refresh depends on', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ password: true, magicLink: true, oauth: { google: true, github: false } }),
    );

    await new HttpAuthApi().authMethods();

    expect(calls()[0]?.init.credentials).toBe('same-origin');
  });

  it('answers 204 endpoints without trying to parse a body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      new HttpAuthApi().requestPasswordReset('stranger@example.com'),
    ).resolves.toBeUndefined();
  });

  describe('accessToken, which the socket handshake carries (M0-13)', () => {
    it('refreshes when this tab holds none, so a socket after a reload gets one', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ session, accessToken: 'fresh.token', expiresInSeconds: 600 }),
      );
      const api = new HttpAuthApi();

      expect(await api.accessToken()).toBe('fresh.token');
      expect(calls()[0]?.url).toBe('/api/auth/refresh');
    });

    it('hands over the token it already holds without a round trip', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ kind: 'session', session, accessToken: 'a.b.c', expiresInSeconds: 600 }),
      );
      const api = new HttpAuthApi();
      await api.signInWithPassword('lina@helpdock.com', 'correct horse');

      expect(await api.accessToken()).toBe('a.b.c');
      expect(calls()).toHaveLength(1);
    });

    it('answers null when there is no session to refresh', async () => {
      fetchMock.mockResolvedValueOnce(authFailure('session-expired'));

      expect(await new HttpAuthApi().accessToken()).toBeNull();
    });
  });
});
