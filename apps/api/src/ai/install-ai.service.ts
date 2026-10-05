import {
  type HttpTransport,
  isBuiltInKind,
  listModels,
  ModelNotFoundError,
  providerKinds,
  resolveModel,
} from '@helpdock/ai';
import {
  type AiProviderConfig,
  aiProviderConfigSchema,
  OPENAI_COMPATIBLE_KIND,
  type SettingKey,
  type Settings,
} from '@helpdock/config';
import { auditLog, brands, type DbTransaction, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import type {
  AiDefaultModelUpdate,
  AiModelList,
  AiProvidersOverview,
  AiProviderUpsert,
  AiProviderView,
} from '@helpdock/schemas';
import { ne } from 'drizzle-orm';
import { widenInstallScope } from '../tenant/install-scope.js';
import { AiRepository } from './ai.repository.js';
import { AiFailure } from './ai-failure.js';

/**
 * Install-wide AI configuration (M7-01): the providers with their credentials,
 * and the model every brand uses unless it overrides it. Install admin only;
 * every route runs in install scope and is audited on entry.
 *
 * Providers live in the `ai.providers` setting, encrypted whole under
 * `APP_MASTER_KEY` (ADR 0018). A credential is accepted on the way in and
 * never comes back out: a response says which kind of credential a provider
 * holds, and when OAuth tokens expire, and nothing more. An audit row records
 * every change without any credential in it.
 */

export interface InstallAiContext {
  readonly tx: DbTransaction;
  readonly actorId: string;
}

const PROVIDER_KEYS: readonly SettingKey[] = ['ai.providers'];
const DEFAULT_KEYS: readonly SettingKey[] = ['ai.defaultProvider', 'ai.defaultModel'];

export const toProviderView = (provider: AiProviderConfig): AiProviderView => ({
  id: provider.id,
  kind: provider.kind,
  label: provider.label,
  baseUrl: provider.baseUrl,
  authType: provider.auth.type,
  oauthExpiresAt:
    provider.auth.type === 'oauth'
      ? new Date(provider.auth.credentials.expires).toISOString()
      : null,
});

export class InstallAiService {
  readonly #settings: Settings;
  readonly #http: HttpTransport;
  readonly #repository = new AiRepository();

  constructor(settings: Settings, http: HttpTransport) {
    this.#settings = settings;
    this.#http = http;
  }

  async overview(): Promise<AiProvidersOverview> {
    const [providers, providerId, modelId] = await Promise.all([
      this.#settings.get('ai.providers'),
      this.#settings.get('ai.defaultProvider'),
      this.#settings.get('ai.defaultModel'),
    ]);
    return {
      providers: providers.map(toProviderView),
      kinds: [...providerKinds()],
      defaults: {
        providerId: providerId === '' ? null : providerId,
        modelId: modelId === '' ? null : modelId,
      },
      locked: {
        providers: this.#locked(PROVIDER_KEYS),
        defaults: this.#locked(DEFAULT_KEYS),
      },
    };
  }

  async upsert(
    { tx, actorId }: InstallAiContext,
    providerId: string,
    body: AiProviderUpsert,
  ): Promise<AiProviderView> {
    this.#assertUnlocked(PROVIDER_KEYS);
    const kind = providerKinds().find((candidate) => candidate.id === body.kind);
    if (kind === undefined) {
      throw new AiFailure('unknown-kind');
    }
    if (body.auth.type === 'oauth' && !kind.oauth) {
      throw new AiFailure('oauth-unsupported');
    }

    const providers = await this.#settings.get('ai.providers');
    const existing = providers.find((provider) => provider.id === providerId);
    const next = aiProviderConfigSchema.parse({
      id: providerId,
      kind: body.kind,
      label: body.label,
      baseUrl: body.baseUrl,
      auth: credentialFor(body.auth, existing),
    });

    await this.#settings.set(
      'ai.providers',
      existing === undefined
        ? [...providers, next]
        : providers.map((provider) => (provider.id === providerId ? next : provider)),
      { updatedBy: actorId },
    );
    await this.#audit(
      tx,
      actorId,
      existing === undefined ? 'ai.provider.created' : 'ai.provider.updated',
      providerId,
      {
        kind: next.kind,
        authType: next.auth.type,
        // Whether the credential was replaced, never what it is.
        credentialReplaced: hasNewCredential(body.auth),
      },
    );
    return toProviderView(next);
  }

  async remove({ tx, actorId }: InstallAiContext, providerId: string): Promise<void> {
    this.#assertUnlocked(PROVIDER_KEYS);
    const providers = await this.#settings.get('ai.providers');
    if (!providers.some((provider) => provider.id === providerId)) {
      throw new AiFailure('unknown-provider');
    }
    if ((await this.#settings.get('ai.defaultProvider')) === providerId) {
      throw new AiFailure('provider-in-use');
    }
    await this.#reachEveryBrand(tx);
    if ((await this.#repository.brandsUsingProvider(tx, providerId)) > 0) {
      throw new AiFailure('provider-in-use');
    }

    await this.#settings.set(
      'ai.providers',
      providers.filter((provider) => provider.id !== providerId),
      { updatedBy: actorId },
    );
    await this.#audit(tx, actorId, 'ai.provider.deleted', providerId, {});
  }

  async models(providerId: string): Promise<AiModelList> {
    const provider = await this.#provider(providerId);
    try {
      return { models: [...(await listModels(provider, this.#http))] };
    } catch {
      throw new AiFailure('discovery-failed');
    }
  }

  async setDefaults(
    { tx, actorId }: InstallAiContext,
    body: AiDefaultModelUpdate,
  ): Promise<AiProvidersOverview> {
    this.#assertUnlocked(DEFAULT_KEYS);
    assertModelOffered(await this.#provider(body.providerId), body.modelId);

    await this.#settings.set('ai.defaultProvider', body.providerId, { updatedBy: actorId });
    await this.#settings.set('ai.defaultModel', body.modelId, { updatedBy: actorId });
    await this.#audit(tx, actorId, 'ai.default_model.updated', body.providerId, {
      modelId: body.modelId,
    });
    return this.overview();
  }

  /** For a brand's override (`BrandAiService`): the provider must exist and offer the model. */
  async assertModelAvailable(providerId: string, modelId: string): Promise<void> {
    assertModelOffered(await this.#provider(providerId), modelId);
  }

  async #provider(providerId: string): Promise<AiProviderConfig> {
    const provider = (await this.#settings.get('ai.providers')).find(
      (candidate) => candidate.id === providerId,
    );
    if (provider === undefined) {
      throw new AiFailure('unknown-provider');
    }
    return provider;
  }

  #locked(keys: readonly SettingKey[]): boolean {
    return keys.some((key) => this.#settings.isLockedByEnv(key));
  }

  #assertUnlocked(keys: readonly SettingKey[]): void {
    if (this.#locked(keys)) {
      throw new AiFailure('locked-by-environment');
    }
  }

  /** `ai_settings` is a tenant table; "does any brand use it?" needs every brand in scope. */
  async #reachEveryBrand(tx: DbTransaction): Promise<void> {
    const live = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(ne(brands.status, 'deleted'));
    await widenInstallScope(
      tx,
      live.map((brand) => brand.id),
    );
  }

  async #audit(
    tx: DbTransaction,
    actorId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'staff',
      actorId,
      action,
      targetType: 'ai_provider',
      targetId,
      meta,
    });
  }
}

