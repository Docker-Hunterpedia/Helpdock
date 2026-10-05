import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BudgetExceededError,
  createFakeModel,
  type FakeModel,
  fakeEmbeddingsServer,
  fakeVector,
} from '@helpdock/ai';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  activeEmbeddingSpace,
  aiBudgetAlerts,
  aiCalls,
  aiSettings,
  auditLog,
  brands,
  createDb,
  type Db,
  type DbHandle,
  departments,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  outbox,
  readEmbeddingSpace,
  seedBrandStatuses,
  settings as settingsTable,
  ticketStatuses,
  tickets,
  updateEmbeddingSpace,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import type {
  AiCallView,
  AiProvidersOverview,
  AiProviderView,
  BrandAiSettings,
  EmbeddingSettingsView,
  ErrorResponse,
  TicketAiCalls,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { configureEmbeddingSpace, reembedChunks } from '../knowledge/embedding-space.job.js';
import { createLogger } from '../logging/logger.js';
import { seedDevInstall } from '../seed/dev-seed.js';
import { handleBudgetAlert } from './budget-alert.handler.js';
import { AI_BUDGET_ALERT_EVENT } from './budget-meter.js';
import { createAiRuntime } from './db-ai-ports.js';
import { DbAiUsage } from './db-ai-usage.js';

/**
 * M7-01, M7-02 and M7-08 against a real Postgres and Redis, with pi-ai's faux
 * provider and a fake embeddings server in place of every provider: nothing
 * here reaches the network.
 *
 * 1. **Providers**: credentials go in and never come out, and are stored
 *    encrypted; the routes are install-admin only.
 * 2. **A brand's settings**: the Admin sets model, guardrails and budget; a
 *    Team Leader the system prompt; an Agent neither.
 * 3. **`complete()`** logs every call to `ai_calls` with its cost, redacts PII
 *    and shows the agent the original on the ticket's AI log; the budget
 *    alerts once at 80 % and stops the brand at 100 %.
 * 4. **The embedding space** moves from one model to another through
 *    `knowledge.configure` and `knowledge.reembed` without ever serving two.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
const PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 180_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the AI integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('the AI foundation', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  /** The owner role on the install's database, which reads `settings` past row-level security. */
  let installOwner: DbHandle;
  let adminToken: string;
  let leaderToken: string;
  let agentToken: string;
  let brandId: string;
  let otherBrandId: string;
  let ticketId: string;
  let fake: FakeModel;
  const discovery = fakeEmbeddingsServer(4, ['qwen3:8b']);

  const envFor = (): Env =>
    ({
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: postgres
        .getConnectionUri()
        .replace(/\/\/[^@]+@/, `//helpdock_app:${APP_ROLE_PASSWORD}@`)
        .replace(/\/[^/?]+(\?|$)/, '/helpdock$1'),
      DATABASE_MIGRATION_URL: postgres.getConnectionUri().replace(/\/[^/?]+(\?|$)/, '/helpdock$1'),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: 'http://bucket.test',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock-ai',
      S3_ACCESS_KEY_ID: 'unused',
      S3_SECRET_ACCESS_KEY: 'unused',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: '/nonexistent',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const db = (): Db => runtime.db;

  const call = <T>(
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    token: string,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url: path,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const signIn = async (email: string, password: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password }),
    });
    const body = response.json() as { accessToken?: string };
    if (body.accessToken === undefined) {
      throw new Error(`sign-in did not produce a session: ${response.body}`);
    }
    return body.accessToken;
  };

  const addStaff = async (role: 'agent' | 'team_leader'): Promise<string> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const id = uuidv7();
    const email = `${role}-${id}@helpdock.test`;
    await db()
      .insert(users)
      .values({
        id,
        email,
        name: role,
        status: 'active',
        passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
      });
    await withSystem(db(), brandId, (tx) =>
      tx.insert(userBrandRoles).values({ userId: id, brandId, role }),
    );
    return signIn(email, PASSWORD);
  };

  const seedTicket = (brand: string) =>
    withSystem(db(), brand, async (tx) => {
      await seedBrandStatuses(tx, brand);
      const [department] = await tx
        .insert(departments)
        .values({ brandId: brand, name: 'Support' })
        .returning({ id: departments.id });
      const [status] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.name, 'Open'));
      const id = uuidv7();
      await tx.insert(tickets).values({
        id,
        brandId: brand,
        departmentId: department?.id ?? '',
        number: 1,
        prefix: 'AI',
        subject: 'Refund',
        statusId: status?.id ?? '',
        channel: 'email',
      });
      return id;
    });

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    installOwner = createDb({ url: envFor().DATABASE_MIGRATION_URL ?? '', max: 1 });
    app = await createApiApp({ runtime, ai: { http: discovery.http } });
    await app.listen({ port: 0, host: '127.0.0.1' });

    const seeded = await seedDevInstall({ db: db(), env: envFor() });
    brandId = seeded.brandId;
    const [other] = await db()
      .insert(brands)
      .values({ name: 'Globex', prefix: 'GLOBEX' })
      .returning({ id: brands.id });
    otherBrandId = other?.id ?? '';
    ticketId = await seedTicket(brandId);

    adminToken = await signIn(seeded.email, seeded.password);
    leaderToken = await addStaff('team_leader');
    agentToken = await addStaff('agent');
    fake = createFakeModel();
  }, 400_000);

  afterAll(async () => {
    fake?.unregister();
    await app?.close();
    await runtime?.close();
    await installOwner?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // ------------------------------------------------------------- providers

  describe('install providers', () => {
    it('stores a provider with its key encrypted and never returns the key', async () => {
      const saved = await call<AiProviderView>(
        'PUT',
        '/api/install/ai/providers/openai',
        adminToken,
        {
          kind: 'openai',
          label: 'OpenAI',
          baseUrl: null,
          auth: { type: 'apiKey', apiKey: 'sk-live-secret' },
        },
      );

      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({
        id: 'openai',
        kind: 'openai',
        label: 'OpenAI',
        baseUrl: null,
        authType: 'apiKey',
        oauthExpiresAt: null,
      });
      const overview = await call<AiProvidersOverview>(
        'GET',
        '/api/install/ai/providers',
        adminToken,
      );
      expect(JSON.stringify(overview.body)).not.toContain('sk-live-secret');
      expect(overview.body.kinds.some((kind) => kind.id === 'anthropic' && kind.oauth)).toBe(true);

      const [stored] = await installOwner.db
        .select({ value: settingsTable.value })
        .from(settingsTable)
        .where(eq(settingsTable.key, 'ai.providers'));
      expect(stored?.value.startsWith('v1.')).toBe(true);
      expect(stored?.value).not.toContain('sk-live-secret');
    });

    it('keeps the stored key when an edit leaves it out, and audits without it', async () => {
      const edited = await call<AiProviderView>(
        'PUT',
        '/api/install/ai/providers/openai',
        adminToken,
        {
          kind: 'openai',
          label: 'OpenAI (billing)',
          baseUrl: null,
          auth: { type: 'apiKey' },
        },
      );

      expect(edited.status).toBe(200);
      expect((await runtime.settings.get('ai.providers'))[0]?.auth).toEqual({
        type: 'apiKey',
        apiKey: 'sk-live-secret',
      });
      const audit = await withSystem(db(), '00000000-0000-0000-0000-000000000000', (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, 'ai.provider.updated')),
      );
      expect(JSON.stringify(audit)).not.toContain('sk-live-secret');
    });

    it('accepts subscription credentials and reports when they expire', async () => {
      const expires = Date.parse('2026-12-01T00:00:00Z');
      const saved = await call<AiProviderView>(
        'PUT',
        '/api/install/ai/providers/claude-max',
        adminToken,
        {
          kind: 'anthropic',
          label: 'Claude Max',
          baseUrl: null,
          auth: { type: 'oauth', credentials: { access: 'at', refresh: 'rt', expires } },
        },
      );

      expect(saved.body).toMatchObject({
        authType: 'oauth',
        oauthExpiresAt: '2026-12-01T00:00:00.000Z',
      });
    });

    it('refuses a new provider without a credential, and OAuth for a kind without a flow', async () => {
      const missing = await call<ErrorResponse>(
        'PUT',
        '/api/install/ai/providers/groq',
        adminToken,
        {
          kind: 'groq',
          label: 'Groq',
          baseUrl: null,
          auth: { type: 'apiKey' },
        },
      );
      const oauth = await call<ErrorResponse>('PUT', '/api/install/ai/providers/groq', adminToken, {
        kind: 'groq',
        label: 'Groq',
        baseUrl: null,
        auth: { type: 'oauth', credentials: { access: 'a', refresh: 'r', expires: 1 } },
      });

      expect(missing.body.error.ai?.reason).toBe('credential-required');
      expect(oauth.body.error.ai?.reason).toBe('oauth-unsupported');
    });

    it('discovers models: from the registry for a built-in, by asking an OpenAI-compatible server', async () => {
      await call('PUT', '/api/install/ai/providers/ollama', adminToken, {
        kind: 'openai-compatible',
        label: 'Ollama',
        baseUrl: 'http://ollama:11434/v1',
        auth: { type: 'none' },
      });

      const builtIn = await call<{ models: { id: string }[] }>(
        'GET',
        '/api/install/ai/providers/openai/models',
        adminToken,
      );
      const local = await call<{ models: { id: string }[] }>(
        'GET',
        '/api/install/ai/providers/ollama/models',
        adminToken,
      );

      expect(builtIn.body.models.map((model) => model.id)).toContain('gpt-4o-mini');
      expect(local.body.models.map((model) => model.id)).toEqual(['qwen3:8b']);
    });

    it('sets the default model, refusing one the provider does not offer', async () => {
      const wrong = await call<ErrorResponse>('PUT', '/api/install/ai/default-model', adminToken, {
        providerId: 'openai',
        modelId: 'gpt-0',
      });
      const right = await call<AiProvidersOverview>(
        'PUT',
        '/api/install/ai/default-model',
        adminToken,
        {
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
        },
      );

      expect(wrong.body.error.ai?.reason).toBe('unknown-model');
      expect(right.body.defaults).toEqual({ providerId: 'openai', modelId: 'gpt-4o-mini' });
    });

    it('will not delete the default provider', async () => {
      const response = await call<ErrorResponse>(
        'DELETE',
        '/api/install/ai/providers/openai',
        adminToken,
      );

      expect(response.body.error.ai?.reason).toBe('provider-in-use');
    });

    it('is refused to anyone but the install admin', async () => {
      expect((await call('GET', '/api/install/ai/providers', leaderToken)).status).toBe(403);
      expect((await call('GET', '/api/install/ai/embedding', agentToken)).status).toBe(403);
    });
  });

  // ------------------------------------------------------- a brand's settings

  describe("a brand's AI settings", () => {
    const path = () => `/api/brands/${brandId}/ai`;
    const update = {
      providerId: 'ollama',
      modelId: 'qwen3:8b',
      piiRedaction: true,
      injectionFilter: true,
      budget: { dailyUsd: 1, monthlyUsd: null },
    };

    it('serves the defaults to a brand that never saved them', async () => {
      const response = await call<BrandAiSettings>('GET', `${path()}/settings`, leaderToken);

      expect(response.body).toMatchObject({
        providerId: null,
        modelId: null,
        systemPrompt: '',
        piiRedaction: true,
        budget: { dailyUsd: null, monthlyUsd: null },
        usage: { todayUsd: 0, windows: [] },
      });
    });

    it('lets the Admin set the model, guardrails and budget, and nobody else', async () => {
      expect((await call('PUT', `${path()}/settings`, leaderToken, update)).status).toBe(403);

      const response = await call<BrandAiSettings>('PUT', `${path()}/settings`, adminToken, update);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ providerId: 'ollama', budget: { dailyUsd: 1 } });
    });

    it('lets a Team Leader edit the system prompt, and not an Agent', async () => {
      const prompt = { systemPrompt: 'Answer in the language of the question.' };

      expect((await call('PUT', `${path()}/prompt`, agentToken, prompt)).status).toBe(403);
      const response = await call<BrandAiSettings>('PUT', `${path()}/prompt`, leaderToken, prompt);

      expect(response.body.systemPrompt).toBe(prompt.systemPrompt);
    });

    it('refuses a provider that does not exist', async () => {
      const response = await call<ErrorResponse>('PUT', `${path()}/settings`, adminToken, {
        ...update,
        providerId: 'nope',
      });

      expect(response.body.error.ai?.reason).toBe('unknown-provider');
    });
  });

  // ---------------------------------------------------------- complete()

  describe('complete()', () => {
    const ai = () =>
      createAiRuntime({
        db: db(),
        settings: runtime.settings,
        http: discovery.http,
        transport: fake.transport,
      });

    it("calls the brand's model with its prompt, logs the call and shows the agent the original PII", async () => {
      fake.reply('We will email [EMAIL_1] about it.');

      const result = await ai().complete({
        brandId,
        feature: 'assist.suggest_reply',
        ticketId,
        messages: [{ role: 'user', text: 'Please email mona@example.com about my refund' }],
      });

      expect(result.text).toBe('We will email mona@example.com about it.');
      const sent = fake.sent.at(-1);
      expect(sent?.model).toEqual({ provider: 'ollama', id: 'qwen3:8b' });
      expect(sent?.context.systemPrompt).toBe('Answer in the language of the question.');
      expect(JSON.stringify(sent?.context.messages)).not.toContain('mona@example.com');

      const log = await call<TicketAiCalls>(
        'GET',
        `/api/brands/${brandId}/tickets/${ticketId}/ai-calls`,
        agentToken,
      );
      const [logged] = log.body.items as AiCallView[];
      expect(logged).toMatchObject({
        feature: 'assist.suggest_reply',
        provider: 'ollama',
        model: 'qwen3:8b',
        status: 'ok',
        response: 'We will email [EMAIL_1] about it.',
        redactions: [{ placeholder: '[EMAIL_1]', kind: 'email', original: 'mona@example.com' }],
      });
      expect(JSON.stringify(logged?.prompt)).not.toContain('mona@example.com');
    });

    it("hides another brand's ticket log", async () => {
      const otherTicket = await seedTicket(otherBrandId);

      const response = await call(
        'GET',
        `/api/brands/${brandId}/tickets/${otherTicket}/ai-calls`,
        agentToken,
      );

      expect(response.status).toBe(404);
    });

    it('alerts once at 80 % of the daily budget, through the outbox, then stops the brand at 100 %', async () => {
      const spend = (costUsd: number) =>
        withSystem(db(), brandId, (tx) =>
          tx.insert(aiCalls).values({
            brandId,
            feature: 'test.spend',
            provider: 'ollama',
            model: 'qwen3:8b',
            status: 'ok',
            costUsd,
          }),
        );
      // The faux model's own cost is tiny; the spend is seeded, and the next
      // real call is what crosses the line and is logged with it.
      await spend(0.85);
      fake.reply('ok', 'ok');
      await ai().complete({ brandId, feature: 'test', messages: [{ role: 'user', text: 'hi' }] });
      await ai().complete({ brandId, feature: 'test', messages: [{ role: 'user', text: 'hi' }] });

      const alerts = await withSystem(db(), brandId, (tx) => tx.select().from(aiBudgetAlerts));
      expect(alerts).toEqual([expect.objectContaining({ period: 'day', level: 'warning' })]);
      const events = await withSystem(db(), brandId, (tx) =>
        tx.select().from(outbox).where(eq(outbox.event, AI_BUDGET_ALERT_EVENT)),
      );
      expect(events).toHaveLength(1);

      await withSystem(db(), brandId, (tx) =>
        handleBudgetAlert({
          outboxId: events[0]?.id ?? '',
          brandId,
          event: AI_BUDGET_ALERT_EVENT,
          payload: events[0]?.payload ?? {},
          tx,
          log: silentLogger,
        }),
      );
      const audit = await withSystem(db(), brandId, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, 'ai.budget_alert')),
      );
      expect(audit[0]?.meta).toMatchObject({ period: 'day', level: 'warning', limitUsd: 1 });

      await spend(0.2);
      await expect(
        ai().complete({ brandId, feature: 'autoreply', messages: [{ role: 'user', text: 'hi' }] }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      const [refused] = await withSystem(db(), brandId, (tx) =>
        tx
          .select()
          .from(aiCalls)
          .where(and(eq(aiCalls.brandId, brandId), eq(aiCalls.status, 'refused'))),
      );
      expect(refused).toMatchObject({ feature: 'autoreply', costUsd: 0 });
      const settings = await call<BrandAiSettings>(
        'GET',
        `/api/brands/${brandId}/ai/settings`,
        adminToken,
      );
      expect(settings.body.usage.windows).toEqual([
        expect.objectContaining({ period: 'day', level: 'exceeded' }),
      ]);

      await withSystem(db(), brandId, (tx) =>
        tx.update(aiSettings).set({ dailyBudgetUsd: null }).where(eq(aiSettings.brandId, brandId)),
      );
    });
  });

  // ------------------------------------------------------ the System page

  describe('install AI spend', () => {
    it("sums this month's calls of every brand, with no ceiling while a brand has no monthly budget", async () => {
      const spend = await new DbAiUsage(runtime.settings).installSpend(db());

      expect(spend).toMatchObject({ configured: true, budgetUsd: null, alertAtPercent: null });
      expect(spend.configured && spend.costUsd).toBeGreaterThan(1);
    });
  });

  // --------------------------------------------------- the embedding space

  describe('the embedding space', () => {
    const embeddings = fakeEmbeddingsServer(3, ['fake-embedding']);
    const ai = () =>
      createAiRuntime({ db: db(), settings: runtime.settings, http: embeddings.http });
    const queued: string[] = [];
    const queue = { add: async (jobId: string) => void queued.push(jobId) };
    const embeddingBody = {
      provider: 'openai',
      baseUrl: 'https://embeddings.example.com/v1',
      model: 'fake-embedding',
      dims: 3,
      pricePerMillionTokens: 0.02,
      apiKey: 'sk-embed',
    };

    const seedChunks = async (brand: string, contents: readonly string[]) =>
      withSystem(db(), brand, async (tx) => {
        const [source] = await tx
          .insert(knowledgeSources)
          .values({ brandId: brand, kind: 'file', name: 'faq.md' })
          .returning();
        const [document] = await tx
          .insert(knowledgeDocuments)
          .values({
            brandId: brand,
            sourceId: source?.id ?? '',
            externalId: 'faq.md',
            contentHash: 'h',
          })
          .returning();
        await tx.insert(knowledgeChunks).values(
          contents.map((content, ordinal) => ({
            brandId: brand,
            sourceId: source?.id ?? '',
            documentId: document?.id ?? '',
            ordinal,
            locale: 'en',
            visibility: 'public' as const,
            content,
            contentHash: `h${ordinal}`,
          })),
        );
      });

    const modelsIn = (brand: string) =>
      withSystem(db(), brand, (tx) =>
        tx.execute<{ model: string | null; embedding: string | null }>(
          sql`SELECT embedding_model AS model, embedding::text AS embedding FROM knowledge_chunks ORDER BY ordinal`,
        ),
      );

    it('refuses a model above 2000 dimensions with the reason', async () => {
      const response = await call<ErrorResponse>('PUT', '/api/install/ai/embedding', adminToken, {
        ...embeddingBody,
        dims: 3072,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.fields?.[0]?.message).toMatch(/at most 2000 dimensions/);
    });

    it('configures the first model, embeds every brand, and only then serves vectors', async () => {
      await seedChunks(brandId, ['Refunds take five days.', 'Shipping is free.']);
      await seedChunks(otherBrandId, ['Globex ships worldwide.']);

      const saved = await call<EmbeddingSettingsView>(
        'PUT',
        '/api/install/ai/embedding',
        adminToken,
        embeddingBody,
      );
      expect(saved.body).toMatchObject({ model: 'fake-embedding', dims: 3, hasApiKey: true });
      expect(JSON.stringify(saved.body)).not.toContain('sk-embed');

      await expect(
        configureEmbeddingSpace({ db: db(), settings: runtime.settings, queue }),
      ).resolves.toBe('started');
      expect(queued).toEqual(['knowledge.reembed']);
      await expect(activeEmbeddingSpace(db())).resolves.toBeNull();

      const result = await reembedChunks({ db: db(), ai: ai(), jobId: 'reembed-1' });

      expect(result).toEqual({ embedded: 3, ready: true });
      await expect(activeEmbeddingSpace(db())).resolves.toEqual({
        model: 'fake-embedding',
        dims: 3,
      });
      const [first] = await modelsIn(brandId);
      expect(first?.model).toBe('fake-embedding');
      expect(first?.embedding).toBe(`[${fakeVector('Refunds take five days.', 3).join(',')}]`);
      const view = await call<EmbeddingSettingsView>(
        'GET',
        '/api/install/ai/embedding',
        adminToken,
      );
      expect(view.body.space).toMatchObject({
        status: 'ready',
        progress: { embedded: 3, total: 3 },
      });
      await expect(
        configureEmbeddingSpace({ db: db(), settings: runtime.settings, queue }),
      ).resolves.toBe('settled');
    });

    it('logs every embedding request to the brand that made it', async () => {
      const rows = await withSystem(db(), otherBrandId, (tx) =>
        tx.select().from(aiCalls).where(eq(aiCalls.feature, 'knowledge.reembed')),
      );

      expect(rows).toEqual([
        expect.objectContaining({ brandId: otherBrandId, model: 'fake-embedding', prompt: null }),
      ]);
    });

    it('asks for confirmation before a model change re-embeds everything', async () => {
      const response = await call<ErrorResponse>('PUT', '/api/install/ai/embedding', adminToken, {
        ...embeddingBody,
        model: 'other-embedding',
        dims: 4,
      });

      expect(response.body.error.ai?.reason).toBe('reembed-not-confirmed');
    });

    it('re-embeds into a new model and dimension without ever serving the old one beside it', async () => {
      const wider = fakeEmbeddingsServer(4, ['other-embedding']);
      await call('PUT', '/api/install/ai/embedding', adminToken, {
        ...embeddingBody,
        model: 'other-embedding',
        dims: 4,
        confirmReembed: true,
      });

      await configureEmbeddingSpace({ db: db(), settings: runtime.settings, queue });

      expect((await readEmbeddingSpace(db())).status).toBe('reindexing');
      await expect(activeEmbeddingSpace(db())).resolves.toBeNull();
      const [cleared] = await modelsIn(brandId);
      expect(cleared?.embedding).toBeNull();

      wider.failWith(503);
      const failing = createAiRuntime({ db: db(), settings: runtime.settings, http: wider.http });
      await expect(reembedChunks({ db: db(), ai: failing, jobId: 'reembed-2' })).rejects.toThrow();
      const failed = await readEmbeddingSpace(db());
      expect(failed).toMatchObject({ status: 'reindexing', activeModel: 'fake-embedding' });
      expect(failed.lastError).toMatch(/503/);
      await expect(activeEmbeddingSpace(db())).resolves.toBeNull();

      wider.failWith(null);
      await expect(
        configureEmbeddingSpace({ db: db(), settings: runtime.settings, queue }),
      ).resolves.toBe('resumed');
      const healthy = createAiRuntime({ db: db(), settings: runtime.settings, http: wider.http });
      await expect(reembedChunks({ db: db(), ai: healthy, jobId: 'reembed-3' })).resolves.toEqual({
        embedded: 3,
        ready: true,
      });
      await expect(activeEmbeddingSpace(db())).resolves.toEqual({
        model: 'other-embedding',
        dims: 4,
      });
      expect((await modelsIn(otherBrandId)).every((row) => row.model === 'other-embedding')).toBe(
        true,
      );
    });

    it('stops without opening the space when the target changes under it', async () => {
      await updateEmbeddingSpace(db(), { status: 'reindexing', targetModel: 'third' });
      const switching = {
        embed: async (request: { texts: readonly string[] }) => {
          await updateEmbeddingSpace(db(), { targetModel: 'fourth' });
          return { vectors: request.texts.map(() => [0, 0, 1, 0]), model: 'third', dims: 4 };
        },
      };

      await expect(reembedChunks({ db: db(), ai: switching, jobId: 'reembed-4' })).resolves.toEqual(
        {
          embedded: 3,
          ready: false,
        },
      );
      expect((await readEmbeddingSpace(db())).status).toBe('reindexing');
    });
  });
});
