import type { SettingKey, Settings } from '@helpdock/config';
import {
  auditLog,
  brands,
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  knowledgeChunks,
  readEmbeddingSpace,
} from '@helpdock/db';
import type {
  EmbeddingSettingsUpdate,
  EmbeddingSettingsView,
  EmbeddingSpaceView,
} from '@helpdock/schemas';
import { ne, sql } from 'drizzle-orm';
import { widenInstallScope } from '../tenant/install-scope.js';
import { AiFailure } from './ai-failure.js';

/**
 * The install's one embedding model (M7-02, ADR 0005). Saving writes the
 * `embedding.*` settings and nothing else; the `knowledge.configure` tick in
 * the worker notices within a minute, resizes the vector column, and starts
 * the re-embed. That is also what happens when an operator changes
 * `HD_EMBEDDING_MODEL` and restarts, so admin and environment take one path.
 *
 * Changing the model or the dimension re-embeds every chunk of every brand,
 * at the provider's price, with retrieval on full text alone until it is
 * done. The request has to say `confirmReembed: true` for that; the screen
 * asks first.
 */

const EMBEDDING_KEYS = [
  'embedding.provider',
  'embedding.baseUrl',
  'embedding.apiKey',
  'embedding.model',
  'embedding.dims',
  'embedding.pricePerMillionTokens',
] as const satisfies readonly SettingKey[];

export class EmbeddingSettingsService {
  readonly #settings: Settings;

  constructor(settings: Settings) {
    this.#settings = settings;
  }

  async view(tx: DbTransaction): Promise<EmbeddingSettingsView> {
    const [provider, baseUrl, apiKey, model, dims, pricePerMillionTokens] = await Promise.all([
      this.#settings.get('embedding.provider'),
      this.#settings.get('embedding.baseUrl'),
      this.#settings.get('embedding.apiKey'),
      this.#settings.get('embedding.model'),
      this.#settings.get('embedding.dims'),
      this.#settings.get('embedding.pricePerMillionTokens'),
    ]);
    return {
      provider,
      baseUrl,
      model,
      dims,
      pricePerMillionTokens,
      hasApiKey: apiKey !== '',
      lockedKeys: EMBEDDING_KEYS.filter((key) => this.#settings.isLockedByEnv(key)),
      space: await this.#space(tx),
    };
  }

  async update(
    tx: DbTransaction,
    actorId: string,
    body: EmbeddingSettingsUpdate,
  ): Promise<EmbeddingSettingsView> {
    const [storedModel, storedDims] = await Promise.all([
      this.#settings.get('embedding.model'),
      this.#settings.get('embedding.dims'),
    ]);
    const changesSpace = storedModel !== body.model || storedDims !== body.dims;
    if (storedModel !== '' && changesSpace && body.confirmReembed !== true) {
      throw new AiFailure('reembed-not-confirmed');
    }

    const writes: [SettingKey, unknown][] = [
      ['embedding.provider', body.provider],
      ['embedding.baseUrl', body.baseUrl],
      ['embedding.model', body.model],
      ['embedding.dims', body.dims],
      ['embedding.pricePerMillionTokens', body.pricePerMillionTokens],
      ...(body.apiKey === undefined
        ? []
        : [['embedding.apiKey', body.apiKey] as [SettingKey, unknown]]),
    ];
    const changed: [SettingKey, unknown][] = [];
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
      await this.#settings.set(key, value as never, { updatedBy: actorId });
    }

    await tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'staff',
      actorId,
      action: 'ai.embedding.updated',
      targetType: 'embedding_space',
      targetId: 'install',
      // Keys only: one of them is the API key.
      meta: { changed: changed.map(([key]) => key), reembed: storedModel !== '' && changesSpace },
    });
    return this.view(tx);
  }

  /**
   * The space row, and how far the re-embed has got across every brand: a
   * chunk is done once its `embedding_model` is the target's.
   */
  async #space(tx: DbTransaction): Promise<EmbeddingSpaceView> {
    const row = await readEmbeddingSpace(tx);
    const live = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(ne(brands.status, 'deleted'));
    await widenInstallScope(
      tx,
      live.map((brand) => brand.id),
    );
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        embedded: sql<number>`(count(*) filter (where ${knowledgeChunks.embeddingModel} = ${row.targetModel ?? ''}))::int`,
      })
      .from(knowledgeChunks);

    return {
      status: row.status,
      activeModel: row.activeModel,
      activeDims: row.activeDims,
      targetModel: row.targetModel,
      targetDims: row.targetDims,
      lastError: row.lastError,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      progress: { embedded: counts?.embedded ?? 0, total: counts?.total ?? 0 },
    };
  }
}
