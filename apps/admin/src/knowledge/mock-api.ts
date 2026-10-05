import type {
  KnowledgeBrowse,
  KnowledgeLog,
  KnowledgeLogLine,
  KnowledgeOAuthProvider,
  KnowledgeSourceCreate,
  KnowledgeSourceList,
  KnowledgeSourceUpdate,
  KnowledgeSourceView,
  KnowledgeVisibility,
} from '@helpdock/schemas';
import { KNOWLEDGE_FILE_MIME_TYPES } from '@helpdock/schemas';
import { type KnowledgeApi, KnowledgeError } from './api.js';

/**
 * The knowledge fixture: the seven sources of `Admin/AI-Knowledge` — the help
 * center, two files, a crawl mid-sync, a crawl blocked by the safe client, a
 * Notion source whose access was revoked and a Drive folder — with the
 * crawl's sync log. What it refuses mirrors the api closely enough for the
 * screen's error lines to be exercised; the real rules are the api's.
 */

let sequence = 0;
const nextId = (): string => {
  sequence += 1;
  return `0192c3f0-5a2b-7c3d-8e4f-${sequence.toString(16).padStart(12, '0')}`;
};

type Overrides = Partial<Omit<KnowledgeSourceView, 'status'>> & {
  readonly status?: Partial<KnowledgeSourceView['status']>;
};

const source = (
  kind: KnowledgeSourceView['kind'],
  name: string,
  config: KnowledgeSourceView['config'],
  overrides: Overrides = {},
): KnowledgeSourceView => {
  const { status, ...rest } = overrides;
  return {
    id: nextId(),
    kind,
    name,
    visibility: 'internal',
    schedule: 'daily',
    nextSyncAt: '2026-10-06T00:00:00.000Z',
    documents: 0,
    chunks: 0,
    embedded: 0,
    lastSyncedAt: '2026-10-05T11:02:00.000Z',
    config,
    createdBy: 'Lina Haddad',
    createdAt: '2026-09-12T08:00:00.000Z',
    ...rest,
    status: {
      state: 'ok',
      reason: null,
      code: null,
      progress: null,
      startedAt: null,
      ...status,
    },
  };
};

const crawlConfig = (url: string, mode: 'sitemap' | 'seed', render = false) => ({
  kind: 'crawl' as const,
  crawl: { mode, url, maxPages: 600, include: [], exclude: [], render },
});

const fixture = (): KnowledgeSourceView[] => [
  source(
    'article',
    'Help center articles',
    { kind: 'article' },
    {
      visibility: null,
      schedule: 'automatic',
      nextSyncAt: null,
      documents: 96,
      chunks: 412,
      embedded: 412,
    },
  ),
  source(
    'file',
    'Billing FAQ.pdf',
    {
      kind: 'file',
      file: {
        fileName: 'Billing FAQ.pdf',
        mime: 'application/pdf',
        size: 2_400_000,
        uploaded: true,
      },
    },
    {
      visibility: 'public',
      schedule: 'automatic',
      nextSyncAt: null,
      documents: 1,
      chunks: 38,
      embedded: 38,
      createdBy: 'Sara',
    },
  ),
  source(
    'file',
    'Refund exceptions.docx',
    {
      kind: 'file',
      file: {
        fileName: 'Refund exceptions.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 180_000,
        uploaded: true,
      },
    },
    {
      schedule: 'automatic',
      nextSyncAt: null,
      documents: 1,
      chunks: 12,
      embedded: 12,
      createdBy: 'Omar',
    },
  ),
  source(
    'crawl',
    'docs.helpdock.io',
    crawlConfig('https://docs.helpdock.io/sitemap.xml', 'sitemap'),
    {
      visibility: 'public',
      documents: 260,
      chunks: 1_904,
      embedded: 1_904,
      status: {
        state: 'syncing',
        progress: { done: 260, total: 520 },
        startedAt: '2026-10-05T11:18:00.000Z',
      },
    },
  ),
  source(
    'crawl',
    'partners.helpdock.io',
    crawlConfig('https://partners.helpdock.io/', 'seed', true),
    {
      schedule: 'weekly',
      status: { state: 'failed', reason: 'Blocked: resolves to a private address (10.0.4.12)' },
    },
  ),
  source(
    'notion',
    'Notion · Support playbook',
    {
      kind: 'notion',
      notion: { pageIds: ['p1', 'p2', 'p3'], databaseIds: ['d1'] },
      connected: true,
    },
    {
      documents: 40,
      chunks: 286,
      embedded: 286,
      status: { state: 'failed', reason: 'Access revoked in Notion', code: 'auth' },
    },
  ),
  source(
    'gdrive',
    'Google Drive · Support/Policies',
    { kind: 'gdrive', gdrive: { folderIds: ['f1'] }, connected: true },
    { documents: 17, chunks: 341, embedded: 341 },
  ),
];

