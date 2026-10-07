import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ConnectorAuthError,
  type ConnectorEvent,
  type CrawlFetch,
  crawlSite,
  type ExtractedDocument,
  extractFile,
  isKnowledgeFileMime,
  KNOWLEDGE_FILE_MAX_BYTES,
  loadDrive,
  loadNotion,
  type SkipReason,
} from '@helpdock/ai';
import type { Keyring } from '@helpdock/config';
import type { KnowledgeSource } from '@helpdock/db';
import {
  crawlConfigSchema,
  fileConfigSchema,
  gdriveConfigSchema,
  KNOWLEDGE_CONNECTOR_MAX_ITEMS,
  type KnowledgeLogCode,
  type KnowledgeLogLevel,
  notionConfigSchema,
} from '@helpdock/schemas';
import { type ByteFamily, MAGIC_BYTES_PROBE, sniffFamily } from '../media/magic-bytes.js';
import type { ObjectStorage } from '../media/storage.js';
import { withTempDir } from '../media/temp-dir.js';
import type { ClosableRenderer } from './crawl-renderer.js';
import { type OAuthApps, openCredential } from './credentials.js';

/**
 * One source read into documents (M7-03), as a stream of {@link LoadEvent}s
 * the sync job stores and logs. Which loader runs is the source's kind:
 *
 * - `file`: the upload, read from the bucket, its bytes checked against the
 *   declared type (`media/magic-bytes.ts`, ADR 0009) before any parser sees
 *   them;
 * - `crawl`: `crawlSite` over the SSRF-safe client, rendered in a headless
 *   browser when the source asks and the install allows;
 * - `notion`, `gdrive`: the connectors, with the source's decrypted credential
 *   and the install's OAuth app.
 *
 * A loader that finishes returns `complete: true`, and only then does the
 * job remove the documents it did not see: a crawl cut short by a failure
 * must not empty the source.
 */

export interface ConnectorEndpoints {
  readonly notionBaseUrl?: string;
  readonly driveRootUrl?: string;
  readonly googleTokenUrl?: string;
}

export interface SourceLoaderDeps {
  readonly storage: Pick<ObjectStorage, 'download'>;
  readonly crawlFetch: CrawlFetch;
  /** Null while `KNOWLEDGE_CRAWL_RENDER` is off. */
  readonly renderer: (() => Promise<ClosableRenderer>) | null;
  /** WHATWG `fetch` over the safe client, for the connectors' SDKs. */
  readonly fetch: typeof fetch;
  readonly endpoints?: ConnectorEndpoints;
  readonly keyring: Keyring;
  readonly oauthApps: () => Promise<OAuthApps>;
  /** The least time between two crawl requests; the per-source rate limit. */
  readonly crawlDelayMs?: number;
}

export type LoadEvent =
  | {
      readonly type: 'document';
      readonly externalId: string;
      readonly url: string | null;
      readonly document: ExtractedDocument;
      readonly code: 'page.indexed' | 'document.indexed';
    }
  | {
      readonly type: 'log';
      readonly level: KnowledgeLogLevel;
      readonly code: KnowledgeLogCode;
      readonly params: Record<string, unknown>;
    }
  | { readonly type: 'progress'; readonly done: number; readonly total: number | null };

export interface LoadOutcome {
  readonly complete: boolean;
}

/** The file of a source, by uuids alone so nothing typed reaches the bucket. */
export const knowledgeFileKey = (brandId: string, sourceId: string): string =>
  `brands/${brandId}/knowledge/${sourceId}/original`;

/** The families each knowledge type's bytes may be (ADR 0009). */
const FAMILY_BY_MIME: Readonly<Record<string, ByteFamily>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'text/markdown': 'text',
  'text/plain': 'text',
};

export const bytesFitKnowledgeMime = (bytes: Uint8Array, mime: string): boolean =>
  FAMILY_BY_MIME[mime] === sniffFamily(bytes.subarray(0, MAGIC_BYTES_PROBE));

/** A sync that cannot go on, with the log line that says why. */
export class SourceLoadError extends Error {
  readonly code: KnowledgeLogCode;

  constructor(code: KnowledgeLogCode, message: string) {
    super(message);
    this.name = 'SourceLoadError';
    this.code = code;
  }
}

async function* loadFile(
  source: KnowledgeSource,
  deps: SourceLoaderDeps,
): AsyncGenerator<LoadEvent, LoadOutcome> {
  const file = fileConfigSchema.parse(source.config);
  if (!isKnowledgeFileMime(file.mime)) {
    throw new SourceLoadError('file.rejected', `type ${file.mime} is not read`);
  }
  const bytes = await withTempDir(async (dir) => {
    const target = path.join(dir, 'original');
    await deps.storage.download(
      knowledgeFileKey(source.brandId, source.id),
      target,
      KNOWLEDGE_FILE_MAX_BYTES,
    );
    return new Uint8Array(await readFile(target));
  });
  if (!bytesFitKnowledgeMime(bytes, file.mime)) {
    throw new SourceLoadError(
      'file.rejected',
      `the file is not the ${file.mime} it was declared as`,
    );
  }
  yield {
    type: 'document',
    externalId: 'file',
    url: null,
    document: await extractFile(bytes, file.mime, file.fileName),
    code: 'document.indexed',
  };
  return { complete: true };
}

