import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fakeService, type HttpTransport, minimalPdf } from '@helpdock/ai';
import { createKeyring, decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  type DbHandle,
  knowledgeChunks,
  knowledgeSources,
  outbox,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { createOutboxDispatcher } from '@helpdock/jobs';
import type {
  ErrorResponse,
  HcArticle,
  HcCategory,
  HcSection,
  KnowledgeBrowse,
  KnowledgeFilePresignResponse,
  KnowledgeLog,
  KnowledgeOAuthStart,
  KnowledgeSourceList,
  KnowledgeSourceView,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, like, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAiRuntime } from '../ai/db-ai-ports.js';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { HelpCenterSearchService } from '../help-center/search/search.service.js';
import { semanticSource } from '../help-center/search/semantic.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { withSystemJob } from '../tenant/system-job.js';
import { FakeStorage, silentJobLogger } from '../testing/media.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { readOAuthApps } from './credentials.js';
import { embedPending } from './embed-pending.js';
import { configureEmbeddingSpace, reembedChunks } from './embedding-space.job.js';
import { type KnowledgeQueues, registerKnowledgeEventHandlers } from './knowledge-events.js';
import { knowledgeFileKey, type SourceLoaderDeps } from './load-source.js';
import {
  createQueryEmbedder,
  createRetriever,
  type Retriever,
  vectorChunksSql,
} from './retrieval/retrieve.js';
import { safeCrawlFetch } from './safe-transports.js';
import { runSourceSync } from './sync.job.js';

/**
 * M7-03 and M7-04 against a real Postgres with pgvector and a real Redis. The
 * embeddings endpoint, Notion and the crawled site are local fakes; nothing
 * reaches the network.
 *
 * 1. **A PDF** goes from upload to chunks to a retrieval that returns it.
 * 2. **The visitor audience** never retrieves an internal chunk, even when it
 *    is the best match, by vector or by full text (DOMAIN-RULES §5, the M7
 *    exit criterion), and an unpublished article leaves at the commit.
 * 3. **Removal** deletes a source's chunks in the request.
 * 4. **Notion** syncs through its API with an encrypted token; **a crawl** of
 *    a private address is refused by the safe client.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 47).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 180_000;
const DIMS = 16;
const NOTION = 'https://notion.fake';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write('Skipping the knowledge integration tests: Docker is not available.\n');
}

/**
 * An embeddings server whose vectors mean something: words hashed into
 * buckets, so the same text is distance 0 and shared words are close. Enough
 * to make "the best match" a fact a test can rely on.
 */
const bagOfWords = (text: string): number[] => {
  const vector = Array.from({ length: DIMS }, () => 0.001);
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    let hash = 0;
    for (const character of word) {
      hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 9_973;
    }
    vector[hash % DIMS] = (vector[hash % DIMS] ?? 0) + 1;
  }
  return vector;
};

const embeddingsHttp: HttpTransport = (url, request) => {
  if (url.endsWith('/models')) {
    return Promise.resolve({ status: 200, body: JSON.stringify({ data: [{ id: 'bag' }] }) });
  }
  const { input } = JSON.parse(request.body ?? '{}') as { input: string[] };
  return Promise.resolve({
    status: 200,
    body: JSON.stringify({
      data: input.map((text, index) => ({ index, embedding: bagOfWords(text) })),
      usage: { prompt_tokens: input.join(' ').length },
    }),
  });
};

const notionPage = (id: string, title: string) => ({
  object: 'page',
  id,
  url: `https://www.notion.so/${id}`,
  created_time: '2026-01-01T00:00:00.000Z',
  last_edited_time: '2026-01-01T00:00:00.000Z',
  parent: { type: 'workspace', workspace: true },
  properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: title }] } },
});

