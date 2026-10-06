import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  createFakeModel,
  type FakeModel,
  fakeEmbeddingsServer,
  fakeModelError,
  type HttpTransport,
} from '@helpdock/ai';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  aiCalls,
  aiSettings,
  attachments,
  auditLog,
  createDb,
  type Db,
  type DbHandle,
  departments,
  hcArticleVersions,
  hcCategories,
  hcSections,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  outbox,
  seedBrandStatuses,
  tags,
  ticketFieldSuggestions,
  ticketMessages,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  workflowRules,
  workflowRuns,
} from '@helpdock/db';
import { type AiClassifyPayload, aiClassifyPayloadSchema, silentLogger } from '@helpdock/jobs';
import type {
  AssistState,
  DismissSuggestionResult,
  DraftArticleResult,
  ErrorResponse,
  ProposalApproveResult,
  ProposalDetail,
  ProposalList,
  RewriteResult,
  SuggestFieldsResult,
  SuggestReplyResult,
  SummaryResult,
  TicketRedactions,
  TicketTranscripts,
  TranslateResult,
  WorkflowRun,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAiRuntime } from '../ai/db-ai-ports.js';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { evaluateEventRules } from '../rules/engine.js';
import { createRulesEngineDeps } from '../rules/engine-deps.js';
import { seedDevInstall } from '../seed/dev-seed.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { runTranscription } from '../transcription/transcribe.job.js';
import { createTranscriptionHandler } from '../transcription/transcription-events.js';
import { runTriage } from '../triage/triage.job.js';

/**
 * M7-05 agent assist, M7-07 AI triage and M7-09 transcription against a real
 * Postgres and Redis. pi-ai's faux provider answers every model call and a
 * fake Whisper server every transcription: nothing reaches the network.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
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
    'Skipping the assist integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

/** A Whisper-compatible endpoint: answers what it was told, records what it was sent. */
const fakeWhisper = (answer: { status: number; body: unknown }) => {
  const requests: { url: string; contentType: string | undefined; bytes: number }[] = [];
  const http: HttpTransport = (url, request) => {
    requests.push({
      url,
      contentType: request.headers['content-type'],
      bytes: typeof request.body === 'string' ? request.body.length : (request.body?.length ?? 0),
    });
    return Promise.resolve({ status: answer.status, body: JSON.stringify(answer.body) });
  };
  return { http, requests };
};