/** Skips the admin wants one line for, not one per URL. */
const COUNTED_SKIPS: ReadonlySet<SkipReason> = new Set(['robots', 'excluded', 'not-included']);

async function* loadCrawl(
  source: KnowledgeSource,
  deps: SourceLoaderDeps,
): AsyncGenerator<LoadEvent, LoadOutcome> {
  const config = crawlConfigSchema.parse(source.config);
  if (config.render && deps.renderer === null) {
    throw new SourceLoadError('sync.failed', 'JavaScript rendering is turned off on this install');
  }
  const renderer = config.render && deps.renderer !== null ? await deps.renderer() : undefined;
  const counted = new Map<SkipReason, number>();
  let total: number | null = null;
  try {
    for await (const event of crawlSite(
      { ...config, ...(deps.crawlDelayMs === undefined ? {} : { minDelayMs: deps.crawlDelayMs }) },
      { fetch: deps.crawlFetch, renderer },
    )) {
      switch (event.type) {
        case 'robots':
          yield event.readable
            ? { type: 'log', level: 'info', code: 'robots.read', params: { rules: event.rules } }
            : { type: 'log', level: 'warn', code: 'robots.unreadable', params: {} };
          break;
        case 'sitemap':
          total = event.kept;
          yield {
            type: 'log',
            level: 'info',
            code: 'sitemap.read',
            params: { found: event.found, kept: event.kept },
          };
          yield { type: 'progress', done: 0, total };
          break;
        case 'skipped':
          if (COUNTED_SKIPS.has(event.reason)) {
            counted.set(event.reason, (counted.get(event.reason) ?? 0) + 1);
          } else {
            yield {
              type: 'log',
              level: 'warn',
              code: 'page.skipped',
              params: { url: event.url, reason: event.reason, detail: event.detail ?? null },
            };
          }
          break;
        case 'page':
          yield {
            type: 'document',
            externalId: event.url,
            url: event.url,
            document: event.document,
            code: 'page.indexed',
          };
          yield { type: 'progress', done: event.index, total };
          break;
      }
    }
  } finally {
    await renderer?.close();
  }
  for (const [reason, count] of counted) {
    yield { type: 'log', level: 'info', code: 'page.skipped', params: { reason, count } };
  }
  return { complete: true };
}

async function* fromConnector(
  events: AsyncGenerator<ConnectorEvent>,
): AsyncGenerator<LoadEvent, LoadOutcome> {
  let done = 0;
  for await (const event of events) {
    done += 1;
    if (event.type === 'document') {
      yield { ...event, code: 'document.indexed' };
    } else {
      yield {
        type: 'log',
        level: 'warn',
        code: 'document.skipped',
        params: { name: event.name, detail: event.detail },
      };
    }
    yield { type: 'progress', done, total: null };
  }
  return { complete: true };
}

const NOT_CONNECTED = 'not connected yet: connect the source first';

async function* loadNotionSource(
  source: KnowledgeSource,
  deps: SourceLoaderDeps,
): AsyncGenerator<LoadEvent, LoadOutcome> {
  const credential = openCredential(source.configEncrypted, deps.keyring);
  if (credential?.service !== 'notion') {
    throw new ConnectorAuthError('Notion', NOT_CONNECTED);
  }
  return yield* fromConnector(
    loadNotion(
      notionConfigSchema.parse(source.config),
      {
        token: credential.token,
        fetch: deps.fetch,
        ...(deps.endpoints?.notionBaseUrl === undefined
          ? {}
          : { baseUrl: deps.endpoints.notionBaseUrl }),
      },
      { maxPages: KNOWLEDGE_CONNECTOR_MAX_ITEMS },
    ),
  );
}

async function* loadDriveSource(
  source: KnowledgeSource,
  deps: SourceLoaderDeps,
): AsyncGenerator<LoadEvent, LoadOutcome> {
  const credential = openCredential(source.configEncrypted, deps.keyring);
  const app = (await deps.oauthApps()).gdrive;
  if (credential?.service !== 'gdrive' || app === null) {
    throw new ConnectorAuthError('Google Drive', NOT_CONNECTED);
  }
  return yield* fromConnector(
    loadDrive(
      gdriveConfigSchema.parse(source.config),
      {
        app,
        refreshToken: credential.refreshToken,
        fetch: deps.fetch,
        ...(deps.endpoints?.driveRootUrl === undefined
          ? {}
          : { rootUrl: deps.endpoints.driveRootUrl }),
        ...(deps.endpoints?.googleTokenUrl === undefined
          ? {}
          : { tokenUrl: deps.endpoints.googleTokenUrl }),
      },
      { maxFiles: KNOWLEDGE_CONNECTOR_MAX_ITEMS },
    ),
  );
}

export const loadSource = (
  source: KnowledgeSource,
  deps: SourceLoaderDeps,
): AsyncGenerator<LoadEvent, LoadOutcome> => {
  switch (source.kind) {
    case 'file':
      return loadFile(source, deps);
    case 'crawl':
      return loadCrawl(source, deps);
    case 'notion':
      return loadNotionSource(source, deps);
    case 'gdrive':
      return loadDriveSource(source, deps);
    case 'article':
      throw new SourceLoadError('sync.failed', 'articles are synced from the help center');
  }
};
