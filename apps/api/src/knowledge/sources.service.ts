import {
  browseDrive,
  browseNotion,
  ConnectorAuthError,
  driveAuthorizeUrl,
  exchangeDriveCode,
  exchangeNotionCode,
  notionAuthorizeUrl,
  type OAuthTokens,
} from '@helpdock/ai';
import type { Keyring } from '@helpdock/config';
import {
  auditLog,
  brands,
  type Db,
  type DbTransaction,
  type KnowledgeSource,
  readEmbeddingSpace,
  systemContext,
  withTenant,
} from '@helpdock/db';
import {
  crawlConfigSchema,
  fileConfigSchema,
  gdriveConfigSchema,
  type KnowledgeBrowse,
  type KnowledgeBrowseQuery,
  type KnowledgeFilePresign,
  type KnowledgeFilePresignResponse,
  type KnowledgeLog,
  type KnowledgeLogQuery,
  type KnowledgeOAuthCallbackQuery,
  type KnowledgeOAuthProvider,
  type KnowledgeOAuthStart,
  type KnowledgeSourceConfigView,
  type KnowledgeSourceCreate,
  type KnowledgeSourceList,
  type KnowledgeSourceUpdate,
  type KnowledgeSourceView,
  knowledgeFilePresignSchema,
  knowledgeSourceCreateSchema,
  notionConfigSchema,
  safeFileName,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { ObjectStorage } from '../media/storage.js';
import {
  type ConnectorCredential,
  type OAuthApps,
  openCredential,
  sealCredential,
} from './credentials.js';
import { KnowledgeRepository, type SourceRow } from './knowledge.repository.js';
import {
  enqueueSourceChanged,
  enqueueSourceRemoved,
  enqueueSyncRequested,
} from './knowledge-events.js';
import { KnowledgeFailure } from './knowledge-failure.js';
import { type ConnectorEndpoints, knowledgeFileKey } from './load-source.js';
import { type OAuthState, OAuthStateSigner } from './oauth-state.js';
import { nextRunAt } from './schedule.js';

/**
 * The knowledge sources of a brand (M7-03), as the `Admin/AI-Knowledge`
 * screen of M7-10 reads and changes them. Every change is audited and writes
 * its side effects to the outbox in the same transaction (DOMAIN-RULES §6):
 * a sync to run, a schedule to set, a file to delete.
 *
 * - **Visibility** defaults to `internal`. A re-scope re-labels the source's
 *   chunks in the same transaction, so retrieval sees it at the commit.
 * - **Removal** deletes the source's documents and chunks in the request's
 *   transaction (DOMAIN-RULES §11: "immediate"); its file and its schedule go
 *   after, through the outbox.
 * - **Credentials** are sealed with `APP_MASTER_KEY` and never returned.
 * - The help center source is created by the first article sync, follows each
 *   article's own visibility, and can be synced but not edited or removed.
 */

export interface KnowledgeContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actorId: string;
}

export interface KnowledgeSourcesOptions {
  readonly storage: ObjectStorage;
  readonly keyring: Keyring;
  readonly oauthApps: () => Promise<OAuthApps>;
  /** WHATWG `fetch` over the SSRF-safe client, for browsing and token exchange. */
  readonly fetch: typeof fetch;
  readonly endpoints?: ConnectorEndpoints;
  readonly crawlRendering: boolean;
  readonly appUrl: string;
  readonly masterKey: string;
  readonly now?: () => Date;
}

/** Where the admin lands after an OAuth round trip; the M7-10 screen reads the query. */
export const KNOWLEDGE_ADMIN_PATH = '/admin/ai/knowledge';
export const OAUTH_CALLBACK_PATH = '/api/knowledge/oauth/callback';

const configView = (source: KnowledgeSource): KnowledgeSourceConfigView => {
  const connected = source.configEncrypted !== null;
  switch (source.kind) {
    case 'article':
      return { kind: 'article' };
    case 'file':
      return { kind: 'file', file: fileConfigSchema.parse(source.config) };
    case 'crawl':
      return { kind: 'crawl', crawl: crawlConfigSchema.parse(source.config) };
    case 'notion':
      return { kind: 'notion', notion: notionConfigSchema.parse(source.config), connected };
    case 'gdrive':
      return { kind: 'gdrive', gdrive: gdriveConfigSchema.parse(source.config), connected };
  }
};

