import { createHash } from 'node:crypto';
import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  type Settings,
} from '@helpdock/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
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

describe('isEnabled', () => {
  it('is off until a client id is set, which is what hides the button', async () => {
    await expect(service.isEnabled('google')).resolves.toBe(false);

    await configure('google');

    await expect(service.isEnabled('google')).resolves.toBe(true);
  });
});

describe('start', () => {
  it('refuses to start a provider that is not configured', async () => {
    await expect(service.start('github')).rejects.toBeInstanceOf(OauthError);
  });

  it('builds the provider URL with the redirect this install owns', async () => {
    await configure('google');

    const url = new URL(await service.start('google'));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(oauthRedirectUri(APP_URL, 'google'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-id');
  });

  it('sends PKCE, and keeps the verifier on the server', async () => {
    await configure('google');

    const url = new URL(await service.start('google'));
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

    const state = stateOf(await service.start('google'));

    expect(stub.keys()).toEqual([oauthStateKey(hashToken(state))]);
    expect(stub.keys().join(' ')).not.toContain(state);
  });

  it('draws a new state every time, so one cannot be replayed', async () => {
    await configure('google');

    expect(stateOf(await service.start('google'))).not.toBe(stateOf(await service.start('google')));
  });
});

describe('complete', () => {
  it('refuses a callback with a state this install never issued', async () => {
    await configure('google');

    await expect(
      service.complete({ provider: 'google', code: 'c', state: 'forged' }),
    ).rejects.toBeInstanceOf(OauthError);
  });

  it('refuses a state that belongs to the other provider', async () => {
    await configure('google');
    await configure('github');
    const state = stateOf(await service.start('google'));

    await expect(service.complete({ provider: 'github', code: 'c', state })).rejects.toBeInstanceOf(
      OauthError,
    );
  });

  it('spends the state, so a callback cannot be replayed', async () => {
    await configure('google');
    const state = stateOf(await service.start('google'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));

    await expect(service.complete({ provider: 'google', code: 'c', state })).rejects.toBeDefined();
    await expect(service.complete({ provider: 'google', code: 'c', state })).rejects.toBeDefined();

    expect(stub.keys()).toEqual([]);
  });

  it('sends the code verifier to the token endpoint and nothing else of the state', async () => {
    await configure('google');
    const state = stateOf(await service.start('google'));
    const stored = JSON.parse((await stub.get(oauthStateKey(hashToken(state)))) ?? '{}') as {
      codeVerifier: string;
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.complete({ provider: 'google', code: 'c', state })).rejects.toBeInstanceOf(
      OauthError,
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(body.get('code_verifier')).toBe(stored.codeVerifier);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(oauthRedirectUri(APP_URL, 'google'));
  });

  it('takes only a verified primary address from GitHub', async () => {
    await configure('github');
    const state = stateOf(await service.start('github'));
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
            ]),
          ),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Lina', login: 'lina' }))),
    );

    await expect(service.complete({ provider: 'github', code: 'c', state })).resolves.toEqual({
      email: 'lina@helpdock.com',
      name: 'Lina',
    });
  });

  it('refuses a GitHub account whose primary address is unverified', async () => {
    await configure('github');
    const state = stateOf(await service.start('github'));
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

    await expect(service.complete({ provider: 'github', code: 'c', state })).rejects.toBeInstanceOf(
      OauthError,
    );
  });

  it('refuses when the provider answers the token request with an error', async () => {
    await configure('github');
    const state = stateOf(await service.start('github'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));

    await expect(service.complete({ provider: 'github', code: 'c', state })).rejects.toBeInstanceOf(
      OauthError,
    );
  });
});

describe('oauthRedirectUri', () => {
  it('is built from APP_URL, so nothing in a request can change where a person lands', () => {
    expect(oauthRedirectUri(APP_URL, 'github')).toBe(
      'https://support.example.com/api/auth/oauth/github/callback',
    );
  });
});
