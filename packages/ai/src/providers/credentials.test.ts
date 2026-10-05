import type { AiProviderConfig } from '@helpdock/config';
import { registerOAuthProvider, resetOAuthProviders } from '@mariozechner/pi-ai/oauth';
import { afterEach, describe, expect, it } from 'vitest';
import { modelForCredential, ProviderCredentialError, resolveCredential } from './credentials.js';
import { resolveModel } from './models.js';

const base: AiProviderConfig = {
  id: 'p',
  kind: 'openai',
  label: 'P',
  baseUrl: null,
  auth: { type: 'apiKey', apiKey: 'sk-test' },
};

/**
 * A stand-in for a subscription provider, registered under a built-in id so
 * no test reaches a real OAuth endpoint: it refreshes by appending to the
 * access token and moves the model to an account-specific endpoint.
 */
const registerFakeOAuth = (id: string): void => {
  registerOAuthProvider({
    id,
    name: 'Fake subscription',
    login: () => Promise.reject(new Error('not used')),
    refreshToken: (credentials) =>
      Promise.resolve({
        ...credentials,
        access: `${credentials.access}-refreshed`,
        expires: Date.now() + 60_000,
      }),
    getApiKey: (credentials) => `key-for-${credentials.access}`,
    modifyModels: (models) =>
      models.map((model) => ({ ...model, baseUrl: 'https://account.example.com' })),
  });
};

afterEach(() => resetOAuthProviders());

describe('resolving a credential', () => {
  it('uses an API key as it is', async () => {
    await expect(resolveCredential(base)).resolves.toEqual({ apiKey: 'sk-test' });
  });

  it('passes a placeholder key for a server that asks for none, so pi-ai never reads the environment', async () => {
    await expect(resolveCredential({ ...base, auth: { type: 'none' } })).resolves.toEqual({
      apiKey: 'unused',
    });
  });

  it('turns live OAuth credentials into a key without refreshing them', async () => {
    registerFakeOAuth('anthropic');
    const provider: AiProviderConfig = {
      ...base,
      kind: 'anthropic',
      auth: {
        type: 'oauth',
        credentials: { access: 'tok', refresh: 'r', expires: Date.now() + 600_000 },
      },
    };

    await expect(resolveCredential(provider)).resolves.toEqual({ apiKey: 'key-for-tok' });
  });

  it('refreshes expired OAuth credentials and hands the new set back to be stored', async () => {
    registerFakeOAuth('anthropic');
    const provider: AiProviderConfig = {
      ...base,
      kind: 'anthropic',
      auth: { type: 'oauth', credentials: { access: 'tok', refresh: 'r', expires: 0 } },
    };

    const resolved = await resolveCredential(provider);

    expect(resolved.apiKey).toBe('key-for-tok-refreshed');
    expect(resolved.refreshed).toMatchObject({ access: 'tok-refreshed', refresh: 'r' });
  });

  it('reports OAuth credentials for a kind pi-ai has no OAuth flow for', async () => {
    const provider: AiProviderConfig = {
      ...base,
      kind: 'groq',
      auth: { type: 'oauth', credentials: { access: 'tok', refresh: 'r', expires: 0 } },
    };

    await expect(resolveCredential(provider)).rejects.toBeInstanceOf(ProviderCredentialError);
  });

  it("moves the model to the subscription's own endpoint when the OAuth provider says so", () => {
    registerFakeOAuth('openai');
    const provider: AiProviderConfig = {
      ...base,
      auth: { type: 'oauth', credentials: { access: 'tok', refresh: 'r', expires: 0 } },
    };

    expect(modelForCredential(provider, resolveModel(base, 'gpt-4o-mini')).baseUrl).toBe(
      'https://account.example.com',
    );
    expect(modelForCredential(base, resolveModel(base, 'gpt-4o-mini')).baseUrl).not.toBe(
      'https://account.example.com',
    );
  });
});