export const toSourceView = (
  { source, counts, createdByName }: SourceRow,
  timezone: string,
  now: Date,
): KnowledgeSourceView => ({
  id: source.id,
  kind: source.kind,
  name: source.name,
  visibility: source.kind === 'article' ? null : source.visibility,
  schedule: source.schedule,
  nextSyncAt: nextRunAt(source.schedule, timezone, now)?.toISOString() ?? null,
  status: {
    state: source.syncStatus,
    reason: source.lastError,
    code: source.lastErrorCode === 'auth' ? 'auth' : null,
    progress:
      source.syncStatus === 'syncing'
        ? { done: source.progressDone, total: source.progressTotal }
        : null,
    startedAt: source.syncStartedAt?.toISOString() ?? null,
  },
  documents: counts.documents,
  chunks: counts.chunks,
  embedded: counts.embedded,
  lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
  config: configView(source),
  createdBy: createdByName,
  createdAt: source.createdAt.toISOString(),
});

/** The config a source of this kind takes, or the refusal. */
const parseConfig = (kind: KnowledgeSource['kind'], config: unknown): Record<string, unknown> => {
  const schema: z.ZodType | null =
    kind === 'crawl'
      ? crawlConfigSchema
      : kind === 'notion'
        ? notionConfigSchema
        : kind === 'gdrive'
          ? gdriveConfigSchema
          : null;
  const parsed = schema?.safeParse(config);
  if (parsed?.success !== true) {
    throw new KnowledgeFailure('invalid-config');
  }
  return parsed.data as Record<string, unknown>;
};

/** Whether a source has anything to read yet: a connector needs a credential and a pick. */
const readyToSync = (
  source: Pick<KnowledgeSource, 'kind' | 'config' | 'configEncrypted'>,
): boolean => {
  switch (source.kind) {
    case 'crawl':
      return true;
    case 'notion': {
      const config = notionConfigSchema.parse(source.config);
      return (
        source.configEncrypted !== null && config.pageIds.length + config.databaseIds.length > 0
      );
    }
    case 'gdrive':
      return (
        source.configEncrypted !== null &&
        gdriveConfigSchema.parse(source.config).folderIds.length > 0
      );
    default:
      return false;
  }
};

export class KnowledgeSourcesService {
  readonly #repository = new KnowledgeRepository();
  readonly #options: KnowledgeSourcesOptions;
  readonly #state: OAuthStateSigner;

  constructor(options: KnowledgeSourcesOptions) {
    this.#options = options;
    this.#state = new OAuthStateSigner(options.masterKey);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  async #timezone(tx: DbTransaction, brandId: string): Promise<string> {
    const [brand] = await tx
      .select({ timezone: brands.timezone })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    return brand?.timezone ?? 'UTC';
  }

