import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
} from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import type { LookupFunction } from '@helpdock/net';
import { describe, expect, it, vi } from 'vitest';
import { createAiDestinationCheck } from './ai-destination.js';
import { EmbeddingSettingsService } from './embedding-settings.service.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 6).toString('base64') });
const settings = () =>
  createSettings({
    env: {},
    store: new InMemorySettingsStore(),
    keyring,
    invalidation: new LocalInvalidation(),
  });

/** Refusals come before the audit insert and the space read, so no transaction is touched. */
const tx = {} as unknown as DbTransaction;
const ACTOR = '0192f4d2-0000-7000-8000-0000000000ad';
const body = {
  provider: 'openai',
  baseUrl: 'https://embeddings.example.com/v1',
  model: 'text-embedding-3-small',
  dims: 1536,
  pricePerMillionTokens: 0.02,
};
const resolvingTo =
  (address: string): LookupFunction =>
  async () => [{ address, family: 4 }];

describe('EmbeddingSettingsService and the address it is given (ASVS 12.6.1, 9.2.2)', () => {
  it('refuses plain http to a public host and a blocked address, saving nothing', async () => {
    const store = settings();
    const publicHost = new EmbeddingSettingsService(
      store,
      createAiDestinationCheck({ lookup: resolvingTo('93.184.216.34') }),
    );
    const metadata = new EmbeddingSettingsService(
      store,
      createAiDestinationCheck({ lookup: resolvingTo('169.254.169.254') }),
    );

    await expect(
      publicHost.update(tx, ACTOR, { ...body, baseUrl: 'http://embeddings.example.com/v1' }),
    ).rejects.toMatchObject({ reason: 'https-required' });
    await expect(metadata.update(tx, ACTOR, body)).rejects.toMatchObject({
      reason: 'destination-blocked',
    });
    expect(await store.get('embedding.model')).toBe('');
  });
});

describe('EmbeddingSettingsService and the stored key (#399)', () => {
  const allowAny = async () => {};
  const audits: unknown[] = [];
  const auditingTx = {
    insert: () => ({ values: async (row: unknown) => void audits.push(row) }),
  } as unknown as DbTransaction;

  const seeded = async () => {
    const store = settings();
    const service = new EmbeddingSettingsService(store, allowAny);
    // The view reads the embedding space from the database; these cases are about the key.
    vi.spyOn(service, 'view').mockResolvedValue({} as never);
    await service.update(auditingTx, ACTOR, { ...body, apiKey: 'sk-stored' });

    return { store, service };
  };

  it('keeps the stored key while the address is the same by another spelling', async () => {
    const { store, service } = await seeded();

    await service.update(auditingTx, ACTOR, {
      ...body,
      baseUrl: 'HTTPS://Embeddings.example.com:443/v1/',
    });

    expect(await store.get('embedding.apiKey')).toBe('sk-stored');
  });

  it('asks for the key again when the address changes, and saves nothing', async () => {
    const { store, service } = await seeded();

    await expect(
      service.update(auditingTx, ACTOR, { ...body, baseUrl: 'https://evil.example.net/v1' }),
    ).rejects.toMatchObject({
      reason: 'embedding-key-required',
      field: 'body.apiKey',
      status: 400,
    });
    expect(await store.get('embedding.baseUrl')).toBe(body.baseUrl);
    expect(await store.get('embedding.apiKey')).toBe('sk-stored');
  });

  it('takes a changed address with a newly typed key, or with the key cleared', async () => {
    const { store, service } = await seeded();

    await service.update(auditingTx, ACTOR, {
      ...body,
      baseUrl: 'https://new.example.com/v1',
      apiKey: 'sk-new',
    });
    expect(await store.get('embedding.apiKey')).toBe('sk-new');

    await service.update(auditingTx, ACTOR, {
      ...body,
      baseUrl: 'https://other.example.com/v1',
      apiKey: '',
    });
    expect(await store.get('embedding.apiKey')).toBe('');
  });

  it('has no key to withhold when none is stored', async () => {
    const store = settings();
    const service = new EmbeddingSettingsService(store, allowAny);
    vi.spyOn(service, 'view').mockResolvedValue({} as never);

    await service.update(auditingTx, ACTOR, body);
    await service.update(auditingTx, ACTOR, { ...body, baseUrl: 'https://new.example.com/v1' });

    expect(await store.get('embedding.baseUrl')).toBe('https://new.example.com/v1');
  });
});