const line = (
  level: KnowledgeLogLine['level'],
  code: KnowledgeLogLine['code'],
  params: Record<string, unknown>,
  at: string,
): KnowledgeLogLine => ({ id: nextId(), runId: 'run', level, code, params, at });

const crawlLog = (): KnowledgeLogLine[] => [
  line(
    'info',
    'page.indexed',
    { url: 'https://docs.helpdock.io/docs/billing/refunds', chunks: 4, changed: true },
    '2026-10-05T11:20:41.000Z',
  ),
  line(
    'warn',
    'injection.stripped',
    { url: 'https://docs.helpdock.io/blog/ai-tips', chunks: 1 },
    '2026-10-05T11:20:39.000Z',
  ),
  line('info', 'page.skipped', { reason: 'excluded', count: 18 }, '2026-10-05T11:20:12.000Z'),
  line(
    'warn',
    'page.skipped',
    { url: 'https://docs.helpdock.io/docs/legacy/api', reason: 'status', detail: '404' },
    '2026-10-05T11:19:58.000Z',
  ),
  line('info', 'robots.read', { rules: 2 }, '2026-10-05T11:18:30.000Z'),
  line('info', 'sitemap.read', { found: 538, kept: 520 }, '2026-10-05T11:18:29.000Z'),
  line('info', 'sync.started', { trigger: 'manual' }, '2026-10-05T11:18:28.000Z'),
  line(
    'done',
    'sync.finished',
    { documents: 520, changed: 12, chunks: 1_904, removed: 0, embedded: 1_904 },
    '2026-10-05T00:04:10.000Z',
  ),
];

export class MockKnowledgeApi implements KnowledgeApi {
  readonly #byBrand = new Map<string, KnowledgeSourceView[]>();
  readonly #oauth: { notion: boolean; gdrive: boolean };

  constructor(options: { readonly oauth?: { notion: boolean; gdrive: boolean } } = {}) {
    this.#oauth = options.oauth ?? { notion: true, gdrive: true };
  }

