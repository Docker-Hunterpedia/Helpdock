import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
  type Settings,
} from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
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

describe('TranscriptionSettingsService', () => {
  it('saves the endpoint and key, answers without the key, and audits only key names', async () => {
    const service = new TranscriptionSettingsService(settingsWith());

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
