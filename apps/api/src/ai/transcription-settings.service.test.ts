import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
} from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { TranscriptionSettingsService } from './transcription-settings.service.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 8).toString('base64') });
const ACTOR = '0192f4d2-0000-7000-8000-0000000000ad';
const tx = { insert: () => ({ values: async () => undefined }) } as unknown as DbTransaction;
const body = { endpoint: 'https://stt.example.com/v1/audio/transcriptions', model: 'whisper-1' };
const checked: string[] = [];

const seeded = async () => {
  const store = createSettings({
    env: {},
    store: new InMemorySettingsStore(),
    keyring,
    invalidation: new LocalInvalidation(),
  });
  const service = new TranscriptionSettingsService(store, async (url) => void checked.push(url));
  await service.update(tx, ACTOR, { ...body, apiKey: 'sk-stored' });

  return { store, service };
};

describe('TranscriptionSettingsService and the stored key (#399)', () => {
  it('keeps the stored key while the endpoint is the same by another spelling', async () => {
    const { store, service } = await seeded();

    await service.update(tx, ACTOR, {
      ...body,
      endpoint: 'HTTPS://STT.example.com:443/v1/audio/transcriptions/',
    });

    expect(await store.get('transcription.apiKey')).toBe('sk-stored');
  });

  it('asks for the key again when the endpoint changes, and saves and checks nothing', async () => {
    const { store, service } = await seeded();
    const checksBefore = checked.length;

    await expect(
      service.update(tx, ACTOR, {
        ...body,
        endpoint: 'https://evil.example.net/v1/audio/transcriptions',
      }),
    ).rejects.toMatchObject({
      reason: 'transcription-key-required',
      field: 'body.apiKey',
      status: 400,
    });
    expect(await store.get('transcription.endpoint')).toBe(body.endpoint);
    expect(await store.get('transcription.apiKey')).toBe('sk-stored');
    expect(checked).toHaveLength(checksBefore);
  });

  it('takes a changed endpoint with a typed key, and turning it off without one', async () => {
    const { store, service } = await seeded();

    await service.update(tx, ACTOR, {
      ...body,
      endpoint: 'https://new.example.com/v1/audio/transcriptions',
      apiKey: 'sk-new',
    });
    expect(await store.get('transcription.apiKey')).toBe('sk-new');

    await service.update(tx, ACTOR, { ...body, endpoint: '' });
    expect(await store.get('transcription.endpoint')).toBe('');
    expect(await store.get('transcription.apiKey')).toBe('sk-new');

    await expect(
      service.update(tx, ACTOR, {
        ...body,
        endpoint: 'https://other.example.com/v1/audio/transcriptions',
      }),
    ).rejects.toMatchObject({ reason: 'transcription-key-required' });
  });
});