  sources(brandId: string): Promise<KnowledgeSourceList> {
    return Promise.resolve({
      sources: structuredClone(this.#rows(brandId)),
      embedding: { model: 'text-embedding-3-small', status: 'ready' },
      crawlRendering: false,
      oauth: { ...this.#oauth },
    });
  }

  createSource(brandId: string, request: KnowledgeSourceCreate): Promise<KnowledgeSourceView> {
    if (request.kind === 'crawl' && request.config.render === true) {
      return Promise.reject(new KnowledgeError('rendering-disabled'));
    }
    const visibility = request.visibility ?? 'internal';
    const schedule = request.schedule ?? 'daily';
    const created =
      request.kind === 'crawl'
        ? source(
            'crawl',
            request.name ?? new URL(request.config.url).host,
            {
              kind: 'crawl',
              crawl: {
                mode: request.config.mode,
                url: request.config.url,
                maxPages: request.config.maxPages ?? 100,
                include: request.config.include ?? [],
                exclude: request.config.exclude ?? [],
                render: false,
              },
            },
            { visibility, schedule, lastSyncedAt: null, status: { state: 'queued' } },
          )
        : request.kind === 'notion'
          ? source(
              'notion',
              request.name,
              {
                kind: 'notion',
                notion: { pageIds: [], databaseIds: [] },
                connected: request.token !== undefined,
              },
              { visibility, schedule, lastSyncedAt: null, status: { state: 'idle' } },
            )
          : source(
              'gdrive',
              request.name,
              {
                kind: 'gdrive',
                gdrive: { folderIds: [] },
                connected: false,
              },
              { visibility, schedule, lastSyncedAt: null, status: { state: 'idle' } },
            );
    this.#rows(brandId).push(created);
    return Promise.resolve(structuredClone(created));
  }

  updateSource(
    brandId: string,
    sourceId: string,
    request: KnowledgeSourceUpdate,
  ): Promise<KnowledgeSourceView> {
    return this.#change(brandId, sourceId, (row) => {
      if (row.kind === 'article') {
        throw new KnowledgeError('article-source-fixed');
      }
      const config =
        request.config === undefined
          ? row.config
          : row.config.kind === 'notion'
            ? { ...row.config, notion: { ...row.config.notion, ...request.config } }
            : row.config.kind === 'gdrive'
              ? { ...row.config, gdrive: { ...row.config.gdrive, ...request.config } }
              : row.config;
      return {
        ...row,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.visibility === undefined ? {} : { visibility: request.visibility }),
        ...(request.schedule === undefined ? {} : { schedule: request.schedule }),
        config,
      };
    });
  }

  removeSource(brandId: string, sourceId: string): Promise<void> {
    const rows = this.#rows(brandId);
    const index = rows.findIndex((row) => row.id === sourceId);
    if (rows[index]?.kind === 'article') {
      return Promise.reject(new KnowledgeError('article-source-fixed'));
    }
    if (index === -1) {
      return Promise.reject(new Error('No such source'));
    }
    rows.splice(index, 1);
    return Promise.resolve();
  }

  syncNow(brandId: string, sourceId: string): Promise<KnowledgeSourceView> {
    return this.#change(brandId, sourceId, (row) => {
      if ((row.kind === 'notion' || row.kind === 'gdrive') && row.status.code === 'auth') {
        throw new KnowledgeError('connection-refused');
      }
      return {
        ...row,
        status: { state: 'queued', reason: null, code: null, progress: null, startedAt: null },
      };
    });
  }

  log(brandId: string, sourceId: string, level: 'all' | 'warn'): Promise<KnowledgeLog> {
    const row = this.#rows(brandId).find((candidate) => candidate.id === sourceId);
    const lines = row?.kind === 'crawl' && row.status.state === 'syncing' ? crawlLog() : [];
    return Promise.resolve({
      lines:
        level === 'warn' ? lines.filter((l) => l.level === 'warn' || l.level === 'error') : lines,
    });
  }

  browse(_brandId: string, _sourceId: string, query: string): Promise<KnowledgeBrowse> {
    const items: KnowledgeBrowse['items'] = [
      { id: 'p1', title: 'Support playbook', kind: 'page' },
      { id: 'p4', title: 'Escalation matrix', kind: 'page' },
      { id: 'd1', title: 'Known issues', kind: 'database' },
    ];
    return Promise.resolve({
      items: items.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())),
    });
  }

  uploadFile(
    brandId: string,
    file: File,
    visibility: KnowledgeVisibility,
  ): Promise<KnowledgeSourceView> {
    const mime = KNOWLEDGE_FILE_MIME_TYPES.find((type) => type === file.type);
    if (mime === undefined) {
      return Promise.reject(new KnowledgeError('invalid-config'));
    }
    const created = source(
      'file',
      file.name,
      { kind: 'file', file: { fileName: file.name, mime, size: file.size, uploaded: true } },
      {
        visibility,
        schedule: 'automatic',
        nextSyncAt: null,
        lastSyncedAt: null,
        status: { state: 'queued' },
      },
    );
    this.#rows(brandId).push(created);
    return Promise.resolve(structuredClone(created));
  }

  oauthStart(
    _brandId: string,
    sourceId: string,
    provider: KnowledgeOAuthProvider,
  ): Promise<string> {
    if (!this.#oauth[provider]) {
      return Promise.reject(new KnowledgeError('oauth-not-configured'));
    }
    return Promise.resolve(`/admin/ai/knowledge?source=${sourceId}&oauth=connected`);
  }

  #rows(brandId: string): KnowledgeSourceView[] {
    let rows = this.#byBrand.get(brandId);
    if (rows === undefined) {
      rows = fixture();
      this.#byBrand.set(brandId, rows);
    }
    return rows;
  }

  #change(
    brandId: string,
    sourceId: string,
    change: (row: KnowledgeSourceView) => KnowledgeSourceView,
  ): Promise<KnowledgeSourceView> {
    const rows = this.#rows(brandId);
    const index = rows.findIndex((row) => row.id === sourceId);
    const row = rows[index];
    if (row === undefined) {
      return Promise.reject(new Error('No such source'));
    }
    try {
      const next = change(row);
      rows[index] = next;
      return Promise.resolve(structuredClone(next));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
