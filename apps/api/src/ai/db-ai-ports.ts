import {
  type Ai,
  type AiCallRecord,
  AiNotConfiguredError,
  type AiPorts,
  type AiTarget,
  type BrandGuardrails,
  createAi,
  type EmbeddingConfig,
  EmbeddingNotConfiguredError,
  type HttpTransport,
  type ModelTransport,
} from '@helpdock/ai';
import { type OAuthCredentialsValue, SettingLockedError, type Settings } from '@helpdock/config';
import type { Db, DbTransaction } from '@helpdock/db';
import { withSystemJob } from '../tenant/system-job.js';
import { AiRepository } from './ai.repository.js';
import { BudgetMeter } from './budget-meter.js';

/**
 * The ports of `@helpdock/ai` against this install: providers and the default
 * model from the `settings` table (or the environment), a brand's override,
 * guardrails and budget from `ai_settings`, and every call into `ai_calls`.
 *
 * Each read and write opens its own short system transaction for the one
 * brand (DOMAIN-RULES §1.4). A model call takes seconds and must not hold a
 * request's transaction open, so `complete()` is never run inside one; the log
 * row is written after the answer, with the budget alerts it may trigger.
 */

/** The principal every AI transaction runs as; it names the writer on any audit row. */
export const AI_PRINCIPAL_ID = 'ai-runtime';

export type AiSettingsReader = Pick<Settings, 'get' | 'set'>;

export class DbAiPorts implements AiPorts {
  readonly #db: Db;
  readonly #settings: AiSettingsReader;
  readonly #repository: AiRepository;
  readonly #budget: BudgetMeter;

  constructor(db: Db, settings: AiSettingsReader, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#settings = settings;
    this.#repository = new AiRepository();
    this.#budget = new BudgetMeter(this.#repository, now);
  }

  async target(brandId: string): Promise<AiTarget> {
    const row = await this.#inBrand(brandId, (tx) => this.#repository.settings(tx, brandId));
    const providerId = row?.providerId ?? (await this.#settings.get('ai.defaultProvider'));
    const modelId = row?.modelId ?? (await this.#settings.get('ai.defaultModel'));
    const provider = (await this.#settings.get('ai.providers')).find(
      (candidate) => candidate.id === providerId,
    );
    if (provider === undefined || modelId === '') {
      throw new AiNotConfiguredError(brandId);
    }
    return { provider, modelId, systemPrompt: row?.systemPrompt ?? '' };
  }

  async guardrails(brandId: string): Promise<BrandGuardrails> {
    const row = await this.#inBrand(brandId, (tx) => this.#repository.settings(tx, brandId));
    return { piiRedaction: row?.piiRedaction ?? true };
  }

  assertWithinBudget(brandId: string): Promise<void> {
    return this.#inBrand(brandId, (tx) => this.#budget.assertWithinBudget(tx, brandId));
  }

  record(call: AiCallRecord): Promise<string> {
    return this.#inBrand(call.brandId, async (tx) => {
      const id = await this.#repository.insertCall(tx, call);
      // After every call, not only priced ones: spend may have been logged by
      // another replica since, and a refusal is when a brand learns it hit 100 %.
      await this.#budget.announceThresholds(tx, call.brandId);
      return id;
    });
  }

  /**
   * pi-ai refreshed a subscription's tokens; the old refresh token may already
   * be spent, so the new set replaces it. A list pinned by `HD_AI_PROVIDERS`
   * cannot be written, and the call still succeeds: the next one refreshes
   * again from the environment's tokens for as long as they last.
   */
  async saveCredentials(providerId: string, credentials: OAuthCredentialsValue): Promise<void> {
    const providers = await this.#settings.get('ai.providers');
    const next = providers.map((provider) =>
      provider.id === providerId && provider.auth.type === 'oauth'
        ? { ...provider, auth: { type: 'oauth' as const, credentials } }
        : provider,
    );
    try {
      await this.#settings.set('ai.providers', next, { updatedBy: AI_PRINCIPAL_ID });
    } catch (error) {
      if (!(error instanceof SettingLockedError)) {
        throw error;
      }
    }
  }

  async embedding(): Promise<EmbeddingConfig> {
    const [provider, baseUrl, apiKey, model, dims, pricePerMillionTokens] = await Promise.all([
      this.#settings.get('embedding.provider'),
      this.#settings.get('embedding.baseUrl'),
      this.#settings.get('embedding.apiKey'),
      this.#settings.get('embedding.model'),
      this.#settings.get('embedding.dims'),
      this.#settings.get('embedding.pricePerMillionTokens'),
    ]);
    if (baseUrl === '' || model === '' || dims === 0) {
      throw new EmbeddingNotConfiguredError();
    }
    return {
      provider: provider || 'openai-compatible',
      baseUrl,
      apiKey,
      model,
      dims,
      pricePerMillionTokens,
    };
  }

  #inBrand<T>(brandId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withSystemJob(this.#db, brandId, AI_PRINCIPAL_ID, fn);
  }
}

export interface AiRuntimeOptions {
  readonly db: Db;
  readonly settings: AiSettingsReader;
  readonly http: HttpTransport;
  /** pi-ai unless a suite passes the faux provider's transport. */
  readonly transport?: ModelTransport;
}

/** The facade, wired to this install. Every AI feature gets it from here. */
export const createAiRuntime = ({ db, settings, http, transport }: AiRuntimeOptions): Ai =>
  createAi({
    ports: new DbAiPorts(db, settings),
    http,
    ...(transport === undefined ? {} : { transport }),
  });
