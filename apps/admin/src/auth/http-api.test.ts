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

/** The auth guard's answer to an expired token: no `error.auth`, so a refresh can cure it. */
const tokenRefused = (): Response =>
  json({ error: { code: 'unauthenticated', message: 'no', requestId: 'r1' } }, 401);

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
      .mockResolvedValueOnce(tokenRefused())
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
      .mockResolvedValueOnce(tokenRefused())
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

  it('previews a sign-in link with the token in the body, never in the path (M9-01 F6)', async () => {
    fetchMock.mockResolvedValueOnce(json({ email: 'lina@helpdock.com', expiresInMinutes: 10 }));

    await expect(new HttpAuthApi().previewMagicLink('the-token')).resolves.toEqual({
      email: 'lina@helpdock.com',
      expiresInMinutes: 10,
    });
    expect(calls()[0]?.url).toMatch(/\/auth\/magic-link\/preview$/);
    expect(calls()[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls()[0]?.init.body))).toEqual({ token: 'the-token' });
  });

  it('spends a sign-in link and keeps the token out of what the screen gets', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ kind: 'session', session, accessToken: 'a.b.c', expiresInSeconds: 600 }, 201),
      )
      .mockResolvedValueOnce(json(session));
    const api = new HttpAuthApi();

    const result = await api.consumeMagicLink('the-token');
    await api.me();

    expect(result).toEqual({ kind: 'session', session });
    expect(calls()[0]?.url).toMatch(/\/auth\/magic-link\/consume$/);
    expect(JSON.parse(String(calls()[0]?.init.body))).toEqual({ token: 'the-token' });
    expect(headerOf(calls()[1]?.init ?? {}, 'authorization')).toBe('Bearer a.b.c');
  });

  it('carries the cookie on every request, which is what the refresh depends on', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        password: true,
        magicLink: true,
        oauth: { google: true, microsoft: false, github: false },
      }),
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

  describe('sign-in providers on the security page (1.0.2)', () => {
    it('sends the step-up to connect and hands back where the browser goes', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ url: 'https://github.com/login/oauth/authorize?x=1' }),
      );

      const url = await new HttpAuthApi().connectOauth('github', { currentPassword: 'pw' });

      expect(url).toBe('https://github.com/login/oauth/authorize?x=1');
      expect(calls()[0]?.url).toMatch(/\/auth\/oauth\/github\/connect$/);
      expect(JSON.parse(String(calls()[0]?.init.body))).toEqual({ currentPassword: 'pw' });
    });

    it('turns a refused disconnect into the code the card names', async () => {
      fetchMock.mockResolvedValueOnce(authFailure('oauth-last-sign-in', 409));

      const refused = await new HttpAuthApi()
        .disconnectOauth('google', { code: '123456' })
        .catch((error: unknown) => error as AuthError);

      expect(refused?.code).toBe('oauth-last-sign-in');
      expect(calls()[0]?.url).toMatch(/\/auth\/oauth\/google\/disconnect$/);
    });
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

  describe('passkeys (M18-02)', () => {
    const CEREMONY = 'A'.repeat(43);
    const passkey = {
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
      name: 'MacBook',
      createdAt: '2026-10-20T10:00:00.000Z',
      lastUsedAt: null,
      synced: true,
    };

    it('reads the list', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          passkeys: [passkey],
          limit: 10,
          state: 'available',
          removalBlocked: false,
          authenticatorApp: true,
        }),
      );

      const list = await new HttpAuthApi().passkeys();

      expect(list.passkeys).toEqual([passkey]);
      expect(calls()[0]?.url).toBe('/api/me/passkeys');
    });

    it('sends the proof with begin, and the answer and name with finish', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ ceremonyId: CEREMONY, options: { challenge: 'x' } }))
        .mockResolvedValueOnce(json(passkey, 201));
      const api = new HttpAuthApi();

      await api.beginPasskey({ currentPassword: 'a password' });
      await api.finishPasskey({
        ceremonyId: CEREMONY,
        name: 'MacBook',
        response: {
          id: 'AQID',
          rawId: 'AQID',
          type: 'public-key',
          response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
          clientExtensionResults: {},
        },
      });

      expect(calls().map(({ url, init }) => [init.method, url])).toEqual([
        ['POST', '/api/me/passkeys/begin'],
        ['POST', '/api/me/passkeys/finish'],
      ]);
      expect(JSON.parse(String(calls()[0]?.init.body))).toEqual({
        proof: { currentPassword: 'a password' },
      });
    });

    it('renames with PATCH and removes with DELETE, each carrying its proof in the body', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ ...passkey, name: 'Desk' }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const api = new HttpAuthApi();

      await api.renamePasskey(passkey.id, 'Desk', { code: '123456' });
      await api.removePasskey(passkey.id, { code: '123456' });

      expect(calls().map(({ url, init }) => [init.method, url])).toEqual([
        ['PATCH', `/api/me/passkeys/${passkey.id}`],
        ['DELETE', `/api/me/passkeys/${passkey.id}`],
      ]);
      expect(JSON.parse(String(calls()[0]?.init.body))).toEqual({
        name: 'Desk',
        proof: { code: '123456' },
      });
      expect(JSON.parse(String(calls()[1]?.init.body))).toEqual({ proof: { code: '123456' } });
    });

    it('does not retry a refused proof as an expired token', async () => {
      fetchMock.mockResolvedValue(authFailure('invalid-credentials'));
      const api = new HttpAuthApi();

      await expect(
        api.removePasskey(passkey.id, { currentPassword: 'wrong' }),
      ).rejects.toMatchObject({
        code: 'invalid-credentials',
      });
      expect(calls()).toHaveLength(1);
    });

    it('carries the api’s refusal code for the last second factor', async () => {
      fetchMock.mockResolvedValueOnce(authFailure('second-factor-required', 409));

      await expect(
        new HttpAuthApi().removePasskey(passkey.id, { currentPassword: 'a password' }),
      ).rejects.toMatchObject({ code: 'second-factor-required' });
    });

    it('refuses a list that is not the contract', async () => {
      fetchMock.mockResolvedValueOnce(json({ passkeys: 'none' }));

      await expect(new HttpAuthApi().passkeys()).rejects.toThrow();
    });

    it('hands the recovery codes drawn with a first passkey to the card', async () => {
      fetchMock.mockResolvedValueOnce(json({ ...passkey, recoveryCodes: ['AAAA-1111'] }, 201));

      const added = await new HttpAuthApi().finishPasskey({
        ceremonyId: CEREMONY,
        name: 'MacBook',
        response: {
          id: 'AQID',
          rawId: 'AQID',
          type: 'public-key',
          response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
          clientExtensionResults: {},
        },
      });

      expect(added.recoveryCodes).toEqual(['AAAA-1111']);
    });
  });

  describe('a passkey as the second factor (M18-03)', () => {
    const CEREMONY = 'A'.repeat(43);
    const assertion = {
      id: 'AQID',
      rawId: 'AQID',
      type: 'public-key' as const,
      response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
      clientExtensionResults: {},
    };

    it('asks for options with the challenge, and answers it with the ceremony, the assertion and the trust choice', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ ceremonyId: CEREMONY, options: { challenge: 'x' } }))
        .mockResolvedValueOnce(
          json({ kind: 'session', session, accessToken: 'a.b.c', expiresInSeconds: 600 }, 201),
        );
      const api = new HttpAuthApi();

      const options = await api.passkeySecondFactorOptions('c1');
      const signedIn = await api.verifyPasskey(
        'c1',
        { ceremonyId: options.ceremonyId, response: assertion },
        { trustDevice: true },
      );

      expect(signedIn.user.email).toBe('lina@helpdock.com');
      expect(calls().map(({ init, url }) => [init.method, url])).toEqual([
        ['POST', '/api/auth/passkey/second-factor/options'],
        ['POST', '/api/auth/passkey/second-factor/verify'],
      ]);
      expect(JSON.parse(String(calls()[0]?.init.body))).toEqual({ challengeId: 'c1' });
      expect(JSON.parse(String(calls()[1]?.init.body))).toEqual({
        challengeId: 'c1',
        ceremonyId: CEREMONY,
        response: assertion,
        trustDevice: true,
      });
    });

    it('carries the attempts left when the api refuses the passkey', async () => {
      fetchMock.mockResolvedValueOnce(authFailure('passkey-invalid', 401, 2));

      const refusal = (await new HttpAuthApi()
        .verifyPasskey('c1', { ceremonyId: CEREMONY, response: assertion }, { trustDevice: false })
        .catch((error: unknown) => error)) as AuthError;

      expect(refusal).toMatchObject({ code: 'passkey-invalid', attemptsLeft: 2 });
    });

    it('enrols a passkey from an enrolment challenge and keeps the session it opens', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ ceremonyId: CEREMONY, options: { challenge: 'x' } }))
        .mockResolvedValueOnce(
          json(
            {
              recoveryCodes: ['AAAA-1111'],
              session,
              accessToken: 'a.b.c',
              expiresInSeconds: 600,
            },
            201,
          ),
        );
      const api = new HttpAuthApi();

      await api.startPasskeyEnrolment('e1');
      const done = await api.completePasskeyEnrolment('e1', {
        ceremonyId: CEREMONY,
        name: 'MacBook',
        response: {
          id: 'AQID',
          rawId: 'AQID',
          type: 'public-key',
          response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
          clientExtensionResults: {},
        },
      });

      expect(done.recoveryCodes).toEqual(['AAAA-1111']);
      expect(done.session.user.email).toBe('lina@helpdock.com');
      expect(calls().map(({ url }) => url)).toEqual([
        '/api/auth/enrolment/passkey/options',
        '/api/auth/enrolment/passkey/confirm',
      ]);
      expect(await api.accessToken()).toBe('a.b.c');
    });

    it('reads a challenge that names its factors, and the old enrolment name', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json({
            kind: 'totp-required',
            challengeId: 'c1',
            email: 'lina@helpdock.com',
            factors: { totp: false, passkey: true },
          }),
        )
        .mockResolvedValueOnce(json({ kind: 'totp-enrolment-required', challengeId: 'e1' }));
      const api = new HttpAuthApi();

      await expect(api.signInWithPassword('lina@helpdock.com', 'x')).resolves.toMatchObject({
        factors: { totp: false, passkey: true },
      });
      await expect(api.signInWithPassword('lina@helpdock.com', 'x')).resolves.toEqual({
        kind: 'second-factor-enrolment-required',
        challengeId: 'e1',
      });
    });
  });
});
