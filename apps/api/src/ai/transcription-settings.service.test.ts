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
import { AiFailure } from './ai-failure.js';
import { TranscriptionSettingsService } from './transcription-settings.service.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') });

const settingsWith = (env: Record<string, string> = {}): Settings =>
  createSettings({
    env,
    store: new InMemorySettingsStore(),
    keyring,
    invalidation: new LocalInvalidation(),
  });

const audits: Record<string, unknown>[] = [];
const tx = {
  insert: () => ({ values: async (row: Record<string, unknown>) => void audits.push(row) }),
} as unknown as DbTransaction;
const ACTOR = '0192f4d2-0000-7000-8000-0000000000ad';
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
/** The address rules have their own tests below; these cases are about the settings. */
const allowAnyAddress = async () => {};

describe('TranscriptionSettingsService', () => {
  it('saves the endpoint and key, answers without the key, and audits only key names', async () => {
    const service = new TranscriptionSettingsService(settingsWith(), allowAnyAddress);

    const view = await service.update(tx, ACTOR, {
      endpoint: ENDPOINT,
      model: 'whisper-1',
      apiKey: 'sk-voice',
    });

    expect(view).toEqual({
      endpoint: ENDPOINT,
      model: 'whisper-1',
      hasApiKey: true,
      lockedKeys: [],
    });
    expect(audits.at(-1)?.meta).toEqual({
      changed: ['transcription.endpoint', 'transcription.apiKey'],
    });
  });

  it('reports pinned keys and refuses to change one', async () => {
    const service = new TranscriptionSettingsService(
      settingsWith({ HD_TRANSCRIPTION_ENDPOINT: ENDPOINT }),
      allowAnyAddress,
    );

    expect((await service.view()).lockedKeys).toEqual(['transcription.endpoint']);
    await expect(
      service.update(tx, ACTOR, { endpoint: '', model: 'whisper-1' }),
    ).rejects.toBeInstanceOf(AiFailure);
    await expect(
      service.update(tx, ACTOR, { endpoint: ENDPOINT, model: 'whisper-large' }),
    ).resolves.toMatchObject({ model: 'whisper-large' });
  });
});

describe('TranscriptionSettingsService and the endpoint it is given (ASVS 12.6.1, 9.2.2)', () => {
  const resolvingTo =
    (address: string): LookupFunction =>
    async () => [{ address, family: 4 }];
  const serviceFor = (lookup: LookupFunction, allowCidrs: string[] = []) =>
    new TranscriptionSettingsService(
      settingsWith(),
      createAiDestinationCheck({ lookup, allowCidrs }),
    );

  it('refuses plain http to a public host and a blocked address, saving nothing', async () => {
    const settings = settingsWith();
    const publicHost = new TranscriptionSettingsService(
      settings,
      createAiDestinationCheck({ lookup: resolvingTo('93.184.216.34') }),
    );

    await expect(
      publicHost.update(tx, ACTOR, {
        endpoint: 'http://whisper.example.com/v1/audio/transcriptions',
        model: 'whisper-1',
      }),
    ).rejects.toMatchObject({ reason: 'https-required' });
    await expect(
      serviceFor(resolvingTo('10.0.0.8')).update(tx, ACTOR, {
        endpoint: 'https://whisper.example.com/v1/audio/transcriptions',
        model: 'whisper-1',
      }),
    ).rejects.toMatchObject({ reason: 'destination-blocked' });
    expect(await settings.get('transcription.endpoint')).toBe('');
  });

  it('takes a local server in an allowed range over http, and an empty endpoint without a lookup', async () => {
    const local = serviceFor(resolvingTo('172.18.0.9'), ['172.16.0.0/12']);

    await expect(
      local.update(tx, ACTOR, {
        endpoint: 'http://whisper:9000/v1/audio/transcriptions',
        model: 'whisper-1',
      }),
    ).resolves.toMatchObject({ endpoint: 'http://whisper:9000/v1/audio/transcriptions' });
    await expect(
      serviceFor(async () => {
        throw new Error('an empty endpoint needs no lookup');
      }).update(tx, ACTOR, { endpoint: '', model: 'whisper-1' }),
    ).resolves.toMatchObject({ endpoint: '' });
  });
});