describe.skipIf(!hasDocker)('agent assist, triage and transcription', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let fake: FakeModel;
  let brandId: string;
  let adminToken: string;
  let agentToken: string;
  let leaderToken: string;
  let outsiderToken: string;
  let supportId: string;
  let billingId: string;
  let refundTagId: string;
  let ticketId: string;
  let messageId: string;
  let closedStatusId: string;
  const embeddings = fakeEmbeddingsServer(4);

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
      S3_BUCKET: 'helpdock-assist',
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
    method: 'GET' | 'POST',
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

  const signIn = (email: string, password: string): Promise<string> =>
    signInForTest(app, { email, password });

  const addStaff = async (
    role: 'agent' | 'team_leader',
    departmentIds: string[] | null,
  ): Promise<string> => {
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
        name: `${role} ${id.slice(-4)}`,
        status: 'active',
        passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
      });
    await withSystem(db(), brandId, (tx) =>
      tx.insert(userBrandRoles).values({ userId: id, brandId, role, departmentIds }),
    );
    return signIn(email, PASSWORD);
  };

  const ticketPath = (suffix: string, id = ticketId) =>
    `/api/brands/${brandId}/tickets/${id}/${suffix}`;

  const newTicket = (subject: string, body: string) =>
    withSystem(db(), brandId, async (tx) => {
      const [open] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.systemState, 'open'));
      const id = uuidv7();
      const [{ next } = { next: 1 }] = await tx
        .select({ next: sql<number>`coalesce(max(${tickets.number}), 0) + 1` })
        .from(tickets);
      await tx.insert(tickets).values({
        id,
        brandId,
        departmentId: supportId,
        number: Number(next),
        prefix: 'HD',
        subject,
        statusId: open?.id ?? '',
        channel: 'email',
      });
      const message = uuidv7();
      await tx.insert(ticketMessages).values({
        id: message,
        brandId,
        ticketId: id,
        departmentId: supportId,
        seq: 1,
        kind: 'public',
        authorType: 'contact',
        bodyHtml: `<p>${body}</p>`,
        bodyText: body,
        channel: 'email',
      });
      return { id, message };
    });

  const seedKnowledge = (visibility: 'public' | 'internal', title: string, content: string) =>
    withSystem(db(), brandId, async (tx) => {
      const sourceId = uuidv7();
      const documentId = uuidv7();
      await tx
        .insert(knowledgeSources)
        .values({ id: sourceId, brandId, kind: 'file', name: title, visibility });
      await tx.insert(knowledgeDocuments).values({
        id: documentId,
        brandId,
        sourceId,
        externalId: `${title}.pdf`,
        title,
        contentHash: `hash-${title}`,
      });
      await tx.insert(knowledgeChunks).values({
        brandId,
        sourceId,
        documentId,
        ordinal: 0,
        locale: 'en',
        visibility,
        content,
        contentHash: `hash-chunk-${title}`,
        meta: { page: 12 },
      });
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
    fake = createFakeModel();
    app = await createApiApp({
      runtime,
      ai: { http: embeddings.http },
      assist: { http: embeddings.http, transport: fake.transport },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });

    const seeded = await seedDevInstall({ db: db(), env: envFor() });
    brandId = seeded.brandId;
    await runtime.settings.set(
      'ai.providers',
      [
        {
          id: 'local',
          kind: 'openai-compatible',
          label: 'Local',
          baseUrl: 'http://llm.test/v1',
          auth: { type: 'none' },
        },
      ],
      { updatedBy: 'test' },
    );
    await runtime.settings.set('ai.defaultProvider', 'local', { updatedBy: 'test' });
    await runtime.settings.set('ai.defaultModel', 'fake-model', { updatedBy: 'test' });

    await withSystem(db(), brandId, async (tx) => {
      await seedBrandStatuses(tx, brandId);
      const rows = await tx
        .insert(departments)
        .values([
          { brandId, name: 'Support' },
          { brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id });
      supportId = rows[0]?.id ?? '';
      billingId = rows[1]?.id ?? '';
      const [tag] = await tx
        .insert(tags)
        .values({ brandId, name: 'refund' })
        .returning({ id: tags.id });
      refundTagId = tag?.id ?? '';
      const [closed] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.systemState, 'closed'));
      closedStatusId = closed?.id ?? '';
      await tx
        .insert(aiSettings)
        .values({ brandId, modes: { agentAssist: true, keepAssistAfterHardStop: true } });
    });

    ({ id: ticketId, message: messageId } = await newTicket(
      'Refund for order 7720',
      'Where is my refund? Card 4111 1111 1111 1111, email mona@example.com.',
    ));
    await seedKnowledge(
      'public',
      'Refund timelines',
      'A refund reaches the card within five days.',
    );
    await seedKnowledge(
      'internal',
      'Ops handbook',
      'Refunds over 500 need a Team Leader sign-off.',
    );

    adminToken = await signIn(seeded.email, seeded.password);
    agentToken = await addStaff('agent', [supportId]);
    leaderToken = await addStaff('team_leader', null);
    outsiderToken = await addStaff('agent', [billingId]);
  }, 400_000);

  afterAll(async () => {
    fake?.unregister();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  const lastCall = async () => {
    const [row] = await withSystem(db(), brandId, (tx) =>
      tx.select().from(aiCalls).orderBy(sql`${aiCalls.createdAt} desc`).limit(1),
    );
    return row;
  };

  describe('assist (M7-05)', () => {
    it('opens on the state the menu reads', async () => {
      const state = await call<AssistState>('GET', ticketPath('assist'), agentToken);

      expect(state.status).toBe(200);
      expect(state.body).toMatchObject({
        enabled: true,
        blocked: null,
        piiRedaction: true,
        ticketClosed: false,
        proposal: null,
        suggestions: null,
      });
    });

    it('suggests a reply grounded in staff knowledge, marks the internal source and logs the call redacted', async () => {
      fake.reply('Your refund reaches the card within five days [1], once signed off [2]. [7]');

      const result = await call<SuggestReplyResult>(
        'POST',
        ticketPath('assist/suggest-reply'),
        agentToken,
      );

      expect(result.status).toBe(200);
      expect(result.body.droppedCitations).toBe(1);
      expect(result.body.text).not.toContain('[7]');
      expect(result.body.citations.map((citation) => citation.visibility).sort()).toEqual([
        'internal',
        'public',
      ]);
      expect(result.body.citations.find((c) => c.visibility === 'internal')?.page).toBe(12);
      expect(result.body.meta.redactionKinds.sort()).toEqual(['card', 'email']);
      const sent = JSON.stringify(fake.sent.at(-1)?.context);
      expect(sent).not.toContain('mona@example.com');
      expect(sent).toContain('[EMAIL_1]');
      expect((await lastCall())?.feature).toBe('assist.suggest_reply');
    });

    it('summarises in the reader’s language', async () => {
      fake.reply(
        '```json\n{"points": ["Mona asks about her refund.", "Nobody has replied."]}\n```',
      );

      const result = await call<SummaryResult>('POST', ticketPath('assist/summarize'), agentToken, {
        locale: 'en',
      });

      expect(result.body.points).toEqual(['Mona asks about her refund.', 'Nobody has replied.']);
      expect(result.body.messageCount).toBe(1);
    });

    it('suggests only existing tags and departments, stores them, and dismisses one', async () => {
      fake.reply(
        JSON.stringify({
          tagIds: [refundTagId, uuidv7()],
          priority: 'high',
          departmentId: billingId,
        }),
      );

      const result = await call<SuggestFieldsResult>(
        'POST',
        ticketPath('assist/suggest-fields'),
        agentToken,
      );

      expect(result.body.suggestions).toMatchObject({
        tagIds: [refundTagId],
        priority: 'high',
        departmentId: billingId,
        source: 'assist',
      });
      const dismissed = await call<DismissSuggestionResult>(
        'POST',
        ticketPath('assist/suggestions/dismiss'),
        agentToken,
        { field: 'priority' },
      );
      expect(dismissed.body.suggestions?.priority).toBeNull();
      const state = await call<AssistState>('GET', ticketPath('assist'), agentToken);
      expect(state.body.suggestions?.tagIds).toEqual([refundTagId]);
    });

    it('translates a message and rewrites a draft', async () => {
      fake.reply('أين استردادي؟');
      const translated = await call<TranslateResult>(
        'POST',
        ticketPath('assist/translate'),
        agentToken,
        { messageId, target: 'ar' },
      );
      expect(translated.body).toMatchObject({ text: 'أين استردادي؟', target: 'ar' });

      fake.reply('Dear Mona, your refund was issued on 4 October.');
      const rewritten = await call<RewriteResult>(
        'POST',
        ticketPath('assist/rewrite'),
        agentToken,
        { text: 'refund went out on the 4th', tone: 'formal' },
      );
      expect(rewritten.body.tone).toBe('formal');
      expect((await lastCall())?.feature).toBe('assist.rewrite');
    });

    it('shows an agent what the model received, placeholders numbered per message', async () => {
      const redactions = await call<TicketRedactions>(
        'GET',
        ticketPath('ai/redactions'),
        agentToken,
      );

      expect(redactions.body.items).toEqual([
        {
          messageId,
          redactedText: 'Where is my refund? Card [CARD_1], email [EMAIL_1].',
          count: 2,
          kinds: ['card', 'email'],
        },
      ]);
    });

    it('is invisible to an agent of another department', async () => {
      const response = await call<ErrorResponse>(
        'POST',
        ticketPath('assist/suggest-reply'),
        outsiderToken,
      );

      expect(response.status).toBe(404);
    });

    it('refuses while the brand has assist off, and at the hard stop unless it keeps assist on', async () => {
      const setModes = (modes: Record<string, unknown>, monthlyBudgetUsd: number | null = null) =>
        withSystem(db(), brandId, (tx) =>
          tx
            .update(aiSettings)
            .set({ modes, monthlyBudgetUsd })
            .where(eq(aiSettings.brandId, brandId)),
        );
      await setModes({ agentAssist: false });
      const off = await call<ErrorResponse>('POST', ticketPath('assist/suggest-reply'), agentToken);
      expect(off.body.error.assist?.reason).toBe('assist-off');

      // Every call so far cost 0 under the faux model; a budget of a cent
      // is spent once one priced call is logged.
      await withSystem(db(), brandId, (tx) =>
        tx.insert(aiCalls).values({
          brandId,
          feature: 'assist.rewrite',
          provider: 'local',
          model: 'fake-model',
          status: 'ok',
          costUsd: 1,
        }),
      );
      await setModes({ agentAssist: true, keepAssistAfterHardStop: false }, 0.01);
      const stopped = await call<ErrorResponse>('POST', ticketPath('assist/rewrite'), agentToken, {
        text: 'hello',
        tone: 'shorter',
      });
      expect(stopped.body.error.assist?.reason).toBe('budget-exceeded');
      const state = await call<AssistState>('GET', ticketPath('assist'), agentToken);
      expect(state.body.blocked).toBe('budget-exceeded');

      await setModes({ agentAssist: true, keepAssistAfterHardStop: true }, 0.01);
      fake.reply('Hello.');
      const kept = await call<RewriteResult>('POST', ticketPath('assist/rewrite'), agentToken, {
        text: 'hello',
        tone: 'shorter',
      });
      expect(kept.status).toBe(200);
      await setModes({ agentAssist: true, keepAssistAfterHardStop: true });
    });

    it('refuses a model failure with a reason and logs it', async () => {
      fake.reply(fakeModelError('upstream overloaded'));

      const response = await call<ErrorResponse>('POST', ticketPath('assist/rewrite'), agentToken, {
        text: 'hello',
        tone: 'shorter',
      });

      expect(response.status).toBe(502);
      expect(response.body.error.assist?.reason).toBe('provider-failed');
      expect((await lastCall())?.status).toBe('error');
    });
  });

  describe('draft article and proposals (M7-05)', () => {
    let proposalId: string;
    let sectionId: string;

    it('waits for the ticket to close', async () => {
      const response = await call<ErrorResponse>(
        'POST',
        ticketPath('assist/draft-article'),
        agentToken,
        { locale: 'en' },
      );

      expect(response.body.error.assist?.reason).toBe('ticket-not-closed');
    });

    it('drafts from a closed ticket and sends it for approval, once', async () => {
      await withSystem(db(), brandId, async (tx) => {
        await tx
          .update(tickets)
          .set({ statusId: closedStatusId, closedAt: new Date() })
          .where(eq(tickets.id, ticketId));
        const [category] = await tx
          .insert(hcCategories)
          .values({ brandId, slug: 'shipping', names: { en: 'Shipping' }, position: 1 })
          .returning({ id: hcCategories.id });
        const [section] = await tx
          .insert(hcSections)
          .values({
            brandId,
            categoryId: category?.id ?? '',
            slug: 'refunds',
            names: { en: 'Refunds' },
            position: 1,
          })
          .returning({ id: hcSections.id });
        sectionId = section?.id ?? '';
      });
      fake.reply(
        JSON.stringify({
          title: 'How long refunds take',
          body: 'A refund reaches the card within five days [1].\n\n## Who to ask\n\n- Write to us',
        }),
      );

      const draft = await call<DraftArticleResult>(
        'POST',
        ticketPath('assist/draft-article'),
        agentToken,
        { locale: 'en' },
      );
      expect(draft.status).toBe(200);
      expect(draft.body.citations.every((citation) => citation.visibility === 'public')).toBe(true);

      const proposal = await call<ProposalDetail>(
        'POST',
        ticketPath('assist/proposals'),
        agentToken,
        {
          sectionId,
          locale: 'en',
          title: draft.body.title,
          bodyMarkdown: draft.body.bodyMarkdown,
          note: 'Third refund question this week.',
          callId: draft.body.meta.callId,
          messageCount: draft.body.messageCount,
          citations: [{ title: 'Refund timelines', articleId: null }],
        },
      );
      expect(proposal.status).toBe(201);
      expect(proposal.body.bodyHtml).toContain('<h2>Who to ask</h2>');
      expect(proposal.body.call?.model).toBe('fake-model');
      proposalId = proposal.body.id;

      const again = await call<ErrorResponse>('POST', ticketPath('assist/proposals'), agentToken, {
        sectionId,
        locale: 'en',
        title: 'Again',
        bodyMarkdown: 'Again',
        note: null,
        callId: null,
        messageCount: 1,
        citations: [],
      });
      expect(again.body.error.assist?.reason).toBe('proposal-exists');
    });

    it('lists waiting proposals for a Team Leader, never for an agent', async () => {
      const list = await call<ProposalList>(
        'GET',
        `/api/brands/${brandId}/help-center/proposals`,
        leaderToken,
      );
      expect(list.body.waiting).toBe(1);
      expect(list.body.items[0]).toMatchObject({ id: proposalId, status: 'waiting' });

      const refused = await call<ErrorResponse>(
        'GET',
        `/api/brands/${brandId}/help-center/proposals`,
        agentToken,
      );
      expect(refused.status).toBe(403);
    });

    it('approves into a draft article, audited, and refuses a second decision', async () => {
      const approved = await call<ProposalApproveResult>(
        'POST',
        `/api/brands/${brandId}/help-center/proposals/${proposalId}/approve`,
        leaderToken,
        { sectionId, locale: 'en', visibility: 'internal' },
      );
      expect(approved.status).toBe(200);

      const [version] = await withSystem(db(), brandId, (tx) =>
        tx
          .select()
          .from(hcArticleVersions)
          .where(eq(hcArticleVersions.articleId, approved.body.articleId)),
      );
      expect(version).toMatchObject({ title: 'How long refunds take', visibility: 'internal' });
      expect(version?.status).toBe('draft');

      const rejected = await call<ErrorResponse>(
        'POST',
        `/api/brands/${brandId}/help-center/proposals/${proposalId}/reject`,
        adminToken,
        { reason: 'late' },
      );
      expect(rejected.body.error.assist?.reason).toBe('proposal-decided');

      const audit = await withSystem(db(), brandId, (tx) =>
        tx
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.targetId, proposalId)),
      );
      expect(audit.map((row) => row.action).sort()).toEqual([
        'help_center.proposal.approved',
        'help_center.proposal.created',
      ]);
    });

    it('rejects with a reason', async () => {
      const second = await newTicket('Cancel after payment', 'Can I cancel after paying?');
      await withSystem(db(), brandId, (tx) =>
        tx
          .update(tickets)
          .set({ statusId: closedStatusId, closedAt: new Date() })
          .where(eq(tickets.id, second.id)),
      );
      const created = await call<ProposalDetail>(
        'POST',
        ticketPath('assist/proposals', second.id),
        agentToken,
        {
          sectionId: null,
          locale: 'en',
          title: 'Cancelling',
          bodyMarkdown: 'You can cancel within a day.',
          note: null,
          callId: null,
          messageCount: 1,
          citations: [],
        },
      );

      const rejected = await call<ProposalDetail>(
        'POST',
        `/api/brands/${brandId}/help-center/proposals/${created.body.id}/reject`,
        leaderToken,
        { reason: 'Already covered by "Cancel an order".' },
      );

      expect(rejected.body).toMatchObject({
        status: 'rejected',
        rejectReason: 'Already covered by "Cancel an order".',
      });
    });
  });

  describe('AI triage (M7-07)', () => {
    const triageTicket = async (mode: 'suggest' | 'apply') => {
      const created = await newTicket('Charged twice', 'I was charged twice for my plan.');
      const ruleId = uuidv7();
      await withSystem(db(), brandId, (tx) =>
        tx.insert(workflowRules).values({
          id: ruleId,
          brandId,
          name: `Triage ${mode}`,
          kind: 'event',
          trigger: 'ticket_created',
          conditions: { match: 'all', groups: [] },
          actions: [{ type: 'ai_triage', mode, fields: ['tags', 'priority', 'department'] }],
          position: mode === 'suggest' ? 1 : 2,
          enabled: mode === 'apply',
        } as never),
      );
      const deps = createRulesEngineDeps({ log: silentLogger });
      await withSystem(db(), brandId, (tx) =>
        evaluateEventRules(deps, tx, {
          brandId,
          ticketId: created.id,
          triggers: ['ticket_created'],
          chain: [],
        }),
      );
      return { ...created, ruleId, deps };
    };

    const payloadOf = async (ticket: string): Promise<AiClassifyPayload> => {
      const [row] = await withSystem(db(), brandId, (tx) =>
        tx
          .select({ payload: outbox.payload })
          .from(outbox)
          .where(
            and(
              eq(outbox.event, 'ai.triage_requested'),
              sql`${outbox.payload}->>'ticketId' = ${ticket}`,
            ),
          ),
      );
      return aiClassifyPayloadSchema.parse({ ...(row?.payload as object), brandId });
    };

    it('queues through the outbox, applies as the rule, and writes the outcome into the run log', async () => {
      await withSystem(db(), brandId, (tx) =>
        tx.update(workflowRules).set({ enabled: false }).where(sql`true`),
      );
      const ticket = await triageTicket('apply');
      const payload = await payloadOf(ticket.id);
      fake.reply(
        JSON.stringify({ tagIds: [refundTagId], priority: 'urgent', departmentId: billingId }),
      );
      const deps = {
        db: db(),
        ai: createAiRuntime({
          db: db(),
          settings: runtime.settings,
          http: embeddings.http,
          transport: fake.transport,
        }),
        rules: ticket.deps,
        log: silentLogger,
      };

      const outcome = await runTriage(deps, payload, 'job-1');
      const again = await runTriage(deps, payload, 'job-1-retry');

      expect(outcome).toMatchObject({
        status: 'applied',
        priority: 'urgent',
        tagIds: [refundTagId],
        departmentId: billingId,
      });
      expect(again).toBeNull();
      const [row] = await withSystem(db(), brandId, (tx) =>
        tx.select().from(tickets).where(eq(tickets.id, ticket.id)),
      );
      expect(row).toMatchObject({ priority: 'urgent', departmentId: billingId });
      const runs = await call<{ runs: WorkflowRun[] }>(
        'GET',
        `/api/brands/${brandId}/rules/runs?ruleId=${ticket.ruleId}`,
        adminToken,
      );
      expect(runs.body.runs[0]?.actions[0]?.triage?.status).toBe('applied');
      expect((await lastCall())?.feature).toBe('triage.classify');
    });

    it('in suggest mode fills the Suggested fields card and changes nothing', async () => {
      await withSystem(db(), brandId, (tx) =>
        tx.update(workflowRules).set({ enabled: sql`name = 'Triage suggest'` }).where(sql`true`),
      );
      const ticket = await triageTicket('suggest');
      await withSystem(db(), brandId, (tx) =>
        tx.update(workflowRules).set({ enabled: true }).where(eq(workflowRules.id, ticket.ruleId)),
      );
      await withSystem(db(), brandId, (tx) =>
        evaluateEventRules(ticket.deps, tx, {
          brandId,
          ticketId: ticket.id,
          triggers: ['ticket_created'],
          chain: [],
        }),
      );
      const payload = await payloadOf(ticket.id);
      fake.reply(JSON.stringify({ tagIds: [], priority: 'high', departmentId: null }));

      const outcome = await runTriage(
        {
          db: db(),
          ai: createAiRuntime({
            db: db(),
            settings: runtime.settings,
            http: embeddings.http,
            transport: fake.transport,
          }),
          rules: ticket.deps,
          log: silentLogger,
        },
        payload,
        'job-2',
      );

      expect(outcome).toMatchObject({ status: 'suggested', priority: 'high' });
      const [suggestion] = await withSystem(db(), brandId, (tx) =>
        tx
          .select()
          .from(ticketFieldSuggestions)
          .where(eq(ticketFieldSuggestions.ticketId, ticket.id)),
      );
      expect(suggestion?.source).toBe(`rule:${ticket.ruleId}`);
      const [row] = await withSystem(db(), brandId, (tx) =>
        tx.select({ priority: tickets.priority }).from(tickets).where(eq(tickets.id, ticket.id)),
      );
      expect(row?.priority).not.toBe('high');
      const [run] = await withSystem(db(), brandId, (tx) =>
        tx.select().from(workflowRuns).where(eq(workflowRuns.id, payload.runId)),
      );
      expect(JSON.stringify(run?.details)).toContain('"suggested"');
    });
  });

  describe('voice transcription (M7-09)', () => {
    const config = {
      endpoint: 'https://whisper.test/v1/audio/transcriptions',
      model: 'whisper-1',
      apiKey: 'sk-whisper',
    };
    const addVoiceNote = () =>
      withSystem(db(), brandId, async (tx) => {
        const id = uuidv7();
        await tx.insert(attachments).values({
          id,
          brandId,
          ticketId,
          departmentId: supportId,
          uploaderType: 'contact',
          uploaderId: 'contact',
          s3Key: `brands/${brandId}/tickets/${ticketId}/attachments/${id}/original`,
          originalName: 'voice.webm',
          mime: 'audio/webm',
          size: 2_000,
          kind: 'audio',
          status: 'ready',
          variants: { opus: { mime: 'audio/ogg', size: 1_500, durationMs: 14_000 } },
        });
        return id;
      });
    const storage = {
      download: async (_key: string, file: string) => {
        await writeFile(file, Buffer.from('OggS fake audio'));
      },
    };

    it('marks a ready voice note pending and queues it once', async () => {
      const attachmentId = await addVoiceNote();
      const queued: string[] = [];
      const handler = createTranscriptionHandler(
        { add: async ({ jobId }) => void queued.push(jobId) },
        async () => config,
      );
      const event = {
        brandId,
        outboxId: uuidv7(),
        event: 'attachment.ready',
        payload: { attachmentId, ticketId, departmentId: supportId, status: 'ready' },
        log: silentLogger,
      };

      await withSystem(db(), brandId, (tx) => handler({ ...event, tx }));
      await withSystem(db(), brandId, (tx) => handler({ ...event, tx }));

      expect(queued).toEqual([`ai.transcribe:${attachmentId}`]);
    });

    it('stores the transcript and its language, shown to staff', async () => {
      const attachmentId = await addVoiceNote();
      const whisper = fakeWhisper({
        status: 200,
        body: { text: ' وهل يجب أن أدفع رسوم جمارك؟ ', language: 'arabic', duration: 14 },
      });
      const ai = createAiRuntime({
        db: db(),
        settings: runtime.settings,
        http: whisper.http,
        transport: fake.transport,
      });

      const outcome = await runTranscription(
        { db: db(), ai, storage, config: async () => config, log: silentLogger },
        { brandId, attachmentId },
        { jobId: 'job-t1', lastAttempt: false },
      );

      expect(outcome).toBe('done');
      expect(whisper.requests[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const transcripts = await call<TicketTranscripts>(
        'GET',
        ticketPath('transcripts'),
        agentToken,
      );
      expect(transcripts.body.items.find((item) => item.attachmentId === attachmentId)).toEqual({
        attachmentId,
        status: 'done',
        text: 'وهل يجب أن أدفع رسوم جمارك؟',
        locale: 'ar',
        language: 'arabic',
      });
      expect((await lastCall())?.feature).toBe('transcribe');
    });

    it('marks a note the endpoint refuses as failed, without retrying', async () => {
      const attachmentId = await addVoiceNote();
      const whisper = fakeWhisper({ status: 400, body: { error: 'unsupported format' } });

      const outcome = await runTranscription(
        {
          db: db(),
          ai: createAiRuntime({ db: db(), settings: runtime.settings, http: whisper.http }),
          storage,
          config: async () => config,
          log: silentLogger,
        },
        { brandId, attachmentId },
        { jobId: 'job-t2', lastAttempt: false },
      );

      expect(outcome).toBe('failed');
    });
  });
});