const hasNewCredential = (auth: AiProviderUpsert['auth']): boolean =>
  (auth.type === 'apiKey' && auth.apiKey !== undefined) ||
  (auth.type === 'oauth' && auth.credentials !== undefined);

/**
 * The credential to store: the one sent, or the stored one when none was sent
 * and the type did not change. A new provider, or a change of type, must
 * bring its own.
 */
const credentialFor = (
  auth: AiProviderUpsert['auth'],
  existing: AiProviderConfig | undefined,
): AiProviderConfig['auth'] => {
  switch (auth.type) {
    case 'none':
      return { type: 'none' };
    case 'apiKey':
      if (auth.apiKey !== undefined) {
        return { type: 'apiKey', apiKey: auth.apiKey };
      }
      if (existing?.auth.type === 'apiKey') {
        return existing.auth;
      }
      throw new AiFailure('credential-required');
    case 'oauth':
      if (auth.credentials !== undefined) {
        return { type: 'oauth', credentials: auth.credentials };
      }
      if (existing?.auth.type === 'oauth') {
        return existing.auth;
      }
      throw new AiFailure('credential-required');
  }
};

/**
 * A built-in provider's model must be in pi-ai's registry. An OpenAI-compatible
 * server is not asked here: it may be down while it is being configured, and a
 * wrong id fails the first call, which is logged.
 */
const assertModelOffered = (provider: AiProviderConfig, modelId: string): void => {
  if (provider.kind === OPENAI_COMPATIBLE_KIND || !isBuiltInKind(provider.kind)) {
    return;
  }
  try {
    resolveModel(provider, modelId);
  } catch (error) {
    if (error instanceof ModelNotFoundError) {
      throw new AiFailure('unknown-model');
    }
    throw error;
  }
};
