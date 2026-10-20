import type { EmailMessage } from '@helpdock/channels';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  brands,
  createDb,
  type Db,
  type DbHandle,
  departments,
  jobReceipts,
  notificationEmailBatches,
  notificationEmailPacing,
  notificationPrefs,
  notifications,
  seedBrandStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  createQueueConnection,
  notifyEmailBatchJobId,
  QUEUE_NAMES,
  silentLogger,
} from '@helpdock/jobs';
import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
  type NotificationKind,
  type NotificationPreferencesView,
  type PresenceStatus,
  type TicketDetail,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { DelayedError, type Job, Queue } from 'bullmq';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { NotificationEmailEngine } from './email-engine.js';
import { bullEmailQueue, createEmailJobProcessors } from './email-jobs.js';
import { pacingConfigFromMinutes } from './email-pacing.js';
import { EmailPacingRepository } from './email-pacing.repository.js';
import { NotificationsRepository } from './notifications.repository.js';

/**
 * M14-10 against a real Postgres and Redis: Right away batching and its
 * back-off, the send-time re-check, pause, the presence hold and its cap,
 * per-brand digests at the person's hour across a DST change, one email
 * however often a batch job runs, and the rebuild after Redis is lost.
 *
 * The engine runs on a fake clock and a fake presence map; everything it
 * reads and writes is the real schema under the worker's system transaction.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 37).toString('base64');
const PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;
const APP_URL = 'https://support.example.com';
const MINUTE = 60_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M14-10 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('notification email pacing (M14-10)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let redis: Redis;
  let queue: Queue;

  let support: string;
  let billing: string;
  let otherBrand: string;
  let otherDepartment: string;
  /** An Agent of Support in the seeded brand, and an Admin of the other brand. */
  let sam: Person;
  /** An Agent of Support whose role is taken away in one test. */
  let kim: Person;
  let ada: Person;
  let ticketId: string;
  let otherTicketId: string;

  const T0 = new Date('2026-10-20T09:00:00.000Z');
  let clock = T0;
  const at = (minutes: number): Date => new Date(T0.getTime() + minutes * MINUTE);
  const sent: EmailMessage[] = [];
  const presence = new Map<string, PresenceStatus>();

  const config = pacingConfigFromMinutes({
    firstWaitMinutes: 2,
    backoffMinutes: [10, 20, 40, 60],
    quietResetMinutes: 120,
    urgentIntervalMinutes: 5,
    urgentPerDay: 8,
    perHour: 6,
    perDay: 40,
  });
  const engine = new NotificationEmailEngine({
    repository: new EmailPacingRepository(),
    notifications: new NotificationsRepository(),
    config: async () => config,
    presenceOf: async (_brandId, userId) => presence.get(userId) ?? 'offline',
    systemSender: async () => ({ send: async (message) => void sent.push(message) }),
    appUrl: APP_URL,
    log: silentLogger,
    now: () => clock,
  });

  const envFor = (): Env =>
    ({
      APP_URL,
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

  const call = <T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    who: Person,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url: path,
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const addPerson = async (db: Db, name: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const id = uuidv7();
    const email = `${name.toLowerCase()}-${id}@helpdock.test`;
    await db.insert(users).values({
      id,
      email,
      name,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
    });

    return { id, email, token: '' };
  };

  const createTicket = async (brandId: string, departmentId: string, who: Person) => {
    const response = await call<TicketDetail>('POST', `/api/brands/${brandId}/tickets`, who, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      departmentId,
    });
    expect(response.status).toBe(201);

    return response.body.ticket.id;
  };

  const notify = async ({
    userId = sam.id,
    brandId = seeded.brandId,
    ticket = ticketId,
    kind = 'replied',
    actorId = null,
  }: {
    userId?: string;
    brandId?: string;
    ticket?: string;
    kind?: NotificationKind;
    actorId?: string | null;
  } = {}): Promise<string> => {
    const id = uuidv7();
    await withSystem(runtime.db, brandId, (tx) =>
      tx.insert(notifications).values({
        id,
        brandId,
        userId,
        ticketId: ticket,
        kind,
        actorId,
        detail: kind === 'assigned' ? { assignedBy: 'person' } : {},
        sourceEventId: uuidv7(),
        inApp: true,
        email: true,
        push: false,
        emailState: 'pending',
        createdAt: clock,
      }),
    );

    return id;
  };

  const schedule = (id: string, brandId = seeded.brandId) =>
    withSystem(runtime.db, brandId, (tx) => engine.schedule(tx, brandId, id));
  const send = (batchId: string, brandId = seeded.brandId) =>
    withSystem(runtime.db, brandId, (tx) => engine.send(tx, brandId, batchId));
  const tick = (hour: Date, brandId = seeded.brandId) => {
    clock = hour;
    return withSystem(runtime.db, brandId, (tx) => engine.digestTick(tx, brandId, hour));
  };

  const row = async (id: string, brandId = seeded.brandId) => {
    const [found] = await withSystem(runtime.db, brandId, (tx) =>
      tx.select().from(notifications).where(eq(notifications.id, id)),
    );
    return found;
  };
  const batch = async (id: string, brandId = seeded.brandId) => {
    const [found] = await withSystem(runtime.db, brandId, (tx) =>
      tx.select().from(notificationEmailBatches).where(eq(notificationEmailBatches.id, id)),
    );
    return found;
  };
  const pacing = async (userId = sam.id, brandId = seeded.brandId) => {
    const [found] = await withSystem(runtime.db, brandId, (tx) =>
      tx.select().from(notificationEmailPacing).where(eq(notificationEmailPacing.userId, userId)),
    );
    return found;
  };
  const setEmail = async (values: Partial<typeof notificationPrefs.$inferInsert>) => {
    await runtime.db
      .insert(notificationPrefs)
      .values({ userId: sam.id, preferences: NOTIFICATION_PREFERENCE_DEFAULTS, ...values })
      .onConflictDoUpdate({ target: notificationPrefs.userId, set: values });
  };

  /** A batch's id, from the placement the first row of it returned. */
  const opened = async (id: string): Promise<string> => {
    const placement = await schedule(id);
    expect(placement).not.toBeNull();
    return placement?.batchId ?? '';
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
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    redis = createQueueConnection(redisContainer.getConnectionUrl());
    queue = new Queue(QUEUE_NAMES.notify, { connection: redis });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(runtime.db, 'Sam');
    kim = await addPerson(runtime.db, 'Kim');
    otherBrand = uuidv7();
    await runtime.db.insert(brands).values({ id: otherBrand, name: 'Globex', prefix: 'GLX' });

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });
      support = created.find((department) => department.name === 'Support')?.id ?? '';
      billing = created.find((department) => department.name === 'Billing')?.id ?? '';
      await tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: kim.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
      ]);
    });
    await withSystem(runtime.db, otherBrand, async (tx) => {
      await seedBrandStatuses(tx, otherBrand);
      const [created] = await tx
        .insert(departments)
        .values({ brandId: otherBrand, name: 'General' })
        .returning({ id: departments.id });
      otherDepartment = created?.id ?? '';
      await tx
        .insert(userBrandRoles)
        .values({ userId: sam.id, brandId: otherBrand, role: 'admin', departmentIds: null });
    });

    ada.token = await signInForTest(app, { email: seeded.email, password: seeded.password });
    sam.token = await signInForTest(app, { email: sam.email, password: PASSWORD });
    ticketId = await createTicket(seeded.brandId, support, ada);
    otherTicketId = await createTicket(otherBrand, otherDepartment, sam);
  }, 300_000);

  afterAll(async () => {
    await queue?.close();
    redis?.disconnect();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    clock = T0;
    sent.length = 0;
    presence.clear();
    for (const brandId of [seeded.brandId, otherBrand]) {
      await withSystem(runtime.db, brandId, async (tx) => {
        await tx.delete(notifications).where(inArray(notifications.userId, [sam.id, kim.id]));
        await tx.delete(notificationEmailBatches);
        await tx.delete(notificationEmailPacing);
        await tx
          .update(tickets)
          .set({ departmentId: brandId === otherBrand ? otherDepartment : support });
      });
    }
    await runtime.db.delete(notificationPrefs).where(eq(notificationPrefs.userId, sam.id));
    await runtime.db.update(brands).set({ timezone: 'UTC' });
  });

  describe('Right away', () => {
    it('gathers what arrives in the first wait into one email, then backs off', async () => {
      const first = await notify();
      const batchId = await opened(first);
      clock = new Date(T0.getTime() + 30_000);
      expect(await schedule(await notify())).toBeNull();
      clock = at(1);
      expect(await schedule(await notify({ kind: 'assigned', actorId: ada.id }))).toBeNull();

      expect(await send(batchId)).toEqual({ kind: 'later', at: at(2) });

      clock = at(2);
      expect(await send(batchId)).toEqual({ kind: 'done', sent: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toMatch(/^\[.+\] 3 updates since 09:00$/);
      expect(sent[0]?.text).toContain('1 assigned, 2 replies');
      expect(sent[0]?.messageId).toBe(`<notify.batch.${batchId}@support.example.com>`);
      expect(await row(first)).toMatchObject({ emailState: 'sent', emailedAt: at(2) });
      expect(await batch(batchId)).toMatchObject({ status: 'sent', itemCount: 3, sentAt: at(2) });
      expect(await pacing()).toMatchObject({ step: 1, nextAllowedAt: at(12), sentInHour: 1 });

      clock = at(5);
      expect((await schedule(await notify()))?.at).toEqual(at(12));
    });

    it('sends a batch of one as 1.0’s email, with the batch’s Message-ID', async () => {
      const batchId = await opened(await notify({ kind: 'assigned', actorId: ada.id }));
      clock = at(2);
      await send(batchId);

      expect(sent[0]?.subject).toMatch(/^\[.+-\d+\] Assigned to you: Refund for order 42$/);
      expect(sent[0]?.messageId).toBe(`<notify.batch.${batchId}@support.example.com>`);
    });

    it('sends one email however often the batch job runs', async () => {
      const batchId = await opened(await notify());
      clock = at(2);

      expect(await send(batchId)).toEqual({ kind: 'done', sent: true });
      expect(await send(batchId)).toEqual({ kind: 'done', sent: false });
      expect(sent).toHaveLength(1);
      const receipts = await runtime.db
        .select()
        .from(jobReceipts)
        .where(eq(jobReceipts.key, `notify.email_batch:${batchId}`));
      expect(receipts).toHaveLength(1);
    });

    it('lets a mention cut the back-off, and counts it against the urgent allowance', async () => {
      const first = await opened(await notify());
      clock = at(2);
      await send(first);

      clock = at(3);
      const mention = await schedule(await notify({ kind: 'mentioned', actorId: ada.id }));
      expect(mention?.at).toEqual(at(3));
      expect(await batch(mention?.batchId ?? '')).toMatchObject({ urgent: true });

      await send(mention?.batchId ?? '');
      expect(sent).toHaveLength(2);
      expect(await pacing()).toMatchObject({ urgentSentInDay: 1, lastUrgentAt: at(3) });
    });

    it('holds a batch once six emails went this hour, and says when it may go', async () => {
      const batchId = await opened(await notify());
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(notificationEmailPacing)
          .set({ hourWindowStart: at(-10), sentInHour: 6, dayWindowStart: at(-10), sentInDay: 6 }),
      );
      clock = at(2);

      expect(await send(batchId)).toEqual({ kind: 'later', at: at(50) });
      expect(await batch(batchId)).toMatchObject({ status: 'pending', scheduledFor: at(50) });
      expect(sent).toEqual([]);
    });
  });

  describe('the send-time re-check', () => {
    it('drops a row read in the app before its email, opening the ticket included', async () => {
      const id = await notify();
      const batchId = await opened(id);
      expect(
        (await call('GET', `/api/brands/${seeded.brandId}/tickets/${ticketId}`, sam)).status,
      ).toBe(200);
      clock = at(2);

      expect(await send(batchId)).toEqual({ kind: 'done', sent: false });
      expect((await row(id))?.emailState).toBe('skipped_read');
      expect((await batch(batchId))?.status).toBe('empty');
      expect(sent).toEqual([]);
    });

    it('drops a row whose ticket moved out of the recipient’s departments', async () => {
      const id = await notify();
      const batchId = await opened(id);
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.update(tickets).set({ departmentId: billing }).where(eq(tickets.id, ticketId)),
      );
      clock = at(2);

      await send(batchId);
      expect((await row(id))?.emailState).toBe('skipped_scope');
      expect(sent).toEqual([]);
    });

    it('drops the rows of someone who no longer holds a role in the brand', async () => {
      const id = await notify({ userId: kim.id });
      const batchId = (await schedule(id))?.batchId ?? '';
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.delete(userBrandRoles).where(eq(userBrandRoles.userId, kim.id)),
      );
      clock = at(2);

      await send(batchId);
      expect((await row(id))?.emailState).toBe('skipped_scope');
      expect(sent).toEqual([]);
    });

    it('settles the rows as off on an install without SMTP, rather than retrying forever', async () => {
      const warnings: string[] = [];
      const withoutSmtp = new NotificationEmailEngine({
        repository: new EmailPacingRepository(),
        notifications: new NotificationsRepository(),
        config: async () => config,
        presenceOf: async () => 'offline',
        systemSender: async () => null,
        appUrl: APP_URL,
        log: { ...silentLogger, warn: (_fields, message) => void warnings.push(message) },
        now: () => clock,
      });
      const id = await notify();
      const batchId = await opened(id);
      clock = at(2);

      expect(
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          withoutSmtp.send(tx, seeded.brandId, batchId),
        ),
      ).toEqual({ kind: 'done', sent: false });
      expect((await row(id))?.emailState).toBe('skipped_off');
      expect((await batch(batchId))?.status).toBe('empty');
      expect(warnings).toEqual(['Notification email not sent: this install has no SMTP settings.']);
    });

    it('sends only the rows that pass the re-check', async () => {
      const kept = await notify();
      const batchId = await opened(kept);
      const read = await notify();
      await schedule(read);
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(notifications)
          .set({ readAt: at(1) })
          .where(eq(notifications.id, read)),
      );
      clock = at(2);

      await send(batchId);
      expect(sent).toHaveLength(1);
      expect((await row(kept))?.emailState).toBe('sent');
      expect((await row(read))?.emailState).toBe('skipped_read');
      expect((await batch(batchId))?.itemCount).toBe(1);
    });
  });

  describe('pause, Off and a change of schedule', () => {
    it('drops what arrives during a pause and what was waiting, and sends neither later', async () => {
      clock = new Date();
      const waiting = await notify();
      const batchId = await opened(waiting);

      const paused = await call<NotificationPreferencesView>(
        'PUT',
        '/api/me/notification-preferences',
        sam,
        { pausedUntil: new Date(clock.getTime() + 60 * MINUTE).toISOString() },
      );
      expect(paused.status).toBe(200);
      expect(paused.body.emailDelivery.pausedUntil).not.toBeNull();

      const during = await notify();
      expect(await schedule(during)).toBeNull();
      expect((await row(during))?.emailState).toBe('skipped_paused');

      clock = new Date(clock.getTime() + 2 * MINUTE);
      await send(batchId);
      expect((await row(waiting))?.emailState).toBe('skipped_paused');

      expect(
        (await call('PUT', '/api/me/notification-preferences', sam, { pausedUntil: null })).status,
      ).toBe(200);
      await send(batchId);
      expect(sent).toEqual([]);
    });

    it('refuses a pause that has already ended', async () => {
      expect(
        (
          await call('PUT', '/api/me/notification-preferences', sam, {
            pausedUntil: '2020-01-01T00:00:00.000Z',
          })
        ).status,
      ).toBe(400);
    });

    it('marks a row skipped as off when the schedule is Off', async () => {
      const saved = await call<NotificationPreferencesView>(
        'PUT',
        '/api/me/notification-preferences',
        sam,
        { emailSchedule: 'off' },
      );
      expect(saved.body.emailDelivery.schedule).toBe('off');
      expect(saved.body.preferences).toEqual(NOTIFICATION_PREFERENCE_DEFAULTS);

      const id = await notify();
      expect(await schedule(id)).toBeNull();
      expect((await row(id))?.emailState).toBe('skipped_off');
    });

    it('hands a Right away batch’s rows to the digest when the person switches to one', async () => {
      const id = await notify();
      const batchId = await opened(id);
      await setEmail({ emailSchedule: 'daily' });
      clock = at(2);

      expect(await send(batchId)).toEqual({ kind: 'done', sent: false });
      expect((await batch(batchId))?.status).toBe('empty');
      expect(await row(id)).toMatchObject({ emailState: 'pending', emailBatchId: null });
    });
  });

  describe('the presence hold', () => {
    it('holds while they are online, and sends once they have been away five minutes', async () => {
      const batchId = await opened(await notify());
      presence.set(sam.id, 'online');
      clock = at(2);

      expect(await send(batchId)).toEqual({ kind: 'later', at: at(3) });
      expect(await batch(batchId)).toMatchObject({ heldSince: at(2), seenOnlineAt: at(2) });

      presence.set(sam.id, 'away');
      clock = at(3);
      expect(await send(batchId)).toEqual({ kind: 'later', at: at(7) });

      clock = at(7);
      expect(await send(batchId)).toEqual({ kind: 'done', sent: true });
    });

    it('sends after fifteen minutes however long they stay online (D-27)', async () => {
      const batchId = await opened(await notify());
      presence.set(sam.id, 'online');
      clock = at(2);
      await send(batchId);
      clock = at(10);
      expect(await send(batchId)).toEqual({ kind: 'later', at: at(11) });

      clock = at(17);
      expect(await send(batchId)).toEqual({ kind: 'done', sent: true });
    });

    it('moves the batch job to the hold’s end rather than spending an attempt', async () => {
      const batchId = await opened(await notify());
      presence.set(sam.id, 'online');
      clock = at(2);
      const moved: number[] = [];
      const processors = createEmailJobProcessors({
        db: runtime.db,
        engine,
        queue: bullEmailQueue(queue),
        log: silentLogger,
        now: () => clock,
      });
      const job = {
        id: notifyEmailBatchJobId(batchId),
        name: 'notify.email_batch',
        data: { brandId: seeded.brandId, batchId },
        moveToDelayed: async (timestamp: number) => void moved.push(timestamp),
      } as unknown as Job;

      await expect(processors['notify.email_batch'](job, 'token')).rejects.toBeInstanceOf(
        DelayedError,
      );
      expect(moved).toEqual([at(3).getTime()]);
    });
  });

  describe('digests', () => {
    it('opens a daily digest per brand at the person’s hour in their time zone, across a DST change', async () => {
      await setEmail({ emailSchedule: 'daily', digestHour: 8 });
      await runtime.db
        .update(brands)
        .set({ timezone: 'Europe/Berlin' })
        .where(eq(brands.id, seeded.brandId));

      clock = new Date('2026-10-24T05:00:00.000Z');
      const mine = await notify();
      const theirs = await notify({ brandId: otherBrand, ticket: otherTicketId });
      expect(await schedule(mine)).toBeNull();
      expect(await schedule(theirs, otherBrand)).toBeNull();

      // 08:00 in Berlin on the last day of summer time is 06:00 UTC.
      const summer = await tick(new Date('2026-10-24T06:00:00.000Z'));
      expect(summer).toHaveLength(1);
      // The other brand keeps UTC, where it is 06:00: not its hour.
      expect(await tick(new Date('2026-10-24T06:00:00.000Z'), otherBrand)).toEqual([]);
      await send(summer[0]?.batchId ?? '');
      expect(sent[0]?.subject).toMatch(/^\[.+\] Your daily digest for Sat 24 Oct$/);
      expect(sent[0]?.subject).not.toContain('Globex');

      clock = new Date('2026-10-25T05:30:00.000Z');
      await notify();
      // After the change, 06:00 UTC is 07:00 in Berlin, and 07:00 UTC is 08:00.
      expect(await tick(new Date('2026-10-25T06:00:00.000Z'))).toEqual([]);
      expect(await tick(new Date('2026-10-25T07:00:00.000Z'))).toHaveLength(1);

      const globex = await tick(new Date('2026-10-25T08:00:00.000Z'), otherBrand);
      expect(globex).toHaveLength(1);
      await send(globex[0]?.batchId ?? '', otherBrand);
      expect(sent.at(-1)?.subject).toBe('[Globex] Your daily digest for Sun 25 Oct');
    });

    it('does not send a second daily digest in a repeated local hour', async () => {
      await setEmail({ emailSchedule: 'daily', digestHour: 2 });
      await runtime.db
        .update(brands)
        .set({ timezone: 'Europe/Berlin' })
        .where(eq(brands.id, seeded.brandId));
      clock = new Date('2026-10-24T23:30:00.000Z');
      await notify();

      // 02:00 summer time, then 02:00 winter time an hour later.
      expect(await tick(new Date('2026-10-25T00:00:00.000Z'))).toHaveLength(1);
      clock = new Date('2026-10-25T00:30:00.000Z');
      await notify();
      expect(await tick(new Date('2026-10-25T01:00:00.000Z'))).toEqual([]);
    });

    it('sends the hourly digest at the top of the hour, counted against the caps', async () => {
      await setEmail({ emailSchedule: 'hourly' });
      await notify();
      await notify({ kind: 'assigned', actorId: ada.id });

      const [placement] = await tick(at(60));
      await send(placement?.batchId ?? '');

      expect(sent[0]?.subject).toMatch(/^\[.+\] Your hourly digest: 2 updates$/);
      expect(await pacing()).toMatchObject({ sentInHour: 1, step: 0 });
    });

    it('drops rows waiting for a digest once email is turned off', async () => {
      await setEmail({ emailSchedule: 'hourly' });
      const id = await notify();
      await setEmail({ emailSchedule: 'off' });

      expect(await tick(at(60))).toEqual([]);
      expect((await row(id))?.emailState).toBe('skipped_off');
    });
  });

  describe('the rebuild', () => {
    it('places every pending batch again after Redis is lost, and schedules orphaned rows', async () => {
      clock = new Date();
      const processors = createEmailJobProcessors({
        db: runtime.db,
        engine,
        queue: bullEmailQueue(queue),
        log: silentLogger,
        now: () => clock,
      });
      const id = await notify();
      await processors['notify.email_schedule']({
        id: `notify.email_schedule.${id}`,
        name: 'notify.email_schedule',
        data: { brandId: seeded.brandId, notificationId: id },
      } as Job);
      const batchId = (await row(id))?.emailBatchId ?? '';
      expect(await queue.getJob(notifyEmailBatchJobId(batchId))).toBeDefined();

      await redis.flushall();
      expect(await queue.getJob(notifyEmailBatchJobId(batchId))).toBeUndefined();
      // A row whose schedule job was lost with Redis.
      const orphan = await notify({ userId: kim.id });

      await processors['notify.email_rebuild']({
        id: 'notify.email_rebuild.test',
        name: 'notify.email_rebuild',
        data: { brandId: seeded.brandId },
      } as Job);

      const job = await queue.getJob(notifyEmailBatchJobId(batchId));
      expect(await job?.getState()).toBe('delayed');
      const orphanBatch = (await row(orphan))?.emailBatchId ?? null;
      expect(orphanBatch).not.toBeNull();
      expect(await queue.getJob(notifyEmailBatchJobId(orphanBatch ?? ''))).toBeDefined();
    });
  });
});
