import { z } from 'zod';

/**
 * The knowledge sources API (M7-03), built for the `Admin/AI-Knowledge`
 * artboard of M7-10: the sources table (type, visibility, chunks, last sync,
 * schedule, status with its reason, "Sync now"), the add-source dialog (files,
 * a website crawl with its options, Notion, Google Drive), the source drawer
 * with its sync log, and removal.
 *
 * **Credentials are write-only.** A Notion token or a Google grant is stored
 * encrypted on the source; a response only says whether the source is
 * connected.
 */

export const knowledgeSourceKindSchema = z.enum(['article', 'file', 'crawl', 'notion', 'gdrive']);
export type KnowledgeSourceKind = z.infer<typeof knowledgeSourceKindSchema>;

/** Uploads, crawls, Notion and Drive default to `internal` (DOMAIN-RULES §5). */
export const knowledgeVisibilitySchema = z.enum(['public', 'internal']);
export type KnowledgeVisibility = z.infer<typeof knowledgeVisibilitySchema>;

/**
 * `automatic` is what articles (on publish) and files (on upload) have; the
 * others are chosen for crawls, Notion and Drive. Daily and weekly runs are at
 * 03:00 in the brand's time zone, weekly on Sunday.
 */
export const knowledgeScheduleSchema = z.enum(['automatic', 'daily', 'weekly', 'manual']);
export type KnowledgeSchedule = z.infer<typeof knowledgeScheduleSchema>;
export const knowledgeChosenScheduleSchema = z.enum(['daily', 'weekly', 'manual']);

export const knowledgeSyncStateSchema = z.enum(['idle', 'queued', 'syncing', 'ok', 'failed']);
export type KnowledgeSyncState = z.infer<typeof knowledgeSyncStateSchema>;

/** The add-source dialog's caps. */
export const KNOWLEDGE_CRAWL_MAX_PAGES = 5_000;
export const KNOWLEDGE_CONNECTOR_MAX_ITEMS = 2_000;
export const KNOWLEDGE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const KNOWLEDGE_FILE_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
] as const;

const httpUrl = z.url({ protocol: /^https?$/ }).max(2_000);
const patterns = z.array(z.string().trim().min(1).max(200)).max(50).default([]);
const ids = z.array(z.string().trim().min(1).max(100)).max(100);

export const crawlConfigSchema = z.object({
  /** Read a sitemap, or follow links from a seed page. */
  mode: z.enum(['sitemap', 'seed']),
  url: httpUrl,
  maxPages: z.int().min(1).max(KNOWLEDGE_CRAWL_MAX_PAGES).default(100),
  include: patterns,
  exclude: patterns,
  /** Render with a headless browser; refused while the install has it off. */
  render: z.boolean().default(false),
});
export type CrawlConfig = z.infer<typeof crawlConfigSchema>;

export const notionConfigSchema = z.object({
  pageIds: ids.default([]),
  databaseIds: ids.default([]),
});
export type NotionConfig = z.infer<typeof notionConfigSchema>;

export const gdriveConfigSchema = z.object({ folderIds: ids.default([]) });
export type GdriveConfig = z.infer<typeof gdriveConfigSchema>;

/** What an upload stored about its file. */
export const fileConfigSchema = z.object({
  fileName: z.string(),
  mime: z.enum(KNOWLEDGE_FILE_MIME_TYPES),
  size: z.int().nonnegative(),
  uploaded: z.boolean(),
});
export type FileConfig = z.infer<typeof fileConfigSchema>;

const name = z.string().trim().min(1).max(200);

// ------------------------------------------------------------------ requests

export const knowledgeSourceCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('crawl'),
    name: name.optional(),
    visibility: knowledgeVisibilitySchema.default('internal'),
    schedule: knowledgeChosenScheduleSchema.default('daily'),
    config: crawlConfigSchema,
  }),
  z.object({
    kind: z.literal('notion'),
    name,
    visibility: knowledgeVisibilitySchema.default('internal'),
    schedule: knowledgeChosenScheduleSchema.default('daily'),
    config: notionConfigSchema.default({ pageIds: [], databaseIds: [] }),
    /** An internal integration token, instead of connecting with OAuth. Write-only. */
    token: z.string().trim().min(1).max(500).optional(),
  }),
  z.object({
    kind: z.literal('gdrive'),
    name,
    visibility: knowledgeVisibilitySchema.default('internal'),
    schedule: knowledgeChosenScheduleSchema.default('daily'),
    config: gdriveConfigSchema.default({ folderIds: [] }),
  }),
]);
export type KnowledgeSourceCreate = z.input<typeof knowledgeSourceCreateSchema>;

