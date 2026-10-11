import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
} from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import type { LookupFunction } from '@helpdock/net';
import { describe, expect, it } from 'vitest';
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