  async #activeModel(
    tx: DbTransaction,
  ): Promise<{ model: string | null; status: KnowledgeSourceList['embedding']['status'] }> {
    const space = await readEmbeddingSpace(tx);
    return { model: space.status === 'ready' ? space.activeModel : null, status: space.status };
  }

  async list(tx: DbTransaction, brandId: string): Promise<KnowledgeSourceList> {
    const embedding = await this.#activeModel(tx);
    const timezone = await this.#timezone(tx, brandId);
    const now = this.#now();
    const rows = await this.#repository.list(tx, embedding.model);
    const apps = await this.#options.oauthApps();
    return {
      sources: rows.map((row) => toSourceView(row, timezone, now)),
      embedding,
      crawlRendering: this.#options.crawlRendering,
      oauth: { notion: apps.notion !== null, gdrive: apps.gdrive !== null },
    };
  }

  async get(tx: DbTransaction, brandId: string, sourceId: string): Promise<KnowledgeSourceView> {
    const { model } = await this.#activeModel(tx);
    const row = await this.#repository.row(tx, sourceId, model);
    if (row === undefined) {
      throw new NotFoundException('No such knowledge source');
    }
    return toSourceView(row, await this.#timezone(tx, brandId), this.#now());
  }

  async #require(tx: DbTransaction, sourceId: string): Promise<KnowledgeSource> {
    const source = await this.#repository.find(tx, sourceId);
    if (source === undefined) {
      throw new NotFoundException('No such knowledge source');
    }
    return source;
  }

  async #audit(
    { tx, brandId, actorId }: KnowledgeContext,
    action: string,
    sourceId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId,
      action,
      targetType: 'knowledge_source',
      targetId: sourceId,
      meta,
    });
  }

  async create(
    context: KnowledgeContext,
    input: KnowledgeSourceCreate,
  ): Promise<KnowledgeSourceView> {
    const body = knowledgeSourceCreateSchema.parse(input);
    if (body.kind === 'crawl' && body.config.render && !this.#options.crawlRendering) {
      throw new KnowledgeFailure('rendering-disabled');
    }
    const token = body.kind === 'notion' ? body.token : undefined;
    const name = body.name ?? (body.kind === 'crawl' ? new URL(body.config.url).host : body.kind);
    const source = await this.#repository.insert(context.tx, context.brandId, {
      kind: body.kind,
      name,
      visibility: body.visibility,
      schedule: body.schedule,
      config: body.config,
      configEncrypted:
        token === undefined
          ? null
          : sealCredential({ service: 'notion', token }, this.#options.keyring),
      createdBy: context.actorId,
    });
    await this.#audit(context, 'knowledge_source.created', source.id, {
      kind: source.kind,
      name,
      visibility: source.visibility,
      schedule: source.schedule,
    });
    await enqueueSourceChanged(context.tx, context.brandId, source.id);
    if (readyToSync(source)) {
      await this.#requestSync(context, source.id, 'created');
    }
    return this.get(context.tx, context.brandId, source.id);
  }

  async update(
    context: KnowledgeContext,
    sourceId: string,
    body: KnowledgeSourceUpdate,
  ): Promise<KnowledgeSourceView> {
    const source = await this.#require(context.tx, sourceId);
    if (source.kind === 'article') {
      throw new KnowledgeFailure('article-source-fixed');
    }
    if (body.schedule !== undefined && source.kind === 'file') {
      throw new KnowledgeFailure('invalid-config');
    }
    if (body.token !== undefined && source.kind !== 'notion') {
      throw new KnowledgeFailure('invalid-config');
    }
    if (body.config !== undefined && source.kind === 'file') {
      throw new KnowledgeFailure('invalid-config');
    }
    const config = body.config === undefined ? undefined : parseConfig(source.kind, body.config);
    if (source.kind === 'crawl' && config?.render === true && !this.#options.crawlRendering) {
      throw new KnowledgeFailure('rendering-disabled');
    }

    const changes = {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
      ...(body.schedule === undefined ? {} : { schedule: body.schedule }),
      ...(config === undefined ? {} : { config }),
      ...(body.token === undefined
        ? {}
        : {
            configEncrypted: sealCredential(
              { service: 'notion', token: body.token },
              this.#options.keyring,
            ),
            lastErrorCode: null,
          }),
    };
    await this.#repository.update(context.tx, sourceId, changes);
    if (body.visibility !== undefined && body.visibility !== source.visibility) {
      await this.#repository.relabel(context.tx, sourceId, body.visibility);
    }
    await this.#audit(context, 'knowledge_source.updated', sourceId, {
      before: {
        name: source.name,
        visibility: source.visibility,
        schedule: source.schedule,
        config: source.config,
      },
      after: {
        name: body.name ?? source.name,
        visibility: body.visibility ?? source.visibility,
        schedule: body.schedule ?? source.schedule,
        config: config ?? source.config,
      },
      credentialReplaced: body.token !== undefined,
    });
    if (body.schedule !== undefined && body.schedule !== source.schedule) {
      await enqueueSourceChanged(context.tx, context.brandId, sourceId);
    }
    const updated = await this.#require(context.tx, sourceId);
    if ((config !== undefined || body.token !== undefined) && readyToSync(updated)) {
      await this.#requestSync(context, sourceId, 'changed');
    }
    return this.get(context.tx, context.brandId, sourceId);
  }

  async remove(context: KnowledgeContext, sourceId: string): Promise<void> {
    const source = await this.#require(context.tx, sourceId);
    if (source.kind === 'article') {
      throw new KnowledgeFailure('article-source-fixed');
    }
    const chunks = await this.#repository.remove(context.tx, sourceId);
    await this.#audit(context, 'knowledge_source.removed', sourceId, {
      kind: source.kind,
      name: source.name,
      chunks,
    });
    await enqueueSourceRemoved(context.tx, context.brandId, {
      sourceId,
      objectKey: source.kind === 'file' ? knowledgeFileKey(context.brandId, sourceId) : null,
    });
  }

  async #requestSync(
    context: KnowledgeContext,
    sourceId: string,
    trigger: 'upload' | 'manual' | 'created' | 'changed',
  ): Promise<void> {
    const source = await this.#require(context.tx, sourceId);
    if (source.syncStatus !== 'syncing') {
      await this.#repository.update(context.tx, sourceId, { syncStatus: 'queued' });
    }
    await enqueueSyncRequested(context.tx, context.brandId, {
      sourceId,
      trigger,
      actorId: context.actorId,
    });
  }

  async syncNow(context: KnowledgeContext, sourceId: string): Promise<KnowledgeSourceView> {
    const source = await this.#require(context.tx, sourceId);
    if (source.kind === 'file' && fileConfigSchema.parse(source.config).uploaded !== true) {
      throw new KnowledgeFailure('upload-missing');
    }
    if ((source.kind === 'notion' || source.kind === 'gdrive') && source.configEncrypted === null) {
      throw new KnowledgeFailure('not-connected');
    }
    await this.#requestSync(context, sourceId, 'manual');
    await this.#audit(context, 'knowledge_source.sync_requested', sourceId, {});
    return this.get(context.tx, context.brandId, sourceId);
  }

  async presignFile(
    context: KnowledgeContext,
    input: KnowledgeFilePresign,
  ): Promise<KnowledgeFilePresignResponse> {
    const body = knowledgeFilePresignSchema.parse(input);
    const fileName = safeFileName(body.fileName);
    const source = await this.#repository.insert(context.tx, context.brandId, {
      kind: 'file',
      name: fileName,
      visibility: body.visibility,
      schedule: 'automatic',
      config: { fileName, mime: body.mime, size: body.size, uploaded: false },
      configEncrypted: null,
      createdBy: context.actorId,
    });
    await this.#audit(context, 'knowledge_source.created', source.id, {
      kind: 'file',
      name: fileName,
      visibility: body.visibility,
    });
    const upload = await this.#options.storage.presignUpload({
      key: knowledgeFileKey(context.brandId, source.id),
      contentType: body.mime,
      size: body.size,
    });
    return {
      sourceId: source.id,
      url: upload.url,
      headers: { ...upload.headers },
      expiresAt: upload.expiresAt.toISOString(),
    };
  }

  /** "It is uploaded": the object must be there and no larger than declared; then the sync runs. */
  async confirmFile(context: KnowledgeContext, sourceId: string): Promise<KnowledgeSourceView> {
    const source = await this.#require(context.tx, sourceId);
    if (source.kind !== 'file') {
      throw new KnowledgeFailure('not-a-file');
    }
    const file = fileConfigSchema.parse(source.config);
    if (!file.uploaded) {
      const head = await this.#options.storage.head(knowledgeFileKey(context.brandId, sourceId));
      if (head === undefined || head.size > file.size) {
        throw new KnowledgeFailure('upload-missing');
      }
      await this.#repository.update(context.tx, sourceId, {
        config: { ...file, size: head.size, uploaded: true },
      });
      await this.#requestSync(context, sourceId, 'upload');
    }
    return this.get(context.tx, context.brandId, sourceId);
  }

  async log(tx: DbTransaction, sourceId: string, query: KnowledgeLogQuery): Promise<KnowledgeLog> {
    await this.#require(tx, sourceId);
    return {
      lines: await this.#repository.logLines(tx, sourceId, {
        warningsOnly: query.level === 'warn',
        limit: query.limit,
      }),
    };
  }

  async #credential(source: KnowledgeSource): Promise<ConnectorCredential> {
    const credential = openCredential(source.configEncrypted, this.#options.keyring);
    if (credential === null) {
      throw new KnowledgeFailure('not-connected');
    }
    return credential;
  }

  /** What the connected account can see, for the picker. Asks the service, through the safe client. */
  async browse(
    tx: DbTransaction,
    sourceId: string,
    query: KnowledgeBrowseQuery,
  ): Promise<KnowledgeBrowse> {
    const source = await this.#require(tx, sourceId);
    if (source.kind !== 'notion' && source.kind !== 'gdrive') {
      throw new KnowledgeFailure('invalid-config');
    }
    const credential = await this.#credential(source);
    const { fetch, endpoints } = this.#options;
    try {
      if (credential.service === 'notion') {
        return {
          items: await browseNotion(
            {
              token: credential.token,
              fetch,
              ...(endpoints?.notionBaseUrl === undefined
                ? {}
                : { baseUrl: endpoints.notionBaseUrl }),
            },
            query.q,
          ),
        };
      }
      const app = (await this.#options.oauthApps()).gdrive;
      if (app === null) {
        throw new KnowledgeFailure('oauth-not-configured');
      }
      return {
        items: await browseDrive(
          {
            app,
            refreshToken: credential.refreshToken,
            fetch,
            ...(endpoints?.driveRootUrl === undefined ? {} : { rootUrl: endpoints.driveRootUrl }),
            ...(endpoints?.googleTokenUrl === undefined
              ? {}
              : { tokenUrl: endpoints.googleTokenUrl }),
          },
          query.parentId,
        ),
      };
    } catch (error) {
      if (error instanceof KnowledgeFailure) {
        throw error;
      }
      throw new KnowledgeFailure(
        error instanceof ConnectorAuthError ? 'connection-refused' : 'service-unavailable',
      );
    }
  }

  async oauthStart(
    context: KnowledgeContext,
    sourceId: string,
    provider: KnowledgeOAuthProvider,
  ): Promise<KnowledgeOAuthStart> {
    const source = await this.#require(context.tx, sourceId);
    if (source.kind !== provider) {
      throw new KnowledgeFailure('invalid-config');
    }
    const app = (await this.#options.oauthApps())[provider];
    if (app === null) {
      throw new KnowledgeFailure('oauth-not-configured');
    }
    const state = this.#state.sign({
      brandId: context.brandId,
      sourceId,
      provider,
      actorId: context.actorId,
    });
    const redirectUri = this.#redirectUri();
    return {
      url:
        provider === 'notion'
          ? notionAuthorizeUrl(app, redirectUri, state)
          : driveAuthorizeUrl(app, redirectUri, state),
    };
  }

  #redirectUri(): string {
    return new URL(OAUTH_CALLBACK_PATH, this.#options.appUrl).href;
  }

  #adminUrl(sourceId: string | null, outcome: 'connected' | 'failed'): string {
    const url = new URL(KNOWLEDGE_ADMIN_PATH, this.#options.appUrl);
    if (sourceId !== null) {
      url.searchParams.set('source', sourceId);
    }
    url.searchParams.set('oauth', outcome);
    return url.href;
  }

  /**
   * The provider's answer. Public — the browser arrives without the admin's
   * session — so the signed state is what authorises writing to the source.
   * Answers the admin URL to redirect to, with the outcome in its query.
   */
  async oauthCallback(db: Db, query: KnowledgeOAuthCallbackQuery): Promise<string> {
    const state = this.#state.verify(query.state, this.#now().getTime());
    if (state === null || state.provider !== query.provider) {
      throw new KnowledgeFailure('oauth-state-invalid');
    }
    if (query.code === undefined || query.error !== undefined) {
      return this.#adminUrl(state.sourceId, 'failed');
    }
    const tokens = await this.#exchange(state, query.code);
    if (tokens === null) {
      return this.#adminUrl(state.sourceId, 'failed');
    }
    const credential: ConnectorCredential =
      state.provider === 'notion'
        ? { service: 'notion', token: tokens.accessToken }
        : { service: 'gdrive', refreshToken: tokens.refreshToken ?? '' };
    if (credential.service === 'gdrive' && credential.refreshToken === '') {
      return this.#adminUrl(state.sourceId, 'failed');
    }
    await withTenant(db, systemContext(state.brandId, 'knowledge.oauth'), async (tx) => {
      const context = { tx, brandId: state.brandId, actorId: state.actorId };
      const source = await this.#require(tx, state.sourceId);
      await this.#repository.update(tx, source.id, {
        configEncrypted: sealCredential(credential, this.#options.keyring),
        lastErrorCode: null,
      });
      await this.#audit(context, 'knowledge_source.connected', source.id, {
        provider: state.provider,
      });
      if (readyToSync({ ...source, configEncrypted: 'sealed' })) {
        await this.#requestSync(context, source.id, 'changed');
      }
    });
    return this.#adminUrl(state.sourceId, 'connected');
  }

  async #exchange(state: OAuthState, code: string): Promise<OAuthTokens | null> {
    const app = (await this.#options.oauthApps())[state.provider];
    if (app === null) {
      throw new KnowledgeFailure('oauth-not-configured');
    }
    const { fetch, endpoints } = this.#options;
    const request = { code, redirectUri: this.#redirectUri() };
    try {
      return state.provider === 'notion'
        ? await exchangeNotionCode(app, request, {
            fetch,
            ...(endpoints?.notionBaseUrl === undefined ? {} : { baseUrl: endpoints.notionBaseUrl }),
          })
        : await exchangeDriveCode(app, request, {
            fetch,
            ...(endpoints?.googleTokenUrl === undefined
              ? {}
              : { tokenUrl: endpoints.googleTokenUrl }),
          });
    } catch {
      return null;
    }
  }
}
