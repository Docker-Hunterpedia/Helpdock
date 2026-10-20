import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  aiCalls,
  apiIdempotencyKeys,
  apiKeys,
  attachments,
  auditLog,
  brands,
  contactIdentities,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  type DbTransaction,
  departments,
  jobReceipts,
  metaAccounts,
  metaConversations,
  metaDeliveries,
  notificationEmailBatches,
  notifications,
  outbox,
  retentionSettings,
  seedBrandStatuses,
  telegramBots,
  telegramChats,
  telegramDeliveries,
  ticketMessages,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  webhookDeliveries,
  webhooks,
  widgetVisitors,
  withSystem,
} from '@helpdock/db';
import { type MaintenanceRetentionPayload, silentLogger } from '@helpdock/jobs';
import type { ContactDetail, RetentionOverview } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { findOrCreateContactByIdentity } from '../contacts/identity.js';
import { createLogger } from '../logging/logger.js';
import {
  attachmentObjectKeys,
  createObjectPurgeHandler,
  OBJECT_PURGE_EVENT,
} from '../media/object-purge.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { FakeStorage } from '../testing/media.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { runBrandRetention, scheduleRetention } from './retention.job.js';

/**
 * M1-14 against a real Postgres and a real Redis. The bucket is the storage
 * port's double (`testing/media.ts`): what this suite proves about objects is
 * *which keys* a purge hands to `ObjectStorage.remove`, and that the handler
 * refuses to act before the rows are gone; that `remove` really deletes from
 * S3 is `S3ObjectStorage`'s contract, proved against MinIO in
 * `media.integration.test.ts`.
 *
 * 1. **The purge removes exactly what §11 says**, with its children and its
 *    bytes: an expired closed ticket goes with its messages, its attachments
 *    and the keys of their objects; a recent one, an open one and — under
 *    "never" — every closed one stays.
 * 2. **A brand's job never touches another brand** (DOMAIN-RULES §1.6): brand
 *    B's expired rows survive brand A's run, because the run's transactions
 *    carry brand A alone.
 * 3. **It is batched and idempotent**: a batch size of one drains everything,
 *    and a second run removes nothing.
 * 4. **The form's routes** are Admin-only and validated.
 * 5. **An erasure takes the person's files** and their channel ids, keeps the
 *    bodies, and audits counts only. It also takes what other tables copied
 *    of them: the Telegram chat, the AI redaction map and webhook payloads
 *    (ASVS 8.3.2).
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 29).toString('base64');
const AGENT_PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 180_000;
const DAY_MS = 86_400_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the retention integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

interface BrandFixture {
  readonly id: string;
  readonly departmentId: string;
  readonly openStatusId: string;
  readonly closedStatusId: string;
  readonly spamStatusId: string;
}

describe.skipIf(!hasDocker)('data retention', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let storage: FakeStorage;
  let adminToken: string;
  let agentToken: string;
  let brandA: BrandFixture;
  let brandB: BrandFixture;
  let ticketNumber = 1_000;

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
      S3_BUCKET: 'helpdock-retention',
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
    method: 'GET' | 'PUT' | 'POST',
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

  /** Statuses, and one department, for a brand that already exists. */
  const fixtureFor = async (brandId: string): Promise<BrandFixture> =>
    withSystem(db(), brandId, async (tx) => {
      await seedBrandStatuses(tx, brandId);
      const [department] = await tx
        .insert(departments)
        .values({ brandId, name: 'Support' })
        .returning({ id: departments.id });
      const statuses = await tx.select().from(ticketStatuses);
      const byName = (name: string) => statuses.find((status) => status.name === name)?.id ?? '';

      return {
        id: brandId,
        departmentId: department?.id ?? '',
        openStatusId: byName('Open'),
        closedStatusId: byName('Closed'),
        spamStatusId: byName('Spam'),
      };
    });

  interface TicketSeed {
    readonly status: 'open' | 'closed' | 'spam';
    readonly closedDaysAgo?: number;
    readonly withAttachment?: boolean;
    readonly contactId?: string;
  }

  interface SeededTicket {
    readonly id: string;
    readonly messageId: string;
    readonly keys: readonly string[];
  }

  /**
   * One ticket with one contact-written message and, when asked, one attachment.
   */
  const seedTicket = async (brand: BrandFixture, seed: TicketSeed): Promise<SeededTicket> => {
    const ticketId = uuidv7();
    const statusId = {
      open: brand.openStatusId,
      closed: brand.closedStatusId,
      spam: brand.spamStatusId,
    }[seed.status];
    ticketNumber += 1;

    const seededTicket = await withSystem(db(), brand.id, async (tx) => {
      await tx.insert(tickets).values({
        id: ticketId,
        brandId: brand.id,
        departmentId: brand.departmentId,
        number: ticketNumber,
        prefix: 'RT',
        subject: `Retention ${seed.status}`,
        statusId,
        channel: 'email',
        contactId: seed.contactId ?? null,
        closedAt: seed.closedDaysAgo === undefined ? null : daysAgo(seed.closedDaysAgo),
      });
      const [message] = await tx
        .insert(ticketMessages)
        .values({
          brandId: brand.id,
          ticketId,
          departmentId: brand.departmentId,
          seq: 1,
          kind: 'public',
          authorType: 'contact',
          authorId: seed.contactId ?? null,
          bodyHtml: '<p>My order never arrived.</p>',
          bodyText: 'My order never arrived.',
          channel: 'email',
          externalMessageId: `<${ticketId}@mail.customer.example>`,
        })
        .returning({ id: ticketMessages.id });
      const messageId = message?.id ?? '';

      if (seed.withAttachment !== true) {
        return { id: ticketId, messageId, keys: [] };
      }

      const attachmentId = uuidv7();
      const s3Key = `brands/${brand.id}/tickets/${ticketId}/${attachmentId}/original`;
      await tx.insert(attachments).values({
        id: attachmentId,
        brandId: brand.id,
        ticketId,
        departmentId: brand.departmentId,
        messageId,
        uploaderType: 'contact',
        uploaderId: seed.contactId ?? uuidv7(),
        s3Key,
        originalName: 'receipt.png',
        mime: 'image/png',
        size: 4,
        kind: 'image',
        status: 'ready',
      });
      return {
        id: ticketId,
        messageId,
        keys: attachmentObjectKeys({ id: attachmentId, brandId: brand.id, ticketId, s3Key }),
      };
    });

    return seededTicket;
  };

  const ticketIdsOf = (brandId: string) =>
    withSystem(db(), brandId, async (tx) =>
      (await tx.select({ id: tickets.id }).from(tickets)).map((row) => row.id),
    );

  const setClosedWindow = (brandId: string, days: number | null) =>
    withSystem(db(), brandId, (tx) =>
      tx
        .insert(retentionSettings)
        .values({ brandId, closedTicketDays: days })
        .onConflictDoUpdate({ target: retentionSettings.brandId, set: { closedTicketDays: days } }),
    );

  /** The outbox rows a purge wrote for the bucket, handed to the real handler. */
  const drainObjectPurges = async (brandId: string): Promise<string[]> => {
    const rows = await withSystem(db(), brandId, (tx) =>
      tx
        .select()
        .from(outbox)
        .where(and(eq(outbox.event, OBJECT_PURGE_EVENT), sql`${outbox.publishedAt} is null`)),
    );
    const handler = createObjectPurgeHandler(storage);
    const keys: string[] = [];
    for (const row of rows) {
      await withSystem(db(), brandId, (tx: DbTransaction) =>
        handler({
          outboxId: row.id,
          brandId,
          event: row.event,
          payload: row.payload,
          tx,
          log: silentLogger,
        }),
      );
      keys.push(...((row.payload as { keys: string[] }).keys ?? []));
    }
    await withSystem(db(), brandId, (tx) =>
      tx
        .update(outbox)
        .set({ publishedAt: new Date() })
        .where(
          inArray(
            outbox.id,
            rows.map((row) => row.id),
          ),
        ),
    );

    return keys;
  };

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

    storage = new FakeStorage('/nonexistent');

    app = await createApiApp({ runtime, objectStorage: storage });
    await app.listen({ port: 0, host: '127.0.0.1' });

    seeded = await seedDevInstall({ db: db(), env: envFor() });
    const [other] = await db()
      .insert(brands)
      .values({ name: 'Globex', prefix: 'GLOBEX' })
      .returning({ id: brands.id });

    brandA = await fixtureFor(seeded.brandId);
    brandB = await fixtureFor(other?.id ?? '');

    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const agentId = uuidv7();
    const agentEmail = `agent-${agentId}@helpdock.test`;
    await db()
      .insert(users)
      .values({
        id: agentId,
        email: agentEmail,
        name: 'Agent',
        status: 'active',
        passwordHash: await new PasswordHasher(masterKey).hash(AGENT_PASSWORD),
      });
    await withSystem(db(), brandA.id, (tx) =>
      tx.insert(userBrandRoles).values({ userId: agentId, brandId: brandA.id, role: 'agent' }),
    );

    adminToken = await signIn(seeded.email, seeded.password);
    agentToken = await signIn(agentEmail, AGENT_PASSWORD);
  }, 400_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    // Every case states its own windows and seeds its own tickets.
    for (const brand of [brandA, brandB]) {
      await withSystem(db(), brand.id, async (tx) => {
        await tx.delete(tickets);
        await tx.delete(widgetVisitors);
        await tx.delete(retentionSettings);
        await tx.delete(webhooks);
        await tx.delete(apiKeys);
        await tx.delete(telegramBots);
      });
    }
  });

  // ------------------------------------------------------------------ the form

  describe('the form', () => {
    const path = () => `/api/brands/${brandA.id}/retention`;
    const form = {
      closedTickets: { kind: 'days', days: 30 },
      spamTicketDays: 30,
      aiCallDays: 90,
      searchLogDays: 180,
      auditLogDays: 730,
      visitorSessionDays: 30,
    };

    it('serves the §11 defaults to a brand that never saved it', async () => {
      const response = await call<RetentionOverview>('GET', path(), adminToken);

      expect(response.status).toBe(200);
      expect(response.body.settings.closedTickets).toEqual({ kind: 'never' });
      expect(response.body.preview.closedTickets).toBeNull();
      expect(response.body.lastRun).toBeNull();
    });

    it('saves the whole form, previews what it would purge, and audits the change', async () => {
      await seedTicket(brandA, { status: 'closed', closedDaysAgo: 40 });
      await seedTicket(brandA, { status: 'closed', closedDaysAgo: 5 });

      const response = await call<RetentionOverview>('PUT', path(), adminToken, form);

      expect(response.status).toBe(200);
      expect(response.body.settings.closedTickets).toEqual({ kind: 'days', days: 30 });
      expect(response.body.preview.closedTickets).toBe(1);
      const audit = await withSystem(db(), brandA.id, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, 'retention.updated')),
      );
      expect(audit.at(-1)?.meta).toMatchObject({ after: form });
    });

    it('refuses an audit log window below the 90-day minimum', async () => {
      const response = await call('PUT', path(), adminToken, { ...form, auditLogDays: 30 });

      expect(response.status).toBe(400);
    });

    it('is refused to an Agent, reading or writing', async () => {
      expect((await call('GET', path(), agentToken)).status).toBe(403);
      expect((await call('PUT', path(), agentToken, form)).status).toBe(403);
    });
  });

  // ----------------------------------------------------------------- the purge

  describe('the nightly purge', () => {
    it('purges only inactive visitors with no conversation, within the running brand', async () => {
      const expired = uuidv7();
      const active = uuidv7();
      const withConversation = uuidv7();
      const otherBrand = uuidv7();
      await withSystem(db(), brandA.id, (tx) =>
        tx.insert(widgetVisitors).values([
          {
            id: expired,
            brandId: brandA.id,
            secretHash: `test-${expired}`,
            lastSeenAt: daysAgo(31),
          },
          { id: active, brandId: brandA.id, secretHash: `test-${active}`, lastSeenAt: daysAgo(1) },
          {
            id: withConversation,
            brandId: brandA.id,
            secretHash: `test-${withConversation}`,
            lastSeenAt: daysAgo(31),
          },
        ]),
      );
      await withSystem(db(), brandB.id, (tx) =>
        tx.insert(widgetVisitors).values({
          id: otherBrand,
          brandId: brandB.id,
          secretHash: `test-${otherBrand}`,
          lastSeenAt: daysAgo(31),
        }),
      );
      const conversation = await seedTicket(brandA, { status: 'open' });
      await withSystem(db(), brandA.id, (tx) =>
        tx
          .update(tickets)
          .set({ visitorId: withConversation })
          .where(eq(tickets.id, conversation.id)),
      );

      const overview = await call<RetentionOverview>(
        'GET',
        `/api/brands/${brandA.id}/retention`,
        adminToken,
      );
      expect(overview.body.preview.visitorSessions).toBe(1);

      const counts = await runBrandRetention({
        db: db(),
        brandId: brandA.id,
        jobId: 'job-visitors',
        batchSize: 1,
      });
      expect(counts.visitorSessions).toBe(1);
      const remainingA = await withSystem(db(), brandA.id, (tx) =>
        tx.select({ id: widgetVisitors.id }).from(widgetVisitors),
      );
      expect(remainingA.map((row) => row.id).sort()).toEqual([active, withConversation].sort());
      expect(
        await withSystem(db(), brandB.id, (tx) =>
          tx.select({ id: widgetVisitors.id }).from(widgetVisitors),
        ),
      ).toEqual([{ id: otherBrand }]);
      expect(
        (await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-visitors-again' }))
          .visitorSessions,
      ).toBe(0);
    });

    it('purges notifications older than the panel window in bounded brand-scoped batches', async () => {
      const ticketA = await seedTicket(brandA, { status: 'open' });
      const ticketB = await seedTicket(brandB, { status: 'open' });
      const old = uuidv7();
      const recent = uuidv7();
      const otherBrand = uuidv7();
      await withSystem(db(), brandA.id, (tx) =>
        tx.insert(notifications).values([
          {
            id: old,
            brandId: brandA.id,
            userId: seeded.userId,
            ticketId: ticketA.id,
            kind: 'assigned',
            sourceEventId: uuidv7(),
            inApp: true,
            email: false,
            push: false,
            createdAt: daysAgo(31),
          },
          {
            id: recent,
            brandId: brandA.id,
            userId: seeded.userId,
            ticketId: ticketA.id,
            kind: 'assigned',
            sourceEventId: uuidv7(),
            inApp: true,
            email: false,
            push: false,
            createdAt: daysAgo(1),
          },
        ]),
      );
      await withSystem(db(), brandB.id, (tx) =>
        tx.insert(notifications).values({
          id: otherBrand,
          brandId: brandB.id,
          userId: seeded.userId,
          ticketId: ticketB.id,
          kind: 'assigned',
          sourceEventId: uuidv7(),
          inApp: true,
          email: false,
          push: false,
          createdAt: daysAgo(31),
        }),
      );

      const counts = await runBrandRetention({
        db: db(),
        brandId: brandA.id,
        jobId: 'job-notifications',
        batchSize: 1,
      });
      expect(counts.notifications).toBe(1);
      expect(
        await withSystem(db(), brandA.id, (tx) =>
          tx.select({ id: notifications.id }).from(notifications),
        ),
      ).toEqual([{ id: recent }]);
      expect(
        await withSystem(db(), brandB.id, (tx) =>
          tx.select({ id: notifications.id }).from(notifications),
        ),
      ).toEqual([{ id: otherBrand }]);
      expect(
        (
          await runBrandRetention({
            db: db(),
            brandId: brandA.id,
            jobId: 'job-notifications-again',
          })
        ).notifications,
      ).toBe(0);
    });

    it('purges sent notification email batches with the window, and keeps a pending one (M14-10)', async () => {
      const batch = (createdAt: Date, status: 'pending' | 'sent' | 'empty') => ({
        id: uuidv7(),
        brandId: brandA.id,
        userId: seeded.userId,
        kind: status === 'pending' ? ('daily' as const) : ('immediate' as const),
        status,
        scheduledFor: createdAt,
        createdAt,
      });
      const old = batch(daysAgo(31), 'sent');
      const empty = batch(daysAgo(40), 'empty');
      const recent = batch(daysAgo(1), 'sent');
      const waiting = batch(daysAgo(31), 'pending');
      await withSystem(db(), brandA.id, (tx) =>
        tx.insert(notificationEmailBatches).values([old, empty, recent, waiting]),
      );

      await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-batches', batchSize: 1 });

      const left = await withSystem(db(), brandA.id, (tx) =>
        tx.select({ id: notificationEmailBatches.id }).from(notificationEmailBatches),
      );
      expect(left.map((row) => row.id).sort()).toEqual([recent.id, waiting.id].sort());
    });

    it('nulls AI call bodies past the brand window and keeps their counts and cost (M7)', async () => {
      const ticket = await seedTicket(brandA, { status: 'open' });
      const call = (createdAt: Date) => ({
        brandId: brandA.id,
        ticketId: ticket.id,
        feature: 'assist.suggest_reply',
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'ok' as const,
        tokensIn: 120,
        tokensOut: 40,
        costUsd: 0.0021,
        promptHash: 'hash',
        prompt: { system: '', messages: [{ role: 'user', text: 'Mail [EMAIL_1]' }] },
        response: 'Done.',
        redactions: [{ placeholder: '[EMAIL_1]', kind: 'email', original: 'mona@example.com' }],
        sources: ['chunk-1'],
        createdAt,
      });
      const [old, recent] = await withSystem(db(), brandA.id, (tx) =>
        tx
          .insert(aiCalls)
          .values([call(daysAgo(91)), call(daysAgo(1))])
          .returning({ id: aiCalls.id }),
      );
      const ticketB = await seedTicket(brandB, { status: 'open' });
      await withSystem(db(), brandB.id, (tx) =>
        tx
          .insert(aiCalls)
          .values({ ...call(daysAgo(200)), brandId: brandB.id, ticketId: ticketB.id }),
      );

      const counts = await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-ai' });

      expect(counts.aiCalls).toBe(1);
      const rows = await withSystem(db(), brandA.id, (tx) => tx.select().from(aiCalls));
      expect(rows.find((row) => row.id === old?.id)).toMatchObject({
        prompt: null,
        response: null,
        redactions: null,
        sources: null,
        tokensIn: 120,
        tokensOut: 40,
        costUsd: 0.0021,
        promptHash: 'hash',
        bodiesPurgedAt: expect.any(Date),
      });
      expect(rows.find((row) => row.id === recent?.id)?.response).toBe('Done.');
      const [other] = await withSystem(db(), brandB.id, (tx) => tx.select().from(aiCalls));
      expect(other?.response).toBe('Done.');
      expect(
        (await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-ai-again' })).aiCalls,
      ).toBe(0);
    });

    it('purges delivery logs past 30 days and idempotency keys past a day, and keeps what is pending or recent (ASVS 8.3.8)', async () => {
      const tickets4: SeededTicket[] = [];
      for (let index = 0; index < 4; index += 1) {
        tickets4.push(await seedTicket(brandA, { status: 'open' }));
      }
      const webhookCopy = (
        webhookId: string,
        brandId: string,
        status: 'pending' | 'succeeded' | 'failed' | 'skipped',
        createdAt: Date,
      ) => ({
        brandId,
        webhookId,
        eventId: uuidv7(),
        event: 'ticket.created',
        payload: { data: { ticket: { id: uuidv7() } } },
        status,
        createdAt,
      });
      const seeded = await withSystem(db(), brandA.id, async (tx) => {
        const [endpoint] = await tx
          .insert(webhooks)
          .values({ brandId: brandA.id, url: 'https://hooks.example.com/h', secret: 'v1.sealed' })
          .returning({ id: webhooks.id });
        const webhookId = endpoint?.id ?? '';
        const copies = await tx
          .insert(webhookDeliveries)
          .values([
            webhookCopy(webhookId, brandA.id, 'succeeded', daysAgo(31)),
            webhookCopy(webhookId, brandA.id, 'failed', daysAgo(45)),
            webhookCopy(webhookId, brandA.id, 'skipped', daysAgo(60)),
            webhookCopy(webhookId, brandA.id, 'pending', daysAgo(40)),
            webhookCopy(webhookId, brandA.id, 'succeeded', daysAgo(2)),
          ])
          .returning({
            id: webhookDeliveries.id,
            status: webhookDeliveries.status,
            createdAt: webhookDeliveries.createdAt,
          });

        const [bot] = await tx
          .insert(telegramBots)
          .values({
            brandId: brandA.id,
            telegramId: Date.now() + 1,
            username: 'retention_bot',
            displayName: 'Retention',
            departmentId: brandA.departmentId,
            token: 'v1.sealed',
            tokenUpdatedAt: new Date(),
            webhookSecret: 'v1.sealed',
          })
          .returning({ id: telegramBots.id });
        const telegramCopy = (
          ticket: SeededTicket,
          status: 'queued' | 'sent' | 'failed',
          createdAt: Date,
        ) => ({
          brandId: brandA.id,
          departmentId: brandA.departmentId,
          ticketId: ticket.id,
          ticketMessageId: ticket.messageId,
          botId: bot?.id ?? '',
          chatId: '5550001',
          status,
          createdAt,
        });
        const [oldSent, oldFailed, oldQueued, recentSent] = await tx
          .insert(telegramDeliveries)
          .values([
            telegramCopy(tickets4[0] as SeededTicket, 'sent', daysAgo(31)),
            telegramCopy(tickets4[1] as SeededTicket, 'failed', daysAgo(50)),
            telegramCopy(tickets4[2] as SeededTicket, 'queued', daysAgo(40)),
            telegramCopy(tickets4[3] as SeededTicket, 'sent', daysAgo(1)),
          ])
          .returning({ id: telegramDeliveries.id });

        const [key] = await tx
          .insert(apiKeys)
          .values({ brandId: brandA.id, name: 'k', prefix: 'hd_live_abcd', keyHash: uuidv7() })
          .returning({ id: apiKeys.id });
        const [oldKey, freshKey] = await tx
          .insert(apiIdempotencyKeys)
          .values(
            ['stale', 'fresh'].map((name, index) => ({
              brandId: brandA.id,
              apiKeyId: key?.id ?? '',
              key: name,
              requestHash: 'hash',
              response: '{}',
              createdAt: index === 0 ? new Date(Date.now() - 25 * 3_600_000) : new Date(),
            })),
          )
          .returning({ id: apiIdempotencyKeys.id });
        return { copies, webhookId, oldSent, oldFailed, oldQueued, recentSent, oldKey, freshKey };
      });
      // The same ages in another brand, which brand A's run must not touch.
      await withSystem(db(), brandB.id, async (tx) => {
        const [endpoint] = await tx
          .insert(webhooks)
          .values({ brandId: brandB.id, url: 'https://hooks.example.com/b', secret: 'v1.sealed' })
          .returning({ id: webhooks.id });
        await tx
          .insert(webhookDeliveries)
          .values(webhookCopy(endpoint?.id ?? '', brandB.id, 'succeeded', daysAgo(90)));
      });

      const counts = await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-logs' });

      expect(counts).toMatchObject({
        webhookDeliveries: 3,
        telegramDeliveries: 2,
        idempotencyKeys: 1,
      });
      const left = await withSystem(db(), brandA.id, async (tx) => ({
        webhooks: (await tx.select({ id: webhookDeliveries.id }).from(webhookDeliveries)).map(
          (row) => row.id,
        ),
        telegram: (await tx.select({ id: telegramDeliveries.id }).from(telegramDeliveries)).map(
          (row) => row.id,
        ),
        keys: (await tx.select({ id: apiIdempotencyKeys.id }).from(apiIdempotencyKeys)).map(
          (row) => row.id,
        ),
      }));
      const keptWebhooks = seeded.copies
        .filter((row) => row.status === 'pending' || row.createdAt > daysAgo(30))
        .map((row) => row.id);
      expect(left.webhooks.sort()).toEqual(keptWebhooks.sort());
      expect(left.telegram.sort()).toEqual([seeded.oldQueued?.id, seeded.recentSent?.id].sort());
      expect(left.keys).toEqual([seeded.freshKey?.id]);
      const otherBrand = await withSystem(db(), brandB.id, (tx) =>
        tx.select({ id: webhookDeliveries.id }).from(webhookDeliveries),
      );
      expect(otherBrand).toHaveLength(1);
      expect(
        await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-logs-again' }),
      ).toMatchObject({ webhookDeliveries: 0, telegramDeliveries: 0, idempotencyKeys: 0 });
    });

    it('purges Meta deliveries past 30 days once they have an outcome, and keeps the queued and the recent (M10-03)', async () => {
      const ages = [
        ['sent', 31],
        ['delivered', 40],
        ['read', 45],
        ['failed', 50],
        ['refused', 60],
        ['queued', 40],
        ['sent', 1],
      ] as const;
      const owned: SeededTicket[] = [];
      for (let index = 0; index < ages.length; index += 1) {
        owned.push(await seedTicket(brandA, { status: 'open' }));
      }
      const foreign = await seedTicket(brandB, { status: 'open' });

      const seedMeta = async (
        brand: BrandFixture,
        rows: readonly { ticket: SeededTicket; status: (typeof ages)[number][0]; age: number }[],
      ) =>
        withSystem(db(), brand.id, async (tx) => {
          const [account] = await tx
            .insert(metaAccounts)
            .values({
              brandId: brand.id,
              platform: 'whatsapp',
              departmentId: brand.departmentId,
              externalId: String(Math.floor(Math.random() * 1e12)),
              displayName: 'Retention number',
              accessToken: 'v1.sealed',
              tokenKind: 'system_user',
              tokenUpdatedAt: new Date(),
            })
            .returning({ id: metaAccounts.id });
          const [contact] = await tx
            .insert(contacts)
            .values({ brandId: brand.id, name: 'Mona' })
            .returning({ id: contacts.id });
          const [conversation] = await tx
            .insert(metaConversations)
            .values({
              brandId: brand.id,
              accountId: account?.id ?? '',
              customerId: 'US.13491208655302741918',
              contactId: contact?.id ?? '',
            })
            .returning({ id: metaConversations.id });
          return tx
            .insert(metaDeliveries)
            .values(
              rows.map((row) => ({
                brandId: brand.id,
                departmentId: brand.departmentId,
                ticketId: row.ticket.id,
                ticketMessageId: row.ticket.messageId,
                accountId: account?.id ?? '',
                conversationId: conversation?.id ?? '',
                customerId: 'US.13491208655302741918',
                status: row.status,
                createdAt: daysAgo(row.age),
              })),
            )
            .returning({ id: metaDeliveries.id, status: metaDeliveries.status });
        });
      const mine = await seedMeta(
        brandA,
        owned.map((ticket, index) => ({
          ticket,
          status: ages[index]?.[0] ?? 'sent',
          age: ages[index]?.[1] ?? 0,
        })),
      );
      await seedMeta(brandB, [{ ticket: foreign, status: 'sent', age: 90 }]);

      const counts = await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-meta' });

      // The five that ended and are past 30 days; the queued one and the day-old one stay.
      expect(counts.metaDeliveries).toBe(5);
      const left = await withSystem(db(), brandA.id, (tx) =>
        tx.select({ id: metaDeliveries.id }).from(metaDeliveries),
      );
      expect(left.map((row) => row.id).sort()).toEqual([mine[5]?.id, mine[6]?.id].sort());
      expect(mine[5]?.status).toBe('queued');
      expect(
        await withSystem(db(), brandB.id, (tx) =>
          tx.select({ id: metaDeliveries.id }).from(metaDeliveries),
        ),
      ).toHaveLength(1);
      expect(
        (await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-meta-again' }))
          .metaDeliveries,
      ).toBe(0);
    });

    it('removes expired closed and spam tickets with their messages, rows and objects, and nothing else', async () => {
      await setClosedWindow(brandA.id, 30);
      const expired = await seedTicket(brandA, {
        status: 'closed',
        closedDaysAgo: 40,
        withAttachment: true,
      });
      const oldSpam = await seedTicket(brandA, { status: 'spam', closedDaysAgo: 31 });
      const recent = await seedTicket(brandA, { status: 'closed', closedDaysAgo: 5 });
      const freshSpam = await seedTicket(brandA, { status: 'spam', closedDaysAgo: 10 });
      const open = await seedTicket(brandA, { status: 'open' });

      const counts = await runBrandRetention({
        db: db(),
        brandId: brandA.id,
        jobId: 'maintenance.retention.test',
        batchSize: 1,
      });

      expect(counts).toMatchObject({ closedTickets: 1, spamTickets: 1 });
      expect(new Set(await ticketIdsOf(brandA.id))).toEqual(
        new Set([recent.id, freshSpam.id, open.id]),
      );
      const leftovers = await withSystem(db(), brandA.id, async (tx) => ({
        messages: await tx
          .select()
          .from(ticketMessages)
          .where(inArray(ticketMessages.ticketId, [expired.id, oldSpam.id])),
        attachments: await tx
          .select()
          .from(attachments)
          .where(eq(attachments.ticketId, expired.id)),
      }));
      expect(leftovers).toEqual({ messages: [], attachments: [] });

      // The bytes go through the outbox, after the rows committed.
      expect(storage.removed).toEqual([]);
      await drainObjectPurges(brandA.id);
      expect(storage.removed).toEqual(expect.arrayContaining([...expired.keys]));
    });

    it('keeps a split copy’s bytes until the last row naming them is purged (M1-09)', async () => {
      await setClosedWindow(brandA.id, 30);
      const original = await seedTicket(brandA, {
        status: 'closed',
        closedDaysAgo: 40,
        withAttachment: true,
      });
      const splitOff = await seedTicket(brandA, { status: 'open' });
      // What a split writes: a second row on the new ticket, same object.
      await withSystem(db(), brandA.id, async (tx) => {
        const [source] = await tx
          .select()
          .from(attachments)
          .where(eq(attachments.ticketId, original.id));
        if (source === undefined) {
          throw new Error('the original attachment was not seeded');
        }
        await tx.insert(attachments).values({
          brandId: brandA.id,
          ticketId: splitOff.id,
          departmentId: brandA.departmentId,
          messageId: splitOff.messageId,
          uploaderType: source.uploaderType,
          uploaderId: source.uploaderId,
          s3Key: source.s3Key,
          originalName: source.originalName,
          mime: source.mime,
          size: source.size,
          kind: source.kind,
          status: 'ready',
          copiedFromAttachmentId: source.id,
        });
      });

      await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-split-1' });
      storage.removed.length = 0;
      await drainObjectPurges(brandA.id);

      // The original's ticket is gone; the copy still downloads those bytes.
      expect(await ticketIdsOf(brandA.id)).toEqual([splitOff.id]);
      expect(storage.removed).toEqual([]);

      // Once the copy's ticket closes and expires too, the objects go with it.
      await withSystem(db(), brandA.id, (tx) =>
        tx
          .update(tickets)
          .set({ statusId: brandA.closedStatusId, closedAt: daysAgo(40) })
          .where(eq(tickets.id, splitOff.id)),
      );
      await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-split-2' });
      await drainObjectPurges(brandA.id);

      expect(storage.removed).toEqual(expect.arrayContaining([...original.keys]));
    });

    it('keeps every closed ticket while the brand says "never"', async () => {
      const old = await seedTicket(brandA, { status: 'closed', closedDaysAgo: 4_000 });

      const counts = await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-never' });

      expect(counts.closedTickets).toBeUndefined();
      expect(await ticketIdsOf(brandA.id)).toEqual([old.id]);
    });

    it("never touches another brand's rows, however expired they are", async () => {
      await setClosedWindow(brandA.id, 30);
      await setClosedWindow(brandB.id, 30);
      const theirs = await seedTicket(brandB, { status: 'closed', closedDaysAgo: 400 });
      const theirSpam = await seedTicket(brandB, { status: 'spam', closedDaysAgo: 400 });
      await withSystem(db(), brandB.id, (tx) =>
        tx.insert(auditLog).values({
          brandId: brandB.id,
          actorType: 'system',
          actorId: 'test',
          action: 'test.ancient',
          targetType: 'test',
          createdAt: daysAgo(5_000),
        }),
      );

      await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-a' });

      expect(new Set(await ticketIdsOf(brandB.id))).toEqual(new Set([theirs.id, theirSpam.id]));
      const ancient = await withSystem(db(), brandB.id, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, 'test.ancient')),
      );
      expect(ancient).toHaveLength(1);
    });

    it('purges the audit log and published outbox past their windows, and logs counts only', async () => {
      await withSystem(db(), brandA.id, async (tx) => {
        await tx.insert(auditLog).values({
          brandId: brandA.id,
          actorType: 'system',
          actorId: 'test',
          action: 'test.ancient',
          targetType: 'test',
          createdAt: daysAgo(731),
        });
        await tx.insert(outbox).values([
          { brandId: brandA.id, event: 'test.old', payload: {}, publishedAt: daysAgo(8) },
          { brandId: brandA.id, event: 'test.recent', payload: {}, publishedAt: daysAgo(1) },
          { brandId: brandA.id, event: 'test.pending', payload: {} },
        ]);
      });

      const counts = await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-audit' });

      expect(counts.auditLog).toBeGreaterThanOrEqual(1);
      expect(counts.outbox).toBe(1);
      const state = await withSystem(db(), brandA.id, async (tx) => ({
        ancient: await tx.select().from(auditLog).where(eq(auditLog.action, 'test.ancient')),
        events: (await tx.select({ event: outbox.event }).from(outbox)).map((row) => row.event),
        run: await tx.select().from(auditLog).where(eq(auditLog.action, 'retention.purged')),
        settings: await tx.select().from(retentionSettings),
      }));
      expect(state.ancient).toEqual([]);
      expect(state.events).toEqual(expect.arrayContaining(['test.recent', 'test.pending']));
      expect(state.events).not.toContain('test.old');
      expect(state.run.at(-1)).toMatchObject({
        actorType: 'system',
        actorId: 'job-audit',
        meta: { counts },
      });
      expect(state.settings[0]?.lastRunCounts).toEqual(counts);
    });

    it('removes nothing the second time it runs', async () => {
      await setClosedWindow(brandA.id, 30);
      await seedTicket(brandA, { status: 'closed', closedDaysAgo: 40 });
      await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-first' });

      const again = await runBrandRetention({ db: db(), brandId: brandA.id, jobId: 'job-second' });

      expect(again).toMatchObject({ closedTickets: 0, spamTickets: 0, auditLog: 0 });
    });

    it('cascades every foreign key into tickets, so a purge leaves no orphan behind', async () => {
      // CSAT (M1-12), AI calls (M7) and whatever comes next hang off a ticket.
      // A foreign key that restricts would make the purge fail; one that does
      // nothing would leave rows of a ticket that no longer exists.
      const rows = await db().execute<{ constraint: string; action: string }>(sql`
        SELECT conname AS constraint, confdeltype AS action
        FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'public.tickets'::regclass
      `);

      for (const row of rows) {
        expect({ constraint: row.constraint, action: row.action }).toEqual({
          constraint: row.constraint,
          action: expect.stringMatching(/^[cn]$/),
        });
      }
    });
  });

  // ------------------------------------------------------------------ the tick

  describe('the nightly tick', () => {
    const recorder = () => {
      const added: { payload: MaintenanceRetentionPayload; jobId: string }[] = [];
      const queue = {
        add: async (payload: MaintenanceRetentionPayload, jobId: string) =>
          void added.push({ payload, jobId }),
      };
      return { added, queue };
    };

    it('adds one job per brand, under an id that is the same all night', async () => {
      const { added, queue } = recorder();
      const now = new Date('2031-01-01T03:00:00.000Z');

      await scheduleRetention({ db: db(), queue, now });
      await scheduleRetention({ db: db(), queue, now });

      const brandIds = new Set(added.map((entry) => entry.payload.brandId));
      expect([...brandIds]).toEqual(expect.arrayContaining([brandA.id, brandB.id]));
      // Each brand twice under one id, which BullMQ ignores the second time.
      expect(added).toHaveLength(brandIds.size * 2);
      expect(new Set(added.map((entry) => entry.jobId)).size).toBe(brandIds.size);
      expect(added.every((entry) => entry.payload.runDate === '2031-01-01')).toBe(true);
    });

    it('purges job receipts past the seven days, once for the install', async () => {
      await db()
        .insert(jobReceipts)
        .values([
          { key: `retention-test-old-${uuidv7()}`, completedAt: daysAgo(30) },
          { key: `retention-test-new-${uuidv7()}`, completedAt: daysAgo(1) },
        ]);

      const result = await scheduleRetention({ db: db(), queue: recorder().queue });

      expect(result.receipts).toBeGreaterThanOrEqual(1);
      const remaining = await db().select().from(jobReceipts);
      expect(remaining.some((row) => row.key.startsWith('retention-test-old-'))).toBe(false);
      expect(remaining.some((row) => row.key.startsWith('retention-test-new-'))).toBe(true);
    });
  });

  // ------------------------------------------------------------------ erasure

  describe('contact erasure', () => {
    it('deletes the files the person sent, clears their channel ids and keeps the bodies', async () => {
      const contactId = uuidv7();
      await withSystem(db(), brandA.id, async (tx) => {
        await tx
          .insert(contacts)
          .values({ id: contactId, brandId: brandA.id, name: 'Mona Khalil' });
        await tx.insert(contactIdentities).values({
          brandId: brandA.id,
          contactId,
          kind: 'email',
          value: 'mona@customer.example',
          source: 'agent',
        });
      });
      const ticket = await seedTicket(brandA, { status: 'open', contactId, withAttachment: true });

      const response = await call<ContactDetail>(
        'POST',
        `/api/brands/${brandA.id}/contacts/${contactId}/anonymise`,
        adminToken,
      );

      expect(response.status).toBe(201);
      const after = await withSystem(db(), brandA.id, async (tx) => ({
        attachments: await tx.select().from(attachments).where(eq(attachments.ticketId, ticket.id)),
        message: (
          await tx.select().from(ticketMessages).where(eq(ticketMessages.id, ticket.messageId))
        )[0],
        audit: (
          await tx
            .select()
            .from(auditLog)
            .where(and(eq(auditLog.action, 'contact.anonymised'), eq(auditLog.targetId, contactId)))
        )[0],
      }));
      expect(after.attachments).toEqual([]);
      expect(after.message?.externalMessageId).toBeNull();
      expect(after.message?.bodyText).toBe('My order never arrived.');
      expect(after.audit?.meta).toMatchObject({ attachmentCount: 1, messageCount: 1 });
      expect(JSON.stringify(after.audit?.meta)).not.toContain('mona@customer.example');

      await drainObjectPurges(brandA.id);
      expect(storage.removed).toEqual(expect.arrayContaining([...ticket.keys]));
    });

    it('takes the Telegram chat, the AI redaction map and the webhook copies, and leaves other people alone', async () => {
      const contactId = uuidv7();
      const bystanderId = uuidv7();
      const CHAT = '5550001234';
      await withSystem(db(), brandA.id, async (tx) => {
        await tx.insert(contacts).values([
          { id: contactId, brandId: brandA.id, name: 'Mona Khalil' },
          { id: bystanderId, brandId: brandA.id, name: 'Omar Saleh' },
        ]);
        await tx.insert(contactIdentities).values({
          brandId: brandA.id,
          contactId,
          kind: 'telegram',
          value: CHAT,
          source: 'telegram.bot',
        });
      });
      const ticket = await seedTicket(brandA, { status: 'open', contactId });
      const bystanderTicket = await seedTicket(brandA, { status: 'open', contactId: bystanderId });
      await withSystem(db(), brandA.id, async (tx) => {
        const [bot] = await tx
          .insert(telegramBots)
          .values({
            brandId: brandA.id,
            telegramId: Date.now(),
            username: 'acme_support_bot',
            displayName: 'Acme support',
            departmentId: brandA.departmentId,
            token: 'v1.sealed',
            tokenUpdatedAt: new Date(),
            webhookSecret: 'v1.sealed',
          })
          .returning({ id: telegramBots.id });
        const botId = bot?.id ?? '';
        await tx.insert(telegramChats).values([
          {
            brandId: brandA.id,
            botId,
            chatId: CHAT,
            contactId,
            username: 'mona_k',
            ticketId: ticket.id,
          },
          {
            brandId: brandA.id,
            botId,
            chatId: '5559998888',
            contactId: bystanderId,
            username: 'omar_s',
          },
        ]);
        const delivery = (ticketId: string, ticketMessageId: string, chatId: string) => ({
          brandId: brandA.id,
          departmentId: brandA.departmentId,
          ticketId,
          ticketMessageId,
          botId,
          chatId,
          status: 'sent' as const,
        });
        await tx
          .insert(telegramDeliveries)
          .values([
            delivery(ticket.id, ticket.messageId, CHAT),
            delivery(bystanderTicket.id, bystanderTicket.messageId, '5559998888'),
          ]);

        const call = (ticketId: string) => ({
          brandId: brandA.id,
          ticketId,
          feature: 'assist.suggest_reply',
          provider: 'openai',
          model: 'gpt-test',
          status: 'ok' as const,
          redactionCount: 1,
          redactions: [
            { placeholder: '[EMAIL_1]', kind: 'email', original: 'mona@customer.example' },
          ],
        });
        await tx.insert(aiCalls).values([call(ticket.id), call(bystanderTicket.id)]);

        const [endpoint] = await tx
          .insert(webhooks)
          .values({
            brandId: brandA.id,
            url: 'https://hooks.example.com/helpdock',
            events: ['ticket.created', 'contact.created', 'csat.received'],
            secret: 'v1.sealed',
          })
          .returning({ id: webhooks.id });
        const webhookId = endpoint?.id ?? '';
        const copy = (
          event: string,
          data: Record<string, unknown>,
          status: 'pending' | 'succeeded',
        ) => ({
          brandId: brandA.id,
          webhookId,
          eventId: uuidv7(),
          event,
          status,
          payload: { id: uuidv7(), event, brandId: brandA.id, data },
        });
        await tx
          .insert(webhookDeliveries)
          .values([
            copy(
              'contact.created',
              { contact: { id: contactId, name: 'Mona Khalil' } },
              'succeeded',
            ),
            copy('ticket.created', { ticket: { id: ticket.id, contactId } }, 'pending'),
            copy(
              'message.created',
              { message: { ticketId: ticket.id, bodyText: 'Private copy' } },
              'pending',
            ),
            copy(
              'message.created',
              { message: { ticketId: ticket.id, bodyText: 'Delivered copy' } },
              'succeeded',
            ),
            copy(
              'csat.received',
              { survey: { id: uuidv7(), ticketId: ticket.id, comment: 'Thanks' } },
              'succeeded',
            ),
            copy(
              'ticket.created',
              { ticket: { id: bystanderTicket.id, contactId: bystanderId } },
              'succeeded',
            ),
            copy('contact.created', { contact: { id: bystanderId } }, 'succeeded'),
            copy(
              'message.created',
              { message: { ticketId: bystanderTicket.id, bodyText: 'Keep this copy' } },
              'pending',
            ),
          ]);
      });

      const response = await call<ContactDetail>(
        'POST',
        `/api/brands/${brandA.id}/contacts/${contactId}/anonymise`,
        adminToken,
      );
      expect(response.status).toBe(201);

      const after = await withSystem(db(), brandA.id, async (tx) => ({
        chats: await tx.select().from(telegramChats),
        deliveries: await tx.select().from(telegramDeliveries),
        calls: await tx.select().from(aiCalls),
        webhookCopies: await tx.select().from(webhookDeliveries).orderBy(webhookDeliveries.event),
        audit: (
          await tx
            .select()
            .from(auditLog)
            .where(and(eq(auditLog.action, 'contact.anonymised'), eq(auditLog.targetId, contactId)))
        )[0],
      }));
      expect(after.chats.map((chat) => chat.chatId)).toEqual(['5559998888']);
      const deliveryChatIds = after.deliveries.map((delivery) => delivery.chatId);
      expect(deliveryChatIds).toContain('5559998888');
      expect(
        deliveryChatIds.filter((id) => /^erased:telegram:[0-9a-f]{32}$/.test(id)),
      ).toHaveLength(1);
      expect(JSON.stringify(after.deliveries)).not.toContain(CHAT);
      expect(after.calls.find((row) => row.ticketId === ticket.id)?.redactions).toBeNull();
      expect(
        after.calls.find((row) => row.ticketId === bystanderTicket.id)?.redactions,
      ).not.toBeNull();
      expect(
        after.webhookCopies.map(
          (row) => row.payload.data as { ticket?: { id: string }; contact?: { id: string } },
        ),
      ).toEqual([
        { contact: { id: bystanderId } },
        { message: { ticketId: bystanderTicket.id, bodyText: 'Keep this copy' } },
        { ticket: { id: bystanderTicket.id, contactId: bystanderId } },
      ]);
      expect(after.audit?.meta).toMatchObject({
        telegramChatCount: 1,
        aiCallCount: 1,
        webhookDeliveryCount: 5,
      });
      expect(JSON.stringify(after.audit?.meta)).not.toContain(CHAT);

      // A later message from the same chat meets nobody and files a new contact.
      const next = await withSystem(db(), brandA.id, (tx) =>
        findOrCreateContactByIdentity(tx, brandA.id, {
          kind: 'telegram',
          value: CHAT,
          source: 'telegram.bot',
        }),
      );
      expect(next).toMatchObject({ created: true });
      expect(next.contact.id).not.toBe(contactId);
    });

    it('takes the WhatsApp conversation with its deliveries, and leaves other people alone (M10-03)', async () => {
      const contactId = uuidv7();
      const bystanderId = uuidv7();
      const USER_ID = 'US.13491208655302741918';
      const BYSTANDER_USER_ID = 'US.99999999999999999999';
      let accountId = '';
      await withSystem(db(), brandA.id, async (tx) => {
        await tx.insert(contacts).values([
          { id: contactId, brandId: brandA.id, name: 'Mona Khalil' },
          { id: bystanderId, brandId: brandA.id, name: 'Omar Saleh' },
        ]);
        await tx.insert(contactIdentities).values([
          {
            brandId: brandA.id,
            contactId,
            kind: 'whatsapp',
            value: USER_ID,
            source: 'whatsapp.cloud',
          },
          {
            brandId: brandA.id,
            contactId,
            kind: 'phone',
            value: '+16505551234',
            source: 'whatsapp.cloud',
            verified: true,
          },
        ]);
      });
      const ticket = await seedTicket(brandA, { status: 'open', contactId });
      const bystanderTicket = await seedTicket(brandA, { status: 'open', contactId: bystanderId });
      await withSystem(db(), brandA.id, async (tx) => {
        const [account] = await tx
          .insert(metaAccounts)
          .values({
            brandId: brandA.id,
            platform: 'whatsapp',
            departmentId: brandA.departmentId,
            externalId: String(Math.floor(Math.random() * 1e12)),
            displayName: 'Acme',
            accessToken: 'v1.sealed',
            tokenKind: 'system_user',
            tokenUpdatedAt: new Date(),
          })
          .returning({ id: metaAccounts.id });
        accountId = account?.id ?? '';
        const [mine, theirs] = await tx
          .insert(metaConversations)
          .values([
            {
              brandId: brandA.id,
              accountId,
              customerId: USER_ID,
              contactId,
              waId: '16505551234',
              profileName: 'Mona Khalil',
              ticketId: ticket.id,
            },
            {
              brandId: brandA.id,
              accountId,
              customerId: BYSTANDER_USER_ID,
              contactId: bystanderId,
              waId: '16505550000',
            },
          ])
          .returning({ id: metaConversations.id });
        const delivery = (
          ticketId: string,
          ticketMessageId: string,
          conversationId: string,
          customerId: string,
        ) => ({
          brandId: brandA.id,
          departmentId: brandA.departmentId,
          ticketId,
          ticketMessageId,
          accountId,
          conversationId,
          customerId,
          status: 'queued' as const,
        });
        await tx
          .insert(metaDeliveries)
          .values([
            delivery(ticket.id, ticket.messageId, mine?.id ?? '', USER_ID),
            delivery(
              bystanderTicket.id,
              bystanderTicket.messageId,
              theirs?.id ?? '',
              BYSTANDER_USER_ID,
            ),
          ]);
        // The lines the inbound services write keep the platform's id for the message
        // they are about, so a redelivered webhook writes each once.
        const line = (ticketId: string, key: string) => ({
          brandId: brandA.id,
          departmentId: brandA.departmentId,
          ticketId,
          seq: 2,
          kind: 'system' as const,
          authorType: 'system' as const,
          authorId: `meta:${accountId}`,
          bodyHtml: '<p>The customer reacted to a message.</p>',
          bodyText: 'The customer reacted to a message.',
          channel: 'email' as const,
          externalMessageId: key,
        });
        await tx
          .insert(ticketMessages)
          .values([
            line(ticket.id, 'reaction:wamid.MINE:react:1760000000000'),
            line(bystanderTicket.id, 'reaction:wamid.THEIRS:react:1760000000000'),
          ]);
      });

      const response = await call<ContactDetail>(
        'POST',
        `/api/brands/${brandA.id}/contacts/${contactId}/anonymise`,
        adminToken,
      );
      expect(response.status).toBe(201);

      const after = await withSystem(db(), brandA.id, async (tx) => ({
        conversations: await tx
          .select()
          .from(metaConversations)
          .where(eq(metaConversations.accountId, accountId)),
        deliveries: await tx
          .select()
          .from(metaDeliveries)
          .where(eq(metaDeliveries.accountId, accountId)),
        lines: await tx
          .select({
            ticketId: ticketMessages.ticketId,
            externalMessageId: ticketMessages.externalMessageId,
            bodyText: ticketMessages.bodyText,
          })
          .from(ticketMessages)
          .where(and(eq(ticketMessages.brandId, brandA.id), eq(ticketMessages.kind, 'system'))),
        audit: (
          await tx
            .select()
            .from(auditLog)
            .where(and(eq(auditLog.action, 'contact.anonymised'), eq(auditLog.targetId, contactId)))
        )[0],
      }));
      // The number, the name and the platform id are gone with the conversation; so is the
      // delivery that froze the id, so a reply still queued finds nothing to send.
      expect(after.conversations.map((row) => row.customerId)).toEqual([BYSTANDER_USER_ID]);
      expect(after.deliveries.map((row) => row.customerId)).toEqual([BYSTANDER_USER_ID]);
      expect(after.audit?.meta).toMatchObject({ metaConversationCount: 1 });
      expect(JSON.stringify(after)).not.toContain('16505551234');
      // The platform's id for their message goes from the line, which keeps its words; the
      // bystander's line keeps its key.
      expect(after.lines.find((row) => row.ticketId === ticket.id)).toMatchObject({
        externalMessageId: null,
        bodyText: 'The customer reacted to a message.',
      });
      expect(after.lines.find((row) => row.ticketId === bystanderTicket.id)).toMatchObject({
        externalMessageId: 'reaction:wamid.THEIRS:react:1760000000000',
      });
      expect(JSON.stringify(after.lines)).not.toContain('wamid.MINE');
      expect(JSON.stringify(after.audit?.meta)).not.toContain(USER_ID);

      // A later message from the same person meets nobody and files a new contact.
      const next = await withSystem(db(), brandA.id, (tx) =>
        findOrCreateContactByIdentity(tx, brandA.id, {
          kind: 'whatsapp',
          value: USER_ID,
          source: 'whatsapp.cloud',
        }),
      );
      expect(next).toMatchObject({ created: true });
      expect(next.contact.id).not.toBe(contactId);
    });
  });
});
