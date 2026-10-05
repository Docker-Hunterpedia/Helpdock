import type { SettingKey, Settings } from '@helpdock/config';
import { auditLog, type DbTransaction, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import type { TranscriptionSettingsUpdate, TranscriptionSettingsView } from '@helpdock/schemas';
import { AiFailure } from './ai-failure.js';

/**
 * Voice transcription's endpoint (M7-09's job reads it; M7-10's
 * `Admin/AI-Providers` card writes it). Install-wide like the providers, and
 * the same rules as the embedding settings: the key is write-only, a key the
 * environment pins cannot be changed here, and the audit row names the keys
 * that changed, never a value.
 */

const TRANSCRIPTION_KEYS = [
  'transcription.endpoint',
  'transcription.model',
  'transcription.apiKey',
] as const satisfies readonly SettingKey[];

type TranscriptionKey = (typeof TRANSCRIPTION_KEYS)[number];

export class TranscriptionSettingsService {
  readonly #settings: Settings;

  constructor(settings: Settings) {
    this.#settings = settings;
  }

  async view(): Promise<TranscriptionSettingsView> {
    const [endpoint, model, apiKey] = await Promise.all([
      this.#settings.get('transcription.endpoint'),
      this.#settings.get('transcription.model'),
      this.#settings.get('transcription.apiKey'),
    ]);
    return {
      endpoint,
      model,
      hasApiKey: apiKey !== '',
      lockedKeys: TRANSCRIPTION_KEYS.filter((key) => this.#settings.isLockedByEnv(key)),
    };
  }

  async update(
    tx: DbTransaction,
    actorId: string,
    body: TranscriptionSettingsUpdate,
  ): Promise<TranscriptionSettingsView> {
    const writes: [TranscriptionKey, string][] = [
      ['transcription.endpoint', body.endpoint],
      ['transcription.model', body.model],
      ...(body.apiKey === undefined
        ? []
        : [['transcription.apiKey', body.apiKey] as [TranscriptionKey, string]]),
    ];
    const changed: [TranscriptionKey, string][] = [];
    for (const [key, value] of writes) {
      if ((await this.#settings.get(key)) !== value) {
        changed.push([key, value]);
      }
    }
    if (changed.some(([key]) => this.#settings.isLockedByEnv(key))) {
      throw new AiFailure('locked-by-environment');
    }
    for (const [key, value] of changed) {
      // The registry's schema for each key validates the value again in `set`.
      await this.#settings.set(key, value, { updatedBy: actorId });
    }

    await tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'staff',
      actorId,
      action: 'ai.transcription.updated',
      targetType: 'setting',
      targetId: 'transcription',
      // Keys only: one of them is the API key.
      meta: { changed: changed.map(([key]) => key) },
    });
    return this.view();
  }
}
