import { fakeEmbeddingsServer } from '@helpdock/ai';
import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
  type Settings,
} from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import type { LookupFunction } from '@helpdock/net';
import { describe, expect, it } from 'vitest';
import { createAiDestinationCheck } from './ai-destination.js';
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

/** The address rules have their own tests below; these cases are about the settings. */
const allowAnyAddress = async () => {};

const openai = {
  kind: 'openai',
  label: 'OpenAI',
  baseUrl: null,
  auth: { type: 'apiKey' as const, apiKey: 'sk-secret' },
};

describe('InstallAiService.upsert', () => {
  it('stores the credential and answers without it', async () => {
    const settings = settingsWith();
    const service = new InstallAiService(settings, fakeEmbeddingsServer(4).http, allowAnyAddress);

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
    const service = new InstallAiService(settings, fakeEmbeddingsServer(4).http, allowAnyAddress);
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
      allowAnyAddress,
    );

    await expect(service.upsert(context, 'openai', openai)).rejects.toMatchObject({
      reason: 'locked-by-environment',
    });
    await expect(service.remove(context, 'openai')).rejects.toMatchObject({
      reason: 'locked-by-environment',
    });
  });

  it('refuses a kind pi-ai does not have', async () => {
    const service = new InstallAiService(
      settingsWith(),
      fakeEmbeddingsServer(4).http,
      allowAnyAddress,
    );

    await expect(
      service.upsert(context, 'x', { ...openai, kind: 'not-a-provider' }),
    ).rejects.toMatchObject({ reason: 'unknown-kind' });
  });
});

describe('InstallAiService.upsert and the stored credential (#399)', () => {
  const compatible = {
    kind: 'openai-compatible',
    label: 'Local',
    baseUrl: 'https://llm.example.com/v1',
    auth: { type: 'apiKey' as const, apiKey: 'sk-stored' },
  };
  const seeded = async () => {
    const settings = settingsWith();
    const service = new InstallAiService(settings, fakeEmbeddingsServer(4).http, allowAnyAddress);
    await service.upsert(context, 'llm', compatible);

    return { settings, service };
  };
  const keyless = { type: 'apiKey' as const };

  it('keeps the stored key while the address differs only in case, port default or trailing slash', async () => {
    const { settings, service } = await seeded();

    await service.upsert(context, 'llm', {
      ...compatible,
      baseUrl: 'HTTPS://LLM.example.com:443/v1/',
      auth: keyless,
    });

    expect((await settings.get('ai.providers'))[0]?.auth).toEqual(compatible.auth);
  });

  it.each([
    ['host', 'https://evil.example.net/v1'],
    ['path', 'https://llm.example.com/other'],
    ['scheme', 'http://llm.example.com/v1'],
    ['port', 'https://llm.example.com:8443/v1'],
  ])('asks for the key again when the %s changes, and stores nothing', async (_, baseUrl) => {
    const { settings, service } = await seeded();

    await expect(
      service.upsert(context, 'llm', { ...compatible, baseUrl, auth: keyless }),
    ).rejects.toMatchObject({
      reason: 'credential-required',
      field: 'body.auth.apiKey',
      status: 400,
    });
    expect((await settings.get('ai.providers'))[0]).toMatchObject({
      baseUrl: compatible.baseUrl,
      auth: compatible.auth,
    });
  });

  it('asks for the key again when the kind changes, even with the address unchanged', async () => {
    const { service } = await seeded();

    await expect(
      service.upsert(context, 'llm', { ...compatible, kind: 'openai', auth: keyless }),
    ).rejects.toMatchObject({ reason: 'credential-required' });
  });

  it('asks for the key again when a provider without an address gains one', async () => {
    const settings = settingsWith();
    const service = new InstallAiService(settings, fakeEmbeddingsServer(4).http, allowAnyAddress);
    await service.upsert(context, 'openai', openai);

    await expect(
      service.upsert(context, 'openai', {
        ...openai,
        baseUrl: 'https://evil.example.net/v1',
        auth: keyless,
      }),
    ).rejects.toMatchObject({ reason: 'credential-required' });
  });

  it('stores a changed address together with a newly typed key', async () => {
    const { settings, service } = await seeded();

    await service.upsert(context, 'llm', {
      ...compatible,
      baseUrl: 'https://new.example.com/v1',
      auth: { type: 'apiKey', apiKey: 'sk-new' },
    });

    expect((await settings.get('ai.providers'))[0]).toMatchObject({
      baseUrl: 'https://new.example.com/v1',
      auth: { apiKey: 'sk-new' },
    });
  });
});

describe('InstallAiService.upsert and the address it is given (ASVS 12.6.1, 9.2.2)', () => {
  const resolvingTo =
    (address: string): LookupFunction =>
    async () => [{ address, family: 4 }];
  const local = (baseUrl: string) => ({
    kind: 'openai-compatible',
    label: 'Local',
    baseUrl,
    auth: { type: 'none' as const },
  });
  const serviceFor = (lookup: LookupFunction, allowCidrs: string[] = []) =>
    new InstallAiService(
      settingsWith(),
      fakeEmbeddingsServer(4).http,
      createAiDestinationCheck({ lookup, allowCidrs }),
    );

  it('refuses plain http to a public host, and says to use https', async () => {
    await expect(
      serviceFor(resolvingTo('93.184.216.34')).upsert(
        context,
        'llm',
        local('http://llm.example.com/v1'),
      ),
    ).rejects.toMatchObject({ reason: 'https-required' });
  });

  it('refuses a private or metadata address unless the operator allowed the range', async () => {
    await expect(
      serviceFor(resolvingTo('169.254.169.254')).upsert(
        context,
        'llm',
        local('https://llm.example.com/v1'),
      ),
    ).rejects.toMatchObject({ reason: 'destination-blocked' });
  });

  it('takes a local server whose address the operator allowed, over http', async () => {
    const settings = settingsWith();
    const service = new InstallAiService(
      settings,
      fakeEmbeddingsServer(4).http,
      createAiDestinationCheck({
        lookup: resolvingTo('172.18.0.5'),
        allowCidrs: ['172.16.0.0/12'],
      }),
    );

    await service.upsert(context, 'ollama', local('http://ollama:11434/v1'));

    expect((await settings.get('ai.providers'))[0]).toMatchObject({
      baseUrl: 'http://ollama:11434/v1',
    });
  });

  it('does not look at a provider that has no base URL, or an edit that leaves it alone', async () => {
    const lookups: string[] = [];
    const service = serviceFor(async (hostname) => {
      lookups.push(hostname);
      return [{ address: '93.184.216.34', family: 4 }];
    });
    await service.upsert(context, 'openai', openai);
    await service.upsert(context, 'llm', local('https://llm.example.com/v1'));
    lookups.length = 0;

    await service.upsert(context, 'llm', {
      ...local('https://llm.example.com/v1'),
      label: 'Renamed',
    });

    expect(lookups).toEqual([]);
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