const notion = fakeService({
  'GET /v1/pages/p1': { status: 200, json: notionPage('p1', 'Escalation playbook') },
  'GET /v1/pages/p1/markdown': {
    status: 200,
    json: {
      object: 'page_markdown',
      id: 'p1',
      markdown: '# Escalation\n\nPage the on-call lead for outages.',
      truncated: false,
      unknown_block_ids: [],
    },
  },
  'POST /v1/search': {
    status: 200,
    json: {
      object: 'list',
      results: [notionPage('p1', 'Escalation playbook')],
      has_more: false,
      next_cursor: null,
    },
  },
  'POST /v1/oauth/token': {
    status: 200,
    json: { access_token: 'ntn_from_oauth', refresh_token: null, token_type: 'bearer' },
  },
});

describe.skipIf(!hasDocker)('knowledge ingest and retrieval (M7-03, M7-04)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let bucket: string;
  let storage: FakeStorage;
  let retriever: Retriever;
  let adminToken: string;
  let agentToken: string;
  let site: Server;
  const queued: { kind: string; id: string }[] = [];

  const queues: KnowledgeQueues = {
    addSync: async (_payload, jobId) => {
      queued.push({ kind: 'sync', id: jobId });
    },
    addEmbed: async (_payload, jobId) => {
      queued.push({ kind: 'embed', id: jobId });
    },
    schedule: async (sourceId, cron) => {
      queued.push({
        kind: cron === null ? 'unschedule' : `schedule ${cron.pattern}`,
        id: sourceId,
      });
    },
  };
  const dispatcher = createOutboxDispatcher();
  registerKnowledgeEventHandlers(queues, { remove: (key) => storage.remove(key) }, dispatcher);
  const dispatched = new Set<string>();

  const envFor = (): Env =>
    ({
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      DATABASE_MIGRATION_URL: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const brandId = (): string => seeded.brandId;
  const base = (suffix: string): string => `/api/brands/${brandId()}${suffix}`;
  const ai = () =>
    createAiRuntime({ db: runtime.db, settings: runtime.settings, http: embeddingsHttp });

  const call = <T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    token: string,
    payload?: unknown,
  ): Promise<{ status: number; body: T; headers: Record<string, unknown> }> =>
    app
      .inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        headers: response.headers,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const ok = async <T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<T> => {
    const response = await call<T>(method, url, adminToken, payload);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    return response.body;
  };

  const signIn = (email: string, password: string): Promise<string> =>
    signInForTest(app, { email, password });

  const loaders = (): SourceLoaderDeps => ({
    storage,
    crawlFetch: safeCrawlFetch({ allowCidrs: [] }),
    renderer: null,
    fetch: notion.fetch,
    endpoints: { notionBaseUrl: NOTION },
    keyring: createKeyring(envFor()),
    oauthApps: () => readOAuthApps(runtime.settings),
    crawlDelayMs: 1,
  });

  const runSync = (sourceId: string) =>
    runSourceSync(
      { db: runtime.db, ai: ai(), loaders: loaders(), log: silentJobLogger },
      { brandId: brandId(), sourceId, trigger: 'manual' },
      `job-${uuidv7()}`,
    );

  /** The relay's job, done by hand, for the help center and knowledge events. */
  const runSubscribers = async (): Promise<void> => {
    const rows = await owner.db
      .select()
      .from(outbox)
      .where(or(like(outbox.event, 'help_center.%'), like(outbox.event, 'knowledge.%')))
      .orderBy(outbox.id);
    for (const row of rows) {
      if (dispatched.has(row.id) || !dispatcher.events.includes(row.event)) {
        continue;
      }
      dispatched.add(row.id);
      await withSystemJob(runtime.db, row.brandId, row.id, (tx) =>
        dispatcher.dispatch({
          outboxId: row.id,
          brandId: row.brandId,
          event: row.event,
          payload: row.payload as Record<string, unknown>,
          tx,
          log: silentJobLogger,
        }),
      );
    }
  };

  const upload = async (
    fileName: string,
    bytes: Uint8Array,
    mime: 'application/pdf' | 'text/markdown',
    visibility: 'public' | 'internal' = 'internal',
  ): Promise<string> => {
    const presigned = await ok<KnowledgeFilePresignResponse>('POST', base('/knowledge/files'), {
      fileName,
      mime,
      size: bytes.length,
      visibility,
    });
    await storage.put(knowledgeFileKey(brandId(), presigned.sourceId), bytes);
    const confirmed = await ok<KnowledgeSourceView>(
      'POST',
      base(`/knowledge/sources/${presigned.sourceId}/confirm`),
    );
    expect(confirmed.status.state).toBe('queued');
    expect(await runSync(presigned.sourceId)).toBe('synced');
    return presigned.sourceId;
  };

  const retrieve = (query: string, audience: 'visitor' | 'staff', k = 6) =>
    retriever.retrieve({ brandId: brandId(), query, audience, locale: 'en', k });

  const sourceChunks = (sourceId: string) =>
    withSystem(runtime.db, brandId(), (tx) =>
      tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId)),
    );

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();
    owner = createDb({ url: envFor().DATABASE_MIGRATION_URL ?? '', max: 2 });

    bucket = await mkdtemp(path.join(tmpdir(), 'helpdock-knowledge-'));
    storage = new FakeStorage(bucket);
    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({
      runtime,
      objectStorage: storage,
      ai: { http: embeddingsHttp },
      knowledge: { fetch: notion.fetch, endpoints: { notionBaseUrl: NOTION } },
    });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    adminToken = await signIn(seeded.email, seeded.password);

    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const agentId = uuidv7();
    const agentEmail = `agent-${agentId}@helpdock.test`;
    await runtime.db.insert(users).values({
      id: agentId,
      email: agentEmail,
      name: 'Sam Agent',
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(STAFF_PASSWORD),
    });
    await withSystem(runtime.db, brandId(), (tx) =>
      tx.insert(userBrandRoles).values({ userId: agentId, brandId: brandId(), role: 'agent' }),
    );
    agentToken = await signIn(agentEmail, STAFF_PASSWORD);

    // The install's embedding model, and the space opened on it.
    await ok('PUT', '/api/install/ai/embedding', {
      provider: 'local',
      baseUrl: 'https://embeddings.example.com/v1',
      model: 'bag',
      dims: DIMS,
      pricePerMillionTokens: 0,
      apiKey: '',
    });
    await configureEmbeddingSpace({
      db: runtime.db,
      settings: runtime.settings,
      queue: { add: async () => undefined },
    });
    await reembedChunks({ db: runtime.db, ai: ai(), jobId: 'reembed-boot' });
    retriever = createRetriever({
      db: runtime.db,
      embedQuery: createQueryEmbedder(runtime.db, ai()),
    });

    site = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body><p>Private</p></body></html>');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  }, 400_000);

  afterAll(async () => {
    site?.close();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
    if (bucket !== undefined) {
      await rm(bucket, { recursive: true, force: true });
    }
  });

  describe('an uploaded PDF (M7-03)', () => {
    let pdfSource: string;

    beforeAll(async () => {
      pdfSource = await upload(
        'Billing FAQ.pdf',
        minimalPdf([['Refunds take five business days to reach your card.']]),
        'application/pdf',
      );
    });

    it('is chunked, embedded and listed with its counts', async () => {
      const list = await ok<KnowledgeSourceList>('GET', base('/knowledge/sources'));
      const source = list.sources.find((entry) => entry.id === pdfSource);

      expect(list.embedding).toEqual({ model: 'bag', status: 'ready' });
      expect(source).toMatchObject({
        kind: 'file',
        name: 'Billing FAQ.pdf',
        visibility: 'internal',
        schedule: 'automatic',
        status: { state: 'ok', reason: null, progress: null },
        documents: 1,
        config: { kind: 'file', file: { mime: 'application/pdf', uploaded: true } },
        createdBy: 'Dev Admin',
      });
      expect(source?.chunks).toBeGreaterThan(0);
      expect(source?.embedded).toBe(source?.chunks);
      const [chunk] = await sourceChunks(pdfSource);
      expect(chunk?.meta).toMatchObject({ page: 1 });
    });

    it('is what retrieval returns for a question it answers, for staff while internal', async () => {
      const staff = await retrieve('how long do refunds take', 'staff');
      const visitor = await retrieve('how long do refunds take', 'visitor');

      expect(staff.mode).toBe('hybrid');
      expect(staff.chunks[0]).toMatchObject({
        index: 1,
        sourceId: pdfSource,
        sourceKind: 'file',
        visibility: 'internal',
      });
      expect(staff.chunks[0]?.content).toContain('Refunds take five business days');
      expect(visitor.chunks.map((chunk) => chunk.sourceId)).not.toContain(pdfSource);
    });

    it('answers visitors once it is made public, re-labelled in the same request', async () => {
      const updated = await ok<KnowledgeSourceView>(
        'PATCH',
        base(`/knowledge/sources/${pdfSource}`),
        { visibility: 'public' },
      );

      expect(updated.visibility).toBe('public');
      expect((await sourceChunks(pdfSource)).every((chunk) => chunk.visibility === 'public')).toBe(
        true,
      );
      const visitor = await retrieve('refunds card', 'visitor');
      expect(visitor.chunks[0]).toMatchObject({ sourceId: pdfSource, visibility: 'public' });
    });

    it('writes a sync log the drawer reads, newest first', async () => {
      const log = await ok<KnowledgeLog>('GET', base(`/knowledge/sources/${pdfSource}/log`));

      expect(log.lines.map((line) => line.code)).toEqual([
        'sync.finished',
        'document.indexed',
        'sync.started',
      ]);
      expect(log.lines[0]).toMatchObject({ level: 'done', params: { documents: 1, removed: 0 } });
      const warnings = await ok<KnowledgeLog>(
        'GET',
        base(`/knowledge/sources/${pdfSource}/log?level=warn`),
      );
      expect(warnings.lines).toEqual([]);
    });

    it('refuses a file whose bytes are not what it was declared as', async () => {
      const presigned = await ok<KnowledgeFilePresignResponse>('POST', base('/knowledge/files'), {
        fileName: 'fake.pdf',
        mime: 'application/pdf',
        size: 20,
      });
      await storage.put(
        knowledgeFileKey(brandId(), presigned.sourceId),
        new TextEncoder().encode('just some plain text'),
      );
      await ok('POST', base(`/knowledge/sources/${presigned.sourceId}/confirm`));

      expect(await runSync(presigned.sourceId)).toBe('failed');
      const view = await ok<KnowledgeSourceView>(
        'GET',
        base(`/knowledge/sources/${presigned.sourceId}`),
      );
      expect(view.status).toMatchObject({ state: 'failed', code: null });
      expect(view.status.reason).toMatch(/not the application\/pdf/);
      expect(view.chunks).toBe(0);
    });

    it('refuses to confirm an upload that never reached the bucket', async () => {
      const presigned = await ok<KnowledgeFilePresignResponse>('POST', base('/knowledge/files'), {
        fileName: 'missing.md',
        mime: 'text/markdown',
        size: 10,
      });
      const response = await call<ErrorResponse>(
        'POST',
        base(`/knowledge/sources/${presigned.sourceId}/confirm`),
        adminToken,
      );

      expect(response.status).toBe(409);
      expect(response.body.error.knowledge?.reason).toBe('upload-missing');
    });
  });

  describe('the visitor audience (DOMAIN-RULES §5, the M7 exit criterion)', () => {
    const SECRET = 'Wholesale partners get a forty percent discount code';
    let internalSource: string;
    let publicSource: string;
    let publicArticle: HcArticle;
    let internalArticle: HcArticle;

    beforeAll(async () => {
      internalSource = await upload(
        'partners.md',
        new TextEncoder().encode(`# Partners\n\n${SECRET}.`),
        'text/markdown',
        'internal',
      );
      publicSource = await upload(
        'pricing.md',
        new TextEncoder().encode('# Pricing\n\nPartners can ask sales about a discount.'),
        'text/markdown',
        'public',
      );

      const hc = (suffix: string) => base(`/help-center${suffix}`);
      const category = await ok<HcCategory>('POST', hc('/categories'), {
        names: { en: 'Shop', ar: 'المتجر' },
      });
      const section = await ok<HcSection>('POST', hc('/sections'), {
        categoryId: category.id,
        names: { en: 'Discounts', ar: 'الخصومات' },
      });
      const publish = async (title: string, body: string): Promise<HcArticle> => {
        const article = await ok<HcArticle>('POST', hc('/articles'), {
          sectionId: section.id,
          locale: 'en',
          title,
        });
        await ok('PUT', hc(`/articles/${article.id}/versions/en`), {
          title,
          description: '',
          bodyHtml: `<h2>${title}</h2><p>${body}</p>`,
        });
        await ok('PUT', hc(`/articles/${article.id}/versions/en/status`), { status: 'published' });
        return article;
      };
      publicArticle = await publish(
        'Student discount',
        'Students get ten percent off with a card.',
      );
      internalArticle = await publish('Staff discount', 'Employees get a staff discount voucher.');
      await ok('PUT', hc(`/articles/${internalArticle.id}/versions/en/visibility`), {
        visibility: 'internal',
      });
      await runSubscribers();
      await embedPending({ db: runtime.db, ai: ai(), brandId: brandId(), jobId: 'embed-articles' });
    });

    it('syncs published articles on publish and asks for their embedding', async () => {
      const list = await ok<KnowledgeSourceList>('GET', base('/knowledge/sources'));
      const articles = list.sources.find((source) => source.kind === 'article');

      expect(articles).toMatchObject({ visibility: null, schedule: 'automatic', documents: 2 });
      expect(articles?.embedded).toBe(articles?.chunks);
      expect(queued.some((job) => job.kind === 'embed')).toBe(true);
    });

    it('never returns an internal chunk to a visitor, even the best match', async () => {
      const staff = await retrieve(SECRET, 'staff');
      const visitor = await retrieve(SECRET, 'visitor', 20);

      expect(staff.chunks[0]?.sourceId).toBe(internalSource);
      expect(visitor.chunks.map((chunk) => chunk.sourceId)).not.toContain(internalSource);
      expect(visitor.chunks.map((chunk) => chunk.sourceId)).toContain(publicSource);
      expect(visitor.chunks.every((chunk) => chunk.visibility === 'public')).toBe(true);
    });

    it('filters in the vector query itself, before ranking', async () => {
      const vector = await createQueryEmbedder(runtime.db, ai())(brandId(), SECRET);
      if (vector === null) {
        throw new Error('the embedding space is not ready');
      }
      const ranked = await withSystem(runtime.db, brandId(), (tx) =>
        tx.execute<{ id: string }>(vectorChunksSql(brandId(), 'visitor', vector)),
      );
      const internalIds = (await sourceChunks(internalSource)).map((chunk) => chunk.id);

      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked.map((row) => row.id).some((id) => internalIds.includes(id))).toBe(false);
    });

    it('keeps an internal article from visitors and shows it to staff', async () => {
      const visitor = await retrieve('staff discount voucher employees', 'visitor', 20);
      const staff = await retrieve('staff discount voucher employees', 'staff');

      expect(visitor.chunks.map((chunk) => chunk.articleId)).not.toContain(internalArticle.id);
      expect(staff.chunks[0]).toMatchObject({
        articleId: internalArticle.id,
        visibility: 'internal',
      });
    });

    it('drops an archived article from visitor answers at the commit, before any sync', async () => {
      const before = await retrieve('student discount card', 'visitor');
      expect(before.chunks.map((chunk) => chunk.articleId)).toContain(publicArticle.id);

      await ok('PUT', base(`/help-center/articles/${publicArticle.id}/versions/en/status`), {
        status: 'archived',
      });
      const after = await retrieve('student discount card', 'visitor', 20);

      expect(after.chunks.map((chunk) => chunk.articleId)).not.toContain(publicArticle.id);
      await runSubscribers();
      const list = await ok<KnowledgeSourceList>('GET', base('/knowledge/sources'));
      expect(list.sources.find((source) => source.kind === 'article')?.documents).toBe(1);
    });

    it('keeps internal articles out of semantic help center search', async () => {
      const embedQuery = createQueryEmbedder(runtime.db, ai());
      const search = new HelpCenterSearchService(runtime.db, { embedQuery });
      const vector = await embedQuery(brandId(), 'Employees get a staff discount voucher');
      if (vector === null) {
        throw new Error('the embedding space is not ready');
      }
      const scope = {
        brandId: brandId(),
        locale: 'en',
        defaultLocale: 'en',
        queryVector: vector,
      } as const;
      const [forVisitors, forStaff] = await withSystem(runtime.db, brandId(), async (tx) => [
        await semanticSource.candidates(
          tx,
          { ...scope, audience: 'public' },
          {
            words: [],
            all: '',
            any: '',
            fuzzy: '',
          },
        ),
        await semanticSource.candidates(
          tx,
          { ...scope, audience: 'internal' },
          {
            words: [],
            all: '',
            any: '',
            fuzzy: '',
          },
        ),
      ]);
      const hits = await search.search({
        brandId: brandId(),
        audience: 'public',
        locale: 'en',
        q: 'Employees get a staff discount voucher',
        limit: 10,
        offset: 0,
        source: 'help_center',
        log: false,
      });

      expect(forVisitors.map((candidate) => candidate.articleId)).not.toContain(internalArticle.id);
      expect(forStaff.map((candidate) => candidate.articleId)).toContain(internalArticle.id);
      expect(hits.hits.map((hit) => hit.articleId)).not.toContain(internalArticle.id);
    });

    it('falls back to full text while the space is not ready', async () => {
      const lexical = createRetriever({ db: runtime.db, embedQuery: async () => null });
      const result = await lexical.retrieve({
        brandId: brandId(),
        query: 'discount',
        audience: 'visitor',
        locale: 'en',
      });

      expect(result.mode).toBe('lexical');
      expect(result.chunks.map((chunk) => chunk.sourceId)).toContain(publicSource);
      expect(result.chunks.map((chunk) => chunk.sourceId)).not.toContain(internalSource);
    });

    it('cannot edit or remove the help center source', async () => {
      const list = await ok<KnowledgeSourceList>('GET', base('/knowledge/sources'));
      const articles = list.sources.find((source) => source.kind === 'article');
      const response = await call<ErrorResponse>(
        'DELETE',
        base(`/knowledge/sources/${articles?.id}`),
        adminToken,
      );

      expect(response.status).toBe(409);
      expect(response.body.error.knowledge?.reason).toBe('article-source-fixed');
    });
  });

  describe('removing a source', () => {
    it('deletes its chunks in the request and its file after', async () => {
      const sourceId = await upload(
        'old.md',
        new TextEncoder().encode('# Old\n\nAn old policy.'),
        'text/markdown',
      );
      expect((await sourceChunks(sourceId)).length).toBeGreaterThan(0);

      const removed = await call('DELETE', base(`/knowledge/sources/${sourceId}`), adminToken);

      expect(removed.status).toBe(204);
      expect(await sourceChunks(sourceId)).toEqual([]);
      expect((await call('GET', base(`/knowledge/sources/${sourceId}`), adminToken)).status).toBe(
        404,
      );
      await runSubscribers();
      expect(storage.removed).toContain(knowledgeFileKey(brandId(), sourceId));
      expect(queued).toContainEqual({ kind: 'unschedule', id: sourceId });
    });
  });

  describe('Notion and a crawl', () => {
    it('stores a Notion token encrypted, browses and syncs through the API', async () => {
      const created = await ok<KnowledgeSourceView>('POST', base('/knowledge/sources'), {
        kind: 'notion',
        name: 'Support playbook',
        token: 'secret_notion_token',
        config: { pageIds: ['p1'] },
      });

      expect(created).toMatchObject({
        visibility: 'internal',
        schedule: 'daily',
        status: { state: 'queued' },
        config: { kind: 'notion', connected: true },
      });
      expect(JSON.stringify(created)).not.toContain('secret_notion_token');
      const [stored] = await withSystem(runtime.db, brandId(), (tx) =>
        tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, created.id)),
      );
      expect(stored?.configEncrypted).not.toContain('secret_notion_token');

      const browse = await ok<KnowledgeBrowse>(
        'GET',
        base(`/knowledge/sources/${created.id}/browse?q=escalation`),
      );
      expect(browse.items).toEqual([{ id: 'p1', title: 'Escalation playbook', kind: 'page' }]);

      expect(await runSync(created.id)).toBe('synced');
      const staff = await retrieve('who do I page for outages', 'staff');
      expect(staff.chunks[0]).toMatchObject({ sourceId: created.id, title: 'Escalation playbook' });
      await runSubscribers();
      expect(queued).toContainEqual({ kind: 'schedule 0 3 * * *', id: created.id });
    });

    it('connects Notion with OAuth through a signed state', async () => {
      const created = await ok<KnowledgeSourceView>('POST', base('/knowledge/sources'), {
        kind: 'notion',
        name: 'Wiki',
        config: { pageIds: ['p1'] },
      });
      const refused = await call<ErrorResponse>(
        'POST',
        base(`/knowledge/sources/${created.id}/oauth/notion`),
        adminToken,
      );
      expect(refused.body.error.knowledge?.reason).toBe('oauth-not-configured');

      await runtime.settings.set('knowledge.notion.clientId', 'notion-client', {
        updatedBy: seeded.userId,
      });
      await runtime.settings.set('knowledge.notion.clientSecret', 'notion-secret', {
        updatedBy: seeded.userId,
      });
      const start = await ok<KnowledgeOAuthStart>(
        'POST',
        base(`/knowledge/sources/${created.id}/oauth/notion`),
      );
      const state = new URL(start.url).searchParams.get('state') ?? '';

      const tampered = await app.inject({
        method: 'GET',
        url: `/api/knowledge/oauth/callback?provider=notion&code=c&state=${state}x`,
      });
      expect(tampered.statusCode).toBe(400);

      const callback = await app.inject({
        method: 'GET',
        url: `/api/knowledge/oauth/callback?provider=notion&code=code-1&state=${encodeURIComponent(state)}`,
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe(
        `https://support.example.com/admin/ai/knowledge?source=${created.id}&oauth=connected`,
      );
      const view = await ok<KnowledgeSourceView>('GET', base(`/knowledge/sources/${created.id}`));
      expect(view).toMatchObject({ config: { connected: true }, status: { state: 'queued' } });
    });

    it('refuses rendering that the install has off', async () => {
      const response = await call<ErrorResponse>('POST', base('/knowledge/sources'), adminToken, {
        kind: 'crawl',
        config: { mode: 'seed', url: 'https://docs.example.com/', render: true },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.knowledge?.reason).toBe('rendering-disabled');
    });

    it('fails a crawl of a private address through the safe client, with the reason', async () => {
      const { port } = site.address() as AddressInfo;
      const created = await ok<KnowledgeSourceView>('POST', base('/knowledge/sources'), {
        kind: 'crawl',
        schedule: 'manual',
        config: { mode: 'seed', url: `http://127.0.0.1:${port}/`, maxPages: 5 },
      });

      expect(await runSync(created.id)).toBe('failed');
      const view = await ok<KnowledgeSourceView>('GET', base(`/knowledge/sources/${created.id}`));
      expect(view.status.state).toBe('failed');
      expect(view.status.reason).toMatch(/port|blocked|loopback|not allowed/i);
      expect(view.chunks).toBe(0);
    });
  });

  describe('who may manage knowledge', () => {
    it('refuses an agent', async () => {
      expect((await call('GET', base('/knowledge/sources'), agentToken)).status).toBe(403);
    });

    it('audits every change', async () => {
      const rows = await withSystem(runtime.db, brandId(), (tx) =>
        tx.execute<{ action: string }>(
          sql`select distinct action from audit_log where target_type = 'knowledge_source'`,
        ),
      );

      expect(rows.map((row) => row.action).sort()).toEqual(
        expect.arrayContaining([
          'knowledge_source.connected',
          'knowledge_source.created',
          'knowledge_source.removed',
          'knowledge_source.updated',
        ]),
      );
    });
  });

  it('keeps sources of one brand out of another', async () => {
    const outsider = await withSystem(runtime.db, uuidv7(), (tx) =>
      tx
        .select()
        .from(knowledgeSources)
        .where(and(eq(knowledgeSources.brandId, brandId()))),
    );

    expect(outsider).toEqual([]);
  });
});
