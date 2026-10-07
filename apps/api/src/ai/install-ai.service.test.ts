import { fakeEmbeddingsServer } from '@helpdock/ai';
import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
  type Settings,
} from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { InstallAiService, toProviderView } from './install-ai.service.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 3).toString('base64') });

const settingsWith = (env: Record<string, string> = {}): Settings =>
  createSettings({
    env,
    store: new InMemorySettingsStore(),
    keyring,
    invalidation: new LocalInvalidation(),
  });

/** A transaction that accepts the audit insert and nothing else. */
const audits: Record<string, unknown>[] = [];
const tx = {
  insert: () => ({ values: async (row: Record<string, unknown>) => void audits.push(row) }),
} as unknown as DbTransaction;
const context = { tx, actorId: '0192f4d2-0000-7000-8000-0000000000ad' };

const openai = {
  kind: 'openai',
  label: 'OpenAI',
  baseUrl: null,
  auth: { type: 'apiKey' as const, apiKey: 'sk-secret' },
};

describe('InstallAiService.upsert', () => {
  it('stores the credential and answers without it', async () => {
    const settings = settingsWith();
    const service = new InstallAiService(settings, fakeEmbeddingsServer(4).http);

    const view = await service.upsert(context, 'openai', openai);

    expect(view).toEqual({
      id: 'openai',
      kind: 'openai',
      label: 'OpenAI',
      baseUrl: null,
      authType: 'apiKey',
      oauthExpiresAt: null,
    });
    expect((await settings.get('ai.providers'))[0]?.auth).toEqual(openai.auth);
    expect(JSON.stringify(audits.at(-1))).not.toContain('sk-secret');
  });

  it('keeps the stored key when an edit sends none, and refuses a new provider without one', async () => {
    const settings = settingsWith();
    const service = new InstallAiService(settings, fakeEmbeddingsServer(4).http);
    await service.upsert(context, 'openai', openai);

    await service.upsert(context, 'openai', {
      ...openai,
      label: 'Renamed',
      auth: { type: 'apiKey' },
    });

    expect((await settings.get('ai.providers'))[0]).toMatchObject({
      label: 'Renamed',
      auth: { apiKey: 'sk-secret' },
    });
    await expect(
      service.upsert(context, 'other', { ...openai, auth: { type: 'apiKey' } }),
    ).rejects.toMatchObject({ reason: 'credential-required' });
  });

  it('refuses every change while HD_AI_PROVIDERS pins the list', async () => {
    const service = new InstallAiService(
      settingsWith({ HD_AI_PROVIDERS: '[]' }),
      fakeEmbeddingsServer(4).http,
    );

    await expect(service.upsert(context, 'openai', openai)).rejects.toMatchObject({
      reason: 'locked-by-environment',
    });
    await expect(service.remove(context, 'openai')).rejects.toMatchObject({
      reason: 'locked-by-environment',
    });
  });

  it('refuses a kind pi-ai does not have', async () => {
    const service = new InstallAiService(settingsWith(), fakeEmbeddingsServer(4).http);

    await expect(
      service.upsert(context, 'x', { ...openai, kind: 'not-a-provider' }),
    ).rejects.toMatchObject({ reason: 'unknown-kind' });
  });
});

describe('toProviderView', () => {
  it('says when OAuth tokens expire and nothing about them', () => {
    const view = toProviderView({
      id: 'max',
      kind: 'anthropic',
      label: 'Max',
      baseUrl: null,
      auth: { type: 'oauth', credentials: { access: 'at', refresh: 'rt', expires: 0 } },
    });

    expect(view).toEqual({
      id: 'max',
      kind: 'anthropic',
      label: 'Max',
      baseUrl: null,
      authType: 'oauth',
      oauthExpiresAt: '1970-01-01T00:00:00.000Z',
    });
  });
});
