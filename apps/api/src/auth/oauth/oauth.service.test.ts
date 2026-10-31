import { createHash } from 'node:crypto';
import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  type Settings,
} from '@helpdock/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import { createFakeGoogle, fakeGithubFetch } from '../../testing/fake-oauth-providers.js';
import type { RedisStub } from '../../testing/redis-stub.js';
import { silentLogger } from '../../testing/silent-logger.js';
import { hashToken, oauthStateKey } from '../redis-keys.js';
import { OauthError, OauthService } from './oauth.service.js';
import { oauthRedirectUri } from './providers.js';

const APP_URL = 'https://support.example.com';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

let stub: RedisStub;
let settings: Settings;
let service: OauthService;

const noInvalidation = {
  subscribe: () => () => {},
  publish: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  settings = createSettings({
    env: {},
    store: new InMemorySettingsStore(),
    keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY }),
    invalidation: noInvalidation,
  });
  service = new OauthService({
    settings,
    redis: created.redis,
    logger: silentLogger(),
    appUrl: APP_URL,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const configure = async (provider: 'google' | 'github'): Promise<void> => {
  await settings.set(`oauth.${provider}.clientId`, 'client-id', { updatedBy: 'test' });
  await settings.set(`oauth.${provider}.clientSecret`, 'client-secret', { updatedBy: 'test' });
};

const stateOf = (url: string): string => new URL(url).searchParams.get('state') ?? '';

/** A flow begun in one browser: the state in the URL, and the nonce that browser's cookie carries. */
const started = async (provider: 'google' | 'github') => {
  const { url, browserNonce } = await service.start(provider);
  return { state: stateOf(url), browserNonce };
};

describe('isEnabled', () => {
  it('is off until a client id and secret are set, which is what hides the button', async () => {
    await expect(service.isEnabled('google')).resolves.toBe(false);

    await configure('google');

    await expect(service.isEnabled('google')).resolves.toBe(true);
  });

  it.each(['google', 'github'] as const)(
    'keeps %s off with a client id and no secret, since its token exchange would fail',
    async (provider) => {
      await settings.set(`oauth.${provider}.clientId`, 'client-id', { updatedBy: 'test' });

      await expect(service.isEnabled(provider)).resolves.toBe(false);
      await expect(service.start(provider)).rejects.toBeInstanceOf(OauthError);
    },
  );

  it.each(['google', 'github'] as const)(
    'keeps %s off with a secret and no client id',
    async (provider) => {
      await settings.set(`oauth.${provider}.clientSecret`, 'client-secret', { updatedBy: 'test' });

      await expect(service.isEnabled(provider)).resolves.toBe(false);
    },
  );

  it.each(['google', 'github'] as const)('turns %s on with both', async (provider) => {
    await configure(provider);

    await expect(service.isEnabled(provider)).resolves.toBe(true);
  });
});

describe('start', () => {
  it('refuses to start a provider that is not configured', async () => {
    await expect(service.start('github')).rejects.toBeInstanceOf(OauthError);
  });

  it('builds the provider URL with the redirect this install owns', async () => {
    await configure('google');

    const url = new URL((await service.start('google')).url);

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(oauthRedirectUri(APP_URL, 'google'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-id');
  });

  it('sends PKCE, and keeps the verifier on the server', async () => {
    await configure('google');

    const url = new URL((await service.start('google')).url);
    const challenge = url.searchParams.get('code_challenge') ?? '';
    const stored = JSON.parse(
      (await stub.get(oauthStateKey(hashToken(stateOf(url.toString()))))) ?? '{}',
    ) as { codeVerifier: string };

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(createHash('sha256').update(stored.codeVerifier).digest('base64url')).toBe(challenge);
    expect(url.toString()).not.toContain(stored.codeVerifier);
  });

  it('stores the state hashed and never in the clear', async () => {
    await configure('google');

    const { state, browserNonce } = await started('google');

    expect(stub.keys()).toEqual([oauthStateKey(hashToken(state))]);
    expect(stub.keys().join(' ')).not.toContain(state);
    expect((await stub.get(oauthStateKey(hashToken(state)))) ?? '').not.toContain(browserNonce);
  });

  it('draws a new state every time, so one cannot be replayed', async () => {
    await configure('google');

    expect((await started('google')).state).not.toBe((await started('google')).state);
  });
});

describe('complete', () => {
  it('refuses a callback with a state this install never issued', async () => {
    await configure('google');

    await expect(
      service.complete({
        provider: 'google',
        code: 'c',
        state: 'forged',
        browserNonce: 'whatever',
      }),
    ).rejects.toBeInstanceOf(OauthError);
  });

  // F4 (M9-01): the state alone is bearer. Whoever holds a captured callback URL
  // could finish someone else's flow in a victim's browser, signing the victim
  // in as the attacker.
  it.each([
    ['a browser that did not start the flow', 'a-nonce-this-flow-never-issued'],
    ['a browser with no cookie at all', undefined],
  ])(
    'refuses a callback from %s, before it asks the provider for anything',
    async (_who, nonce) => {
      await configure('google');
      const { state } = await started('google');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        service.complete({ provider: 'google', code: 'c', state, browserNonce: nonce }),
      ).rejects.toBeInstanceOf(OauthError);

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('refuses a state that belongs to the other provider', async () => {
    await configure('google');
    await configure('github');
    const { state, browserNonce } = await started('google');

    await expect(
      service.complete({ provider: 'github', code: 'c', state, browserNonce }),
    ).rejects.toBeInstanceOf(OauthError);
  });

  it('spends the state, so a callback cannot be replayed', async () => {
    await configure('google');
    const { state, browserNonce } = await started('google');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));

    await expect(
      service.complete({ provider: 'google', code: 'c', state, browserNonce }),
    ).rejects.toBeDefined();
    await expect(
      service.complete({ provider: 'google', code: 'c', state, browserNonce }),
    ).rejects.toBeDefined();

    expect(stub.keys()).toEqual([]);
  });

  it('sends the code verifier to the token endpoint and nothing else of the state', async () => {
    await configure('google');
    const { state, browserNonce } = await started('google');
    const stored = JSON.parse((await stub.get(oauthStateKey(hashToken(state)))) ?? '{}') as {
      codeVerifier: string;
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      service.complete({ provider: 'google', code: 'c', state, browserNonce }),
    ).rejects.toBeInstanceOf(OauthError);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(body.get('code_verifier')).toBe(stored.codeVerifier);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(oauthRedirectUri(APP_URL, 'google'));
  });

  it('takes the verified primary address from GitHub, and lists every verified one', async () => {
    await configure('github');
    const { state, browserNonce } = await started('github');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'gho_x' })))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              { email: 'old@helpdock.com', primary: false, verified: true },
              { email: 'lina@helpdock.com', primary: true, verified: true },
              { email: 'unproven@helpdock.com', primary: false, verified: false },
            ]),
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 583231, name: 'Lina', login: 'lina' })),
        ),
    );

    await expect(
      service.complete({ provider: 'github', code: 'c', state, browserNonce }),
    ).resolves.toEqual({
      identity: {
        provider: 'github',
        subject: '583231',
        email: 'lina@helpdock.com',
        name: 'Lina',
        // GitHub never vouches for an address (1.0.1): it links from a session only.
        authoritative: false,
        hostedDomain: undefined,
        // An invitation accepts any of these (M18-07); the unverified one is not among them.
        verifiedEmails: ['old@helpdock.com', 'lina@helpdock.com'],
      },
      linkUserId: undefined,
      invite: undefined,
    });
  });

  it.each([
    ['a Workspace account on its own domain', { hd: 'helpdock.com' }, 'lina@helpdock.com', true],
    ['a consumer account on a third-party address', {}, 'lina@helpdock.com', false],
    ['a Gmail address', {}, 'lina@gmail.com', true],
    ['an unverified Gmail address', { email_verified: false }, 'lina@gmail.com', false],
  ])(
    'binds Google by subject and says whether it controls %s, with its hd',
    async (_case, extra, email, authoritative) => {
      await configure('google');
      const google = await createFakeGoogle();
      const { state, browserNonce } = await started('google');
      vi.stubGlobal(
        'fetch',
        google.fetch(await google.idToken({ sub: '1049', email, email_verified: true, ...extra })),
      );

      const { identity } = await service.complete({
        provider: 'google',
        code: 'c',
        state,
        browserNonce,
      });

      expect(identity).toMatchObject({ provider: 'google', subject: '1049', email, authoritative });
      // The Workspace domain travels with the identity, for oauth.google.allowedDomains.
      expect(identity.hostedDomain).toBe('hd' in extra ? extra.hd : undefined);
    },
  );

  it('refuses a Google id token minted for another application', async () => {
    await configure('google');
    const google = await createFakeGoogle();
    const { state, browserNonce } = await started('google');
    vi.stubGlobal(
      'fetch',
      google.fetch(
        await google.idToken(
          { sub: '1049', email: 'lina@gmail.com', email_verified: true },
          'other',
        ),
      ),
    );

    await expect(
      service.complete({ provider: 'google', code: 'c', state, browserNonce }),
    ).rejects.toBeInstanceOf(OauthError);
  });

  it('hands back the account that started a connect flow, and only from its own state', async () => {
    await configure('github');
    const linkUserId = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
    const { url, browserNonce } = await service.start('github', { linkUserId });
    vi.stubGlobal('fetch', fakeGithubFetch({ id: 7, email: 'lina@helpdock.com' }));

    const completed = await service.complete({
      provider: 'github',
      code: 'c',
      state: stateOf(url),
      browserNonce,
    });

    expect(completed.linkUserId).toBe(linkUserId);
  });

  it('refuses a GitHub account whose primary address is unverified', async () => {
    await configure('github');
    const { state, browserNonce } = await started('github');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'gho_x' })))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([{ email: 'lina@helpdock.com', primary: true, verified: false }]),
          ),
        ),
    );

    await expect(
      service.complete({ provider: 'github', code: 'c', state, browserNonce }),
    ).rejects.toBeInstanceOf(OauthError);
  });

  it('refuses when the provider answers the token request with an error', async () => {
    await configure('github');
    const { state, browserNonce } = await started('github');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));

    await expect(
      service.complete({ provider: 'github', code: 'c', state, browserNonce }),
    ).rejects.toBeInstanceOf(OauthError);
  });
});

describe('oauthRedirectUri', () => {
  it('is built from APP_URL, so nothing in a request can change where a person lands', () => {
    expect(oauthRedirectUri(APP_URL, 'github')).toBe(
      'https://support.example.com/api/auth/oauth/github/callback',
    );
  });
});
