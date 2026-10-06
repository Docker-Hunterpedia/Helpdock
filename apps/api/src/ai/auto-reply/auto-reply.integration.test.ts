import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createFakeModel, type FakeModel, type HttpTransport, minimalPdf } from '@helpdock/ai';
import { createKeyring, type Env } from '@helpdock/config';
import {
  aiCalls,
  aiSettings,
  auditLog,
  createDb,
  type DbHandle,
  outbox,
  tickets,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { type AiAutoReplyPayload, createOutboxDispatcher } from '@helpdock/jobs';
import type {
  BrandAiSettings,
  KnowledgeFilePresignResponse,
  TicketAiState,
  TicketDetail,
  WidgetConversation,
  WidgetMessage,
  WidgetMessagePage,
  WidgetSendResponse,
  WidgetSession,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { SettingsInstallSmtp } from '../../email/transport.js';
import { readOAuthApps } from '../../knowledge/credentials.js';
import { configureEmbeddingSpace, reembedChunks } from '../../knowledge/embedding-space.job.js';
import { knowledgeFileKey } from '../../knowledge/load-source.js';
import type { Retriever } from '../../knowledge/retrieval/retrieve.js';
import { safeCrawlFetch } from '../../knowledge/safe-transports.js';
import { runSourceSync } from '../../knowledge/sync.job.js';
import { createLogger } from '../../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { FakeStorage, silentJobLogger } from '../../testing/media.js';
import { signInForTest } from '../../testing/staff-sign-in.js';
import { createAiRuntime } from '../db-ai-ports.js';
import { DbAiUsage } from '../db-ai-usage.js';
import { type AutoReplyDeps, runAutoReply } from './auto-reply.job.js';
import { createAutoReplyDeps } from './auto-reply-deps.js';
import { registerAutoReplyEventHandlers } from './auto-reply-events.js';
import { DEFAULT_HANDOFF_MESSAGES, readAutoReplySettings } from './auto-reply-settings.js';

/**
 * M7-06 end to end against a real Postgres with pgvector and a real Redis,
 * with pi-ai's faux provider as the model and a word-hashing embeddings fake:
 *
 * 1. A visitor's question is answered from an uploaded public PDF, with the
 *    citation, through the widget's REST (the M7 exit criterion).
 * 2. Below the threshold the assistant hands off with the brand's wording,
 *    the conversation is paused, and the next message adds no job.
 * 3. After a handoff no answer is sent, even by a job that was queued before
 *    it — and one already past the model when a person replies (exit criterion).
 * 4. "Return to assistant" is audited and lets the assistant answer again.
 * 5. A spent budget stops auto-reply without a word to the visitor, and the
 *    admin's settings say the window is exceeded (exit criterion).
 * 6. "Was this helpful?" and the deflection figures of Reports.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 53).toString('base64');
const CONTAINER_STARTUP_MS = 180_000;
const DIMS = 16;
const SHOP = 'https://shop.example.com';
const QUESTION = 'How long does a card refund take?';
const PDF_LINE = 'Card refunds show up 3 to 5 business days after we issue them.';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write('Skipping the auto-reply integration tests: Docker is not available.\n');
}

/** Words hashed into buckets: shared words are close, the same text is distance 0. */
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

interface Visitor {
  readonly secret: string;
}

describe.skipIf(!hasDocker)('auto-reply (M7-06)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let bucket: string;
  let storage: FakeStorage;
  let adminToken: string;
  let fake: FakeModel;
  let deps: AutoReplyDeps;
  const queued: AiAutoReplyPayload[] = [];
  const dispatched = new Set<string>();
  const dispatcher = createOutboxDispatcher();

  registerAutoReplyEventHandlers(
    { add: async (payload) => void queued.push(payload) },
    readAutoReplySettings,
    dispatcher,
  );

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
  const ai = () =>
    createAiRuntime({
      db: runtime.db,
      settings: runtime.settings,
      http: embeddingsHttp,
      transport: fake.transport,
    });

  const staff = async <T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const response = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return {
      status: response.statusCode,
      body: (response.body === '' ? undefined : response.json()) as T,
    };
  };

  const widget = async <T>(
    method: 'GET' | 'POST',
    url: string,
    visitor?: Visitor,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const response = await app.inject({
      method,
      url: `/api/widget/${brandId()}${url}`,
      headers: {
        origin: SHOP,
        ...(visitor === undefined ? {} : { authorization: `Visitor ${visitor.secret}` }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return {
      status: response.statusCode,
      body: (response.body === '' ? undefined : response.json()) as T,
    };
  };

  const newVisitor = async (): Promise<Visitor> => {
    const response = await widget<WidgetSession>('POST', '/session', undefined, {});
    expect(response.status).toBe(200);
    return { secret: response.body.visitorSecret ?? '' };
  };

  const start = async (visitor: Visitor, text = QUESTION): Promise<string> => {
    const response = await widget<WidgetSendResponse>('POST', '/conversations', visitor, {
      clientId: uuidv7(),
      text,
    });
    expect(response.status).toBe(201);
    return response.body.conversation.id;
  };

  const send = (visitor: Visitor, conversationId: string, text: string) =>
    widget<WidgetSendResponse>('POST', `/conversations/${conversationId}/messages`, visitor, {
      clientId: uuidv7(),
      text,
    });

  const thread = async (visitor: Visitor, conversationId: string): Promise<WidgetMessage[]> =>
    (await widget<WidgetMessagePage>('GET', `/conversations/${conversationId}/messages`, visitor))
      .body.messages;

  /** The relay and the `ai` subscriber, done by hand: what the worker does after each commit. */
  const dispatchTicketEvents = async (): Promise<void> => {
    const rows = await owner.db
      .select()
      .from(outbox)
      .where(inArray(outbox.event, ['ticket.created', 'ticket.replied']))
      .orderBy(outbox.id);
    for (const row of rows) {
      if (dispatched.has(row.id)) {
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

  /** The jobs the subscriber added since the last call, one per message. */
  const takeJobs = async (): Promise<AiAutoReplyPayload[]> => {
    await dispatchTicketEvents();
    const unique = new Map(queued.splice(0).map((job) => [job.messageId, job]));
    return [...unique.values()];
  };

  const run = (job: AiAutoReplyPayload, with_: Partial<AutoReplyDeps> = {}) =>
    runAutoReply({ ...deps, ...with_ }, job, `ai.auto_reply.${job.messageId}`);

  const ticketRow = async (ticketId: string) => {
    const [row] = await owner.db.select().from(tickets).where(eq(tickets.id, ticketId));
    return row;
  };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();
    owner = createDb({ url: envFor().DATABASE_MIGRATION_URL ?? '', max: 2 });

    bucket = await mkdtemp(path.join(tmpdir(), 'helpdock-auto-reply-'));
    storage = new FakeStorage(bucket);
    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime, objectStorage: storage, ai: { http: embeddingsHttp } });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    adminToken = await signInForTest(app, { email: seeded.email, password: seeded.password });
    fake = createFakeModel();

    // The model: an OpenAI-compatible server, answered by the faux provider.
    expect(
      (
        await staff('PUT', '/api/install/ai/providers/local', {
          kind: 'openai-compatible',
          label: 'Local',
          baseUrl: 'http://llm.example.com/v1',
          auth: { type: 'none' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await staff('PUT', '/api/install/ai/default-model', {
          providerId: 'local',
          modelId: 'fake-model',
        })
      ).status,
    ).toBe(200);
    // The embedding model, and the space opened on it.
    await staff('PUT', '/api/install/ai/embedding', {
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
    // The widget, from the shop's pages.
    expect(
      (
        await staff('PUT', `/api/brands/${brandId()}/widget/access`, {
          allowedOrigins: [SHOP],
          captchaEnabled: false,
          captchaProvider: 'turnstile',
          captchaSiteKey: '',
        })
      ).status,
    ).toBe(200);

    // A public PDF, uploaded and synced as the admin would.
    const bytes = minimalPdf([[PDF_LINE]]);
    const presigned = await staff<KnowledgeFilePresignResponse>(
      'POST',
      `/api/brands/${brandId()}/knowledge/files`,
      {
        fileName: 'Refund timelines.pdf',
        mime: 'application/pdf',
        size: bytes.length,
        visibility: 'public',
      },
    );
    await storage.put(knowledgeFileKey(brandId(), presigned.body.sourceId), bytes);
    await staff(
      'POST',
      `/api/brands/${brandId()}/knowledge/sources/${presigned.body.sourceId}/confirm`,
    );
    const synced = await runSourceSync(
      {
        db: runtime.db,
        ai: ai(),
        loaders: {
          storage,
          crawlFetch: safeCrawlFetch({ allowCidrs: [] }),
          renderer: null,
          fetch: fetch,
          keyring: createKeyring(envFor()),
          oauthApps: () => readOAuthApps(runtime.settings),
        },
        log: silentJobLogger,
      },
      { brandId: brandId(), sourceId: presigned.body.sourceId, trigger: 'manual' },
      'sync-pdf',
    );
    expect(synced).toBe('synced');

    deps = {
      ...createAutoReplyDeps({
        db: runtime.db,
        ai: ai(),
        installSmtp: new SettingsInstallSmtp(runtime.settings),
        log: silentJobLogger,
      }),
    };
  }, 400_000);

  /** The Admin's AI › Assistant modes (M7-10): auto-reply on the widget only. */
  const setModes = async (threshold: number): Promise<void> => {
    const off = { enabled: false, threshold: 0.7 };
    const saved = await staff('PUT', `/api/brands/${brandId()}/ai/modes`, {
      agentAssist: false,
      keepAssistAfterHardStop: true,
      autoReply: { widget: { enabled: true, threshold }, email: off, telegram: off },
      handoffMessage: { en: '', ar: '' },
      aiCountsAsFirstResponse: true,
    });
    expect(saved.status).toBe(200);
  };

  beforeEach(async () => {
    await setModes(0.7);
    await dispatchTicketEvents();
    queued.splice(0);
  });

  afterAll(async () => {
    fake?.unregister();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
    if (bucket !== undefined) {
      await rm(bucket, { recursive: true, force: true });
    }
  });

  it('answers a question from the uploaded PDF, citing it, in the widget and the staff thread', async () => {
    const visitor = await newVisitor();
    const conversationId = await start(visitor);
    const [job, ...more] = await takeJobs();
    expect(more).toEqual([]);

    fake.reply(
      `Card refunds show up 3 to 5 business days after we issue them [1].\nCONFIDENCE: 0.92`,
    );
    await run(job as AiAutoReplyPayload);

    const prompt = fake.sent.at(-1)?.context.systemPrompt ?? '';
    expect(prompt).toContain(PDF_LINE);
    expect(prompt).toContain('[1] ');
    const answer = (await thread(visitor, conversationId)).at(-1);
    expect(answer).toMatchObject({
      author: 'ai',
      text: 'Card refunds show up 3 to 5 business days after we issue them [1].',
      html: null,
      ai: {
        kind: 'answer',
        citations: [{ marker: 1, title: expect.stringContaining('Refund timelines') }],
        feedback: null,
      },
    });

    const detail = await staff<TicketDetail>(
      'GET',
      `/api/brands/${brandId()}/tickets/${conversationId}`,
    );
    const staffAnswer = detail.body.messages.messages.at(-1);
    expect(staffAnswer).toMatchObject({
      kind: 'ai',
      authorType: 'ai',
      ai: { kind: 'answer', confidence: 0.92, threshold: 0.7 },
    });
    expect(staffAnswer?.bodyText).toContain('Refund timelines');
    expect(detail.body.ticket.ai).toEqual({ pausedAt: null, pausedUntil: null, reason: null });
    const [logged] = await withSystem(runtime.db, brandId(), (tx) =>
      tx.select().from(aiCalls).where(eq(aiCalls.feature, 'auto_reply')),
    );
    expect(logged).toMatchObject({ status: 'ok', ticketId: conversationId });
  });

  it('records the visitor feedback on the answer', async () => {
    const visitor = await newVisitor();
    const conversationId = await start(visitor);
    const [job] = await takeJobs();
    fake.reply('Three to five business days [1].\nCONFIDENCE: 0.9');
    await run(job as AiAutoReplyPayload);
    const answer = (await thread(visitor, conversationId)).at(-1);

    const response = await widget<WidgetMessage>(
      'POST',
      `/conversations/${conversationId}/messages/${answer?.id}/feedback`,
      visitor,
      { feedback: 'helpful' },
    );

    expect(response.status).toBe(200);
    expect(response.body.ai?.feedback).toBe('helpful');
    expect((await thread(visitor, conversationId)).at(-1)?.ai?.feedback).toBe('helpful');
  });

  it('hands off below the threshold with the handoff wording, and answers nothing after', async () => {
    await setModes(0.8);
    const visitor = await newVisitor();
    const conversationId = await start(visitor);
    const [job] = await takeJobs();
    fake.reply('Possibly a few days [1].\nCONFIDENCE: 0.5');
    await run(job as AiAutoReplyPayload);

    const handoff = (await thread(visitor, conversationId)).at(-1);
    expect(handoff).toMatchObject({
      author: 'ai',
      text: DEFAULT_HANDOFF_MESSAGES.en,
      ai: { kind: 'handoff', citations: [] },
    });
    const conversation = await widget<WidgetConversation>(
      'GET',
      `/conversations/${conversationId}`,
      visitor,
    );
    expect(conversation.body.aiHandedOff).toBe(true);
    const detail = await staff<TicketDetail>(
      'GET',
      `/api/brands/${brandId()}/tickets/${conversationId}`,
    );
    expect(detail.body.ticket.ai?.reason).toBe('low_confidence');
    expect(detail.body.messages.messages.at(-1)).toMatchObject({
      kind: 'system',
      ai: { kind: 'paused', reason: 'low_confidence', confidence: 0.5, threshold: 0.8 },
    });

    await send(visitor, conversationId, 'Are you still there?');
    expect(await takeJobs()).toEqual([]);
  });

  it('sends nothing from a job queued before "Talk to a human"', async () => {
    const visitor = await newVisitor();
    const conversationId = await start(visitor);
    const [job] = await takeJobs();
    const asked = fake.sent.length;

    const handoff = await widget<WidgetConversation>(
      'POST',
      `/conversations/${conversationId}/handoff`,
      visitor,
    );
    expect(handoff.body.aiHandedOff).toBe(true);
    await run(job as AiAutoReplyPayload);

    expect(fake.sent).toHaveLength(asked);
    expect((await thread(visitor, conversationId)).map((message) => message.author)).toEqual([
      'visitor',
    ]);
  });

  it('sends nothing when a person replies while the model is still answering', async () => {
    const visitor = await newVisitor();
    const conversationId = await start(visitor);
    const [job] = await takeJobs();
    const retriever: Retriever = {
      retrieve: async (request) => {
        const reply = await staff(
          'POST',
          `/api/brands/${brandId()}/tickets/${conversationId}/messages`,
          {
            clientId: uuidv7(),
            kind: 'public',
            bodyHtml: '<p>Hi, Lina here. Let me check that for you.</p>',
          },
        );
        expect(reply.status).toBeLessThan(300);
        return deps.retriever.retrieve(request);
      },
    };
    fake.reply('Three to five business days [1].\nCONFIDENCE: 0.95');

    await run(job as AiAutoReplyPayload, { retriever });

    expect((await thread(visitor, conversationId)).map((message) => message.author)).toEqual([
      'visitor',
      'agent',
    ]);
    expect((await ticketRow(conversationId))?.aiPauseReason).toBe('staff_reply');
  });

  it('answers again after "Return to assistant", which is audited', async () => {
    const visitor = await newVisitor();
    const conversationId = await start(visitor);
    await takeJobs();
    await widget('POST', `/conversations/${conversationId}/handoff`, visitor);

    const resumed = await staff<TicketAiState>(
      'POST',
      `/api/brands/${brandId()}/tickets/${conversationId}/ai/resume`,
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body.pausedAt).toBeNull();
    const audit = await withSystem(runtime.db, brandId(), (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'ai.auto_reply.resumed'), eq(auditLog.targetId, conversationId)),
        ),
    );
    expect(audit).toHaveLength(1);

    await send(visitor, conversationId, 'And for a bank transfer?');
    const [job] = await takeJobs();
    fake.reply('Three to five business days [1].\nCONFIDENCE: 0.9');
    await run(job as AiAutoReplyPayload);
    expect((await thread(visitor, conversationId)).at(-1)?.author).toBe('ai');
  });

  it('stays silent over budget, and the admin sees the window exceeded', async () => {
    await owner.db
      .insert(aiSettings)
      .values({ brandId: brandId(), dailyBudgetUsd: 1 })
      .onConflictDoUpdate({ target: aiSettings.brandId, set: { dailyBudgetUsd: 1 } });
    await withSystem(runtime.db, brandId(), (tx) =>
      tx.insert(aiCalls).values({
        brandId: brandId(),
        feature: 'test.spend',
        provider: 'local',
        model: 'fake-model',
        status: 'ok',
        costUsd: 1.5,
      }),
    );
    const visitor = await newVisitor();
    const conversationId = await start(visitor);
    const [job] = await takeJobs();

    await run(job as AiAutoReplyPayload);

    expect((await thread(visitor, conversationId)).map((message) => message.author)).toEqual([
      'visitor',
    ]);
    const conversation = await widget<WidgetConversation>(
      'GET',
      `/conversations/${conversationId}`,
      visitor,
    );
    expect(conversation.body.aiHandedOff).toBe(false);
    const [refused] = await withSystem(runtime.db, brandId(), (tx) =>
      tx
        .select()
        .from(aiCalls)
        .where(and(eq(aiCalls.feature, 'auto_reply'), eq(aiCalls.status, 'refused'))),
    );
    expect(refused?.ticketId).toBe(conversationId);
    const settings = await staff<BrandAiSettings>('GET', `/api/brands/${brandId()}/ai/settings`);
    expect(settings.body.usage.windows).toEqual([
      expect.objectContaining({ period: 'day', level: 'exceeded' }),
    ]);

    await owner.db.update(aiSettings).set({ dailyBudgetUsd: null });
  });

  it('counts the answered, never handed-off conversations as deflected once quiet for a day', async () => {
    const usage = new DbAiUsage(runtime.settings, () => new Date(Date.now() + 25 * 3_600_000));
    const today = new Date().toISOString().slice(0, 10);
    const report = await withSystem(runtime.db, brandId(), (tx) =>
      usage.report(tx, { brandId: brandId(), from: today, to: today, timezone: 'UTC' }),
    );

    // Answered and left alone: the first two. Handed off: the low-confidence
    // one and the two the visitor took to a person. A job that never sent —
    // superseded by a person, or over budget — made nothing eligible.
    expect(report).toMatchObject({
      available: true,
      deflection: { eligible: 5, deflected: 2, rate: 0.4 },
    });
  });
});
