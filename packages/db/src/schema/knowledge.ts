import { type SQL, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import {
  embeddingStatusEnum,
  hcVisibilityEnum,
  knowledgeLogLevelEnum,
  knowledgeSourceKindEnum,
  knowledgeSyncScheduleEnum,
  knowledgeSyncStatusEnum,
} from './enums.js';
import { hcArticles } from './help-center.js';
import { tsvector } from './tsvector.js';

/**
 * The AI knowledge base (M7-02; filled by M7-03's ingest, read by M7-04's
 * retrieval). Three brand-scoped tenant tables, none department-scoped: a
 * brand's knowledge is the brand's, like its help center, and who may *use* a
 * chunk is its visibility, filtered in SQL before ranking (DOMAIN-RULES §5).
 *
 * ```
 * knowledge_sources    one per help center, upload, crawl, Notion or Drive connection
 *   knowledge_documents  one per article, file, page
 *     knowledge_chunks     ~500-token pieces, each with its tsvector and its vector
 * ```
 *
 * **The vector column is not here.** `knowledge_chunks.embedding` is
 * `vector(<dims>)`, and the dimension is the install's embedding model's, so
 * `knowledge.configure` creates it through `helpdock_set_embedding_dims`
 * rather than a static migration (ADR 0005). Drizzle never selects it; the
 * code that writes and ranks by it uses SQL.
 */

/** Uploaded files, crawls, Notion and Drive default to internal (DOMAIN-RULES §5). */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    kind: knowledgeSourceKindEnum('kind').notNull(),
    name: text('name').notNull(),
    visibility: hcVisibilityEnum('visibility').notNull().default('internal'),
    /** What the loader needs that is not a secret: seed URLs, page ids, include patterns. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** OAuth tokens and the like, as an `encryptSecret` envelope. Never returned. */
    configEncrypted: text('config_encrypted'),
    syncStatus: knowledgeSyncStatusEnum('sync_status').notNull().default('idle'),
    /** M7-03. `automatic` for articles and files; crawls, Notion and Drive choose. */
    schedule: knowledgeSyncScheduleEnum('schedule').notNull().default('manual'),
    /** When the run in progress claimed the source; a stale claim may be taken over. */
    syncStartedAt: timestamp('sync_started_at', { withTimezone: true }),
    /** Pages or files done and planned in the run in progress, for "260 / 520 pages". */
    progressDone: integer('progress_done').notNull().default(0),
    progressTotal: integer('progress_total'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** `auth` when the service refused the credentials, so the admin shows "Reconnect". */
    lastErrorCode: text('last_error_code'),
    /** The staff member who added it, for "uploaded by" and "connected by". */
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('knowledge_sources_brand_idx').on(table.brandId),
    // One help center source per brand, created the first time an article syncs.
    uniqueIndex('knowledge_sources_article_key')
      .on(table.brandId)
      .where(sql`${table.kind} = 'article'`),
  ],
);

export type KnowledgeSource = typeof knowledgeSources.$inferSelect;

/**
 * One thing a source holds: an article, a file, a crawled page. `external_id`
 * is the source's own name for it, so a re-sync updates rather than
 * duplicates; `content_hash` is the indexing key of DOMAIN-RULES §6.
 */
export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    title: text('title').notNull().default(''),
    url: text('url'),
    /** Set for an `article` source: the help center article this document mirrors. */
    articleId: uuid('article_id').references(() => hcArticles.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('knowledge_documents_source_external_key').on(table.sourceId, table.externalId),
  ],
);

export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;

/**
 * M7-03. What a sync did, line by line, for the source drawer's log. A line is
 * a `code` and its `params`, not prose, so the admin renders it in the
 * reader's language; `run_id` groups the lines of one run.
 */
export const knowledgeSyncLog = pgTable(
  'knowledge_sync_log',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    level: knowledgeLogLevelEnum('level').notNull(),
    code: text('code').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('knowledge_sync_log_source_idx').on(table.sourceId, table.createdAt)],
);

export type KnowledgeSyncLogRow = typeof knowledgeSyncLog.$inferSelect;

/** `arabic` for Arabic chunks, `english` for the rest, as the help center index does. */
const chunkSearch = (): SQL =>
  sql.raw(
    `to_tsvector(case when "locale" = 'ar' then 'arabic'::regconfig else 'english'::regconfig end, "content")`,
  );

/**
 * The unit of retrieval. `visibility` is copied from the source when the chunk
 * is written, for the vector and full-text filters of DOMAIN-RULES §5; an
 * article chunk is additionally joined to the live article at query time,
 * which is what keeps a just-unpublished article out before the sync runs.
 *
 * `embedding_model` is the model the chunk's vector came from, null until it
 * has one. Retrieval ranks only rows whose model is the active one
 * (`activeEmbeddingSpace`), so two models' vectors are never compared even
 * when their dimensions agree (DOMAIN-RULES §8).
 *
 * `suspicious` is the injection filter's flag (M7-08): the chunk had text that
 * reads like an instruction to the model, which was stripped.
 */
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id').references(() => hcArticles.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    /** BCP 47 language of the text; `ar` and `en` get their own search configuration. */
    locale: text('locale').notNull(),
    visibility: hcVisibilityEnum('visibility').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    suspicious: boolean('suspicious').notNull().default(false),
    search: tsvector('search').generatedAlwaysAs(chunkSearch()),
    embeddingModel: text('embedding_model'),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    /** Heading path, page number, anchor: whatever a citation shows. */
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('knowledge_chunks_brand_source_idx').on(table.brandId, table.sourceId),
    index('knowledge_chunks_document_idx').on(table.documentId),
    // The re-embed walks a brand's chunks that are not yet in the target model.
    index('knowledge_chunks_brand_model_idx').on(table.brandId, table.embeddingModel),
  ],
);

export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type NewKnowledgeChunk = typeof knowledgeChunks.$inferInsert;

/**
 * The install's one embedding space (ADR 0005), a single row. Global, not a
 * tenant table: it holds a model name and a status, never a brand's data, and
 * every brand's retrieval reads the same row.
 *
 * `active_*` is what retrieval may rank by, and only while `status = ready`.
 * `target_*` is what the settings ask for. They differ while `knowledge.reembed`
 * moves every chunk from one to the other, during which `status = reindexing`
 * and retrieval is full text only (DOMAIN-RULES §8). `column_dims` is the
 * dimension `knowledge_chunks.embedding` has right now, null before the
 * column exists.
 */
export const embeddingSpace = pgTable(
  'embedding_space',
  {
    /** Always true: the primary key that makes this a single row. */
    singleton: boolean('singleton').primaryKey().default(true),
    status: embeddingStatusEnum('status').notNull().default('unconfigured'),
    activeModel: text('active_model'),
    activeDims: integer('active_dims'),
    targetProvider: text('target_provider'),
    targetModel: text('target_model'),
    targetDims: integer('target_dims'),
    columnDims: integer('column_dims'),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('embedding_space_singleton_check', sql`${table.singleton}`)],
);

export type EmbeddingSpaceRow = typeof embeddingSpace.$inferSelect;