/** Every field optional; `config` is checked against the source's own kind. */
export const knowledgeSourceUpdateSchema = z.object({
  name: name.optional(),
  visibility: knowledgeVisibilitySchema.optional(),
  schedule: knowledgeChosenScheduleSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** A new Notion integration token. */
  token: z.string().trim().min(1).max(500).optional(),
});
export type KnowledgeSourceUpdate = z.infer<typeof knowledgeSourceUpdateSchema>;

export const knowledgeFilePresignSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mime: z.enum(KNOWLEDGE_FILE_MIME_TYPES),
  size: z.int().positive().max(KNOWLEDGE_UPLOAD_MAX_BYTES),
  visibility: knowledgeVisibilitySchema.default('internal'),
});
export type KnowledgeFilePresign = z.input<typeof knowledgeFilePresignSchema>;

export const knowledgeFilePresignResponseSchema = z.object({
  sourceId: z.uuid(),
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type KnowledgeFilePresignResponse = z.infer<typeof knowledgeFilePresignResponseSchema>;

export const knowledgeSourceParamSchema = z.object({ brandId: z.uuid(), sourceId: z.uuid() });
export type KnowledgeSourceParam = z.infer<typeof knowledgeSourceParamSchema>;

export const knowledgeLogQuerySchema = z.object({
  /** `warn` is the drawer's "Warnings" filter: warnings and errors only. */
  level: z.enum(['all', 'warn']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type KnowledgeLogQuery = z.infer<typeof knowledgeLogQuerySchema>;

export const knowledgeBrowseQuerySchema = z.object({
  /** Notion: the search text. */
  q: z.string().trim().max(200).default(''),
  /** Drive: the folder to list inside; the top level when absent. */
  parentId: z.string().trim().min(1).max(100).optional(),
});
export type KnowledgeBrowseQuery = z.infer<typeof knowledgeBrowseQuerySchema>;

export const knowledgeOAuthProviderSchema = z.enum(['notion', 'gdrive']);
export type KnowledgeOAuthProvider = z.infer<typeof knowledgeOAuthProviderSchema>;

export const knowledgeOAuthCallbackQuerySchema = z.object({
  provider: knowledgeOAuthProviderSchema,
  code: z.string().min(1).max(2_000).optional(),
  state: z.string().min(1).max(4_000),
  error: z.string().max(200).optional(),
});
export type KnowledgeOAuthCallbackQuery = z.infer<typeof knowledgeOAuthCallbackQuerySchema>;

export const knowledgeOAuthProviderParamSchema = knowledgeSourceParamSchema.extend({
  provider: knowledgeOAuthProviderSchema,
});

// ------------------------------------------------------------------ responses

export const knowledgeSourceConfigViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('article') }),
  z.object({ kind: z.literal('file'), file: fileConfigSchema }),
  z.object({ kind: z.literal('crawl'), crawl: crawlConfigSchema }),
  z.object({ kind: z.literal('notion'), notion: notionConfigSchema, connected: z.boolean() }),
  z.object({ kind: z.literal('gdrive'), gdrive: gdriveConfigSchema, connected: z.boolean() }),
]);
export type KnowledgeSourceConfigView = z.infer<typeof knowledgeSourceConfigViewSchema>;

export const knowledgeSourceViewSchema = z.object({
  id: z.uuid(),
  kind: knowledgeSourceKindSchema,
  name: z.string(),
  /** Null for the help center source: each article follows its own ("Per article"). */
  visibility: knowledgeVisibilitySchema.nullable(),
  schedule: knowledgeScheduleSchema,
  /** The next scheduled run, for daily and weekly sources. */
  nextSyncAt: z.iso.datetime().nullable(),
  status: z.object({
    state: knowledgeSyncStateSchema,
    /** Why the last run failed, as the service or the safe client said it. */
    reason: z.string().nullable(),
    /** `auth`: the service refused the credentials; the admin offers "Reconnect". */
    code: z.enum(['auth']).nullable(),
    progress: z.object({ done: z.int(), total: z.int().nullable() }).nullable(),
    startedAt: z.iso.datetime().nullable(),
  }),
  documents: z.int().nonnegative(),
  chunks: z.int().nonnegative(),
  /** Chunks that have a vector in the active embedding model. */
  embedded: z.int().nonnegative(),
  lastSyncedAt: z.iso.datetime().nullable(),
  config: knowledgeSourceConfigViewSchema,
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type KnowledgeSourceView = z.infer<typeof knowledgeSourceViewSchema>;

export const knowledgeSourceListSchema = z.object({
  sources: z.array(knowledgeSourceViewSchema),
  embedding: z.object({
    model: z.string().nullable(),
    status: z.enum(['unconfigured', 'reindexing', 'ready']),
  }),
  /** Whether "Render JavaScript" may be ticked on this install. */
  crawlRendering: z.boolean(),
  /** Whether the install has an OAuth app for each connector. */
  oauth: z.object({ notion: z.boolean(), gdrive: z.boolean() }),
});
export type KnowledgeSourceList = z.infer<typeof knowledgeSourceListSchema>;

/**
 * What a sync log line says, as a code the admin translates. `params` holds
 * the values: `url`, `chunks`, `index`, `total`, `rules`, `reason`, `detail`.
 */
export const knowledgeLogCodeSchema = z.enum([
  'sync.started',
  'sync.finished',
  'sync.failed',
  'robots.read',
  'robots.unreadable',
  'sitemap.read',
  'page.indexed',
  'page.skipped',
  'document.indexed',
  'document.skipped',
  'documents.removed',
  'injection.stripped',
  'file.rejected',
]);
export type KnowledgeLogCode = z.infer<typeof knowledgeLogCodeSchema>;

export const knowledgeLogLevelSchema = z.enum(['info', 'warn', 'error', 'done']);
export type KnowledgeLogLevel = z.infer<typeof knowledgeLogLevelSchema>;

export const knowledgeLogLineSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  level: knowledgeLogLevelSchema,
  code: knowledgeLogCodeSchema,
  params: z.record(z.string(), z.unknown()),
  at: z.iso.datetime(),
});
export type KnowledgeLogLine = z.infer<typeof knowledgeLogLineSchema>;

export const knowledgeLogSchema = z.object({ lines: z.array(knowledgeLogLineSchema) });
export type KnowledgeLog = z.infer<typeof knowledgeLogSchema>;

export const knowledgeBrowseItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['page', 'database', 'folder']),
});
export const knowledgeBrowseSchema = z.object({ items: z.array(knowledgeBrowseItemSchema) });
export type KnowledgeBrowse = z.infer<typeof knowledgeBrowseSchema>;

export const knowledgeOAuthStartSchema = z.object({ url: z.url() });
export type KnowledgeOAuthStart = z.infer<typeof knowledgeOAuthStartSchema>;

// ------------------------------------------------------------------ refusals

/** Which rule refused a knowledge request; the admin turns it into a sentence. */
export const knowledgeRefusalSchema = z.enum([
  /** The help center source is managed by publishing, not edited or removed. */
  'article-source-fixed',
  /** The config does not fit the source's kind. */
  'invalid-config',
  /** Only a file source is confirmed. */
  'not-a-file',
  /** The confirmed upload is not in storage, or is larger than declared. */
  'upload-missing',
  /** "Render JavaScript" asked for on an install that has it off. */
  'rendering-disabled',
  /** The install has no OAuth app for this service. */
  'oauth-not-configured',
  /** The OAuth answer did not match a request this install made. */
  'oauth-state-invalid',
  /** The source holds no credential yet. */
  'not-connected',
  /** The service refused the stored credential. */
  'connection-refused',
  /** The service could not be reached. */
  'service-unavailable',
]);
export type KnowledgeRefusal = z.infer<typeof knowledgeRefusalSchema>;
