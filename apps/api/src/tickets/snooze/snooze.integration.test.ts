import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  brands,
  createDb,
  type Db,
  type DbHandle,
  departments,
  notifications,
  outbox,
  ticketActivity,
  ticketSlaClocks,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  views,
  withSystem,
} from '@helpdock/db';
import {
  createQueueConnection,
  outboxEvents,
  QUEUE_NAMES,
  silentLogger,
  ticketUnsnoozeJobId,
} from '@helpdock/jobs';
import type {
  SlaPolicy,
  SnoozePresets,
  TicketDetail,
  TicketList,
  TicketStatusList,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { validateImportMappingTarget } from '../../imports/preflight/mapping-targets.js';
import { createLogger } from '../../logging/logger.js';
import { registerNotificationHandlers } from '../../notifications/notification-events.js';
import { NotificationsRepository } from '../../notifications/notifications.repository.js';
import { backfillBuiltInViews } from '../../seed/backfill-built-in-views.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';
import { fireSlaTimer } from '../../sla/escalation.js';
import { SlaRepository } from '../../sla/sla.repository.js';
import { SlaService } from '../../sla/sla.service.js';
import { bullTimerQueue } from '../../sla/sla-timers.js';
import type { SlaWorkerDeps } from '../../sla/sla-worker.js';
import { dockerAvailable } from '../../testing/docker-available.js';
import { signInForTest } from '../../testing/staff-sign-in.js';
import { TicketLifecycleHooks } from '../lifecycle/hooks.js';
import { TicketLifecycleRepository } from '../lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../lifecycle/lifecycle.service.js';
import { TicketRepository } from '../tickets.repository.js';
import {
  bullSnoozeQueue,
  createTicketSnoozedHandler,
  rebuildSnoozes,
  unsnoozeTicket,
} from './snooze-worker.js';

/**
 * M14-02 against a real Postgres and a real Redis, over real sessions: the
 * snooze and its timer, every way a snooze ends, the clocks while it lasts,
 * and a Redis that lost its timers.
 *
 * The wake paths are driven the way the worker drives them: the outbox row is
 * dispatched to the real handler, the job body is run with the job's payload,
 * and the SLA step is fired with `fireSlaTimer`.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M14-02 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface Refusal {
  readonly message?: string;
}

describe.skipIf(!hasDocker)('snooze', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let queue: Queue;

  let support: string;
  let billing: string;
  let awaiting: string;
  let open: string;
  let snoozedStatus: string;
  let closed: string;
  let ada: Person;
  /** An Agent who works Billing and nothing else. */
  let bea: Person;

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

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

  const brandPath = () => `/api/brands/${seeded.brandId}`;

  const addPerson = async (db: Db, who: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const id = uuidv7();
    const email = `${who}-${id}@helpdock.test`;
    await db.insert(users).values({
      id,
      email,
      name: who,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
    });
    return { id, email, token: '' };
  };

  const createTicket = async (body: Record<string, unknown> = {}): Promise<TicketDetail> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, ada, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      departmentId: support,
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body;
  };

  /** A ticket in a status other than the default: a ticket is created open and then moved. */
  const createIn = async (
    statusId: string,
    body: Record<string, unknown> = {},
  ): Promise<TicketDetail> => {
    const detail = await createTicket(body);
    const moved = await call('PATCH', `${brandPath()}/tickets/${detail.ticket.id}`, ada, {
      statusId,
    });
    expect(moved.status).toBe(200);
    return detail;
  };

  const snooze = (ticketId: string, until: Date | null, who: Person = ada) =>
    call<TicketDetail['ticket'] & Refusal>('PATCH', `${brandPath()}/tickets/${ticketId}`, who, {
      snoozedUntil: until === null ? null : until.toISOString(),
    });

  const rowOf = async (ticketId: string) => {
    const [row] = await owner.db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (row === undefined) {
      throw new Error(`no ticket ${ticketId}`);
    }
    return row;
  };

  const activityOf = async (ticketId: string, action: string) =>
    owner.db
      .select()
      .from(ticketActivity)
      .where(and(eq(ticketActivity.ticketId, ticketId), eq(ticketActivity.action, action)))
      .orderBy(asc(ticketActivity.createdAt));

  const outboxOf = async (event: string, ticketId: string) =>
    (
      await owner.db
        .select({ id: outbox.id, payload: outbox.payload })
        .from(outbox)
        .where(and(eq(outbox.event, event), sql`${outbox.payload}->>'ticketId' = ${ticketId}`))
        .orderBy(desc(outbox.createdAt))
    ).map((row) => ({ id: row.id, ...(row.payload as Record<string, unknown>) }));

  const clocksOf = (ticketId: string) =>
    owner.db
      .select()
      .from(ticketSlaClocks)
      .where(and(eq(ticketSlaClocks.ticketId, ticketId), eq(ticketSlaClocks.isCurrent, true)));

  const slaDeps = (): SlaWorkerDeps => {
    const repository = new SlaRepository();
    return {
      repository,
      sla: new SlaService(repository),
      assignment: { async none() {} } as never,
      timers: bullTimerQueue(queue),
      snoozeTimers: bullSnoozeQueue(queue),
    };
  };

  /** What the relay and the worker do with a ticket's `ticket.snoozed` row. */
  const planTimer = async (ticketId: string) => {
    const [latest] = await outboxOf('ticket.snoozed', ticketId);
    if (latest === undefined) {
      throw new Error('no ticket.snoozed row');
    }
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      createTicketSnoozedHandler(slaDeps())({
        outboxId: uuidv7(),
        brandId: seeded.brandId,
        event: 'ticket.snoozed',
        payload: latest,
        tx,
        log: silentLogger,
      }),
    );
    return latest;
  };

  const unsnooze = (ticketId: string, version: number, at: Date) =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      unsnoozeTicket(tx, slaDeps(), { brandId: seeded.brandId, ticketId, version }, at),
    );

  const lifecycle = new TicketLifecycleService(
    new TicketLifecycleRepository(),
    new TicketRepository(),
    new TicketLifecycleHooks(),
  );

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();
    const ownerUrl = new URL(postgres.getConnectionUri());
    ownerUrl.pathname = '/helpdock';
    owner = createDb({ url: ownerUrl.toString(), max: 2 });

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime });
    redis = createQueueConnection(redisContainer.getConnectionUrl());
    queue = new Queue(QUEUE_NAMES.sla, { connection: redis });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    bea = await addPerson(runtime.db, 'bea');

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });
      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';
      await tx.insert(userBrandRoles).values({
        userId: bea.id,
        brandId: seeded.brandId,
        role: 'agent',
        departmentIds: [billing],
      });
    });

    ada.token = await signInForTest(app, { email: seeded.email, password: seeded.password });
    bea.token = await signInForTest(app, { email: bea.email, password: PASSWORD });

    const statuses = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`, ada);
    awaiting = statuses.body.statuses.find((status) => status.awaitingCustomer)?.id ?? '';
    open = statuses.body.statuses.find((status) => status.isDefault)?.id ?? '';
    snoozedStatus = statuses.body.statuses.find((status) => status.isSnoozed === true)?.id ?? '';
    closed =
      statuses.body.statuses.find(
        (status) => status.systemState === 'closed' && !status.excludedFromReports,
      )?.id ?? '';
  }, 300_000);

  afterAll(async () => {
    await queue?.close();
    redis?.disconnect();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('the seeded status and view', () => {
    it('gives a brand a system Snoozed status that pauses SLA and is not awaiting the customer', async () => {
      const [row] = await owner.db
        .select()
        .from(ticketStatuses)
        .where(eq(ticketStatuses.id, snoozedStatus));

      expect(row).toMatchObject({
        systemKey: 'snoozed',
        systemState: 'on_hold',
        pausesSla: true,
        awaitingCustomer: false,
        isSystem: true,
        isDefault: false,
      });
    });

    it('writes the Snoozed view for a brand that lacks it at boot, once', async () => {
      const snoozedViews = () => owner.db.select().from(views).where(eq(views.builtIn, 'snoozed'));
      const second = uuidv7();
      const third = uuidv7();
      await owner.db.insert(brands).values([
        { id: second, name: 'Globex', prefix: 'GLX' },
        { id: third, name: 'Initech', prefix: 'INI' },
      ]);
      await owner.db.delete(views).where(eq(views.builtIn, 'snoozed'));
      expect(await snoozedViews()).toHaveLength(0);

      await backfillBuiltInViews(runtime.db);
      await backfillBuiltInViews(runtime.db);

      const rows = await snoozedViews();
      expect(rows.map((row) => row.brandId).sort()).toEqual([seeded.brandId, second, third].sort());
      expect(rows.every((row) => row.name === 'Snoozed')).toBe(true);
      expect(rows[0]?.filters).toMatchObject({ assigneeId: ['me'], snoozed: 'only' });
    });
  });

  describe('the presets', () => {
    it('answers the four times in order, in the future, with the department', async () => {
      const { ticket } = await createTicket();

      const response = await call<SnoozePresets>(
        'GET',
        `${brandPath()}/tickets/${ticket.id}/snooze-presets?timeZone=Europe/Berlin`,
        ada,
      );

      expect(response.status).toBe(200);
      expect(response.body.presets.map((preset) => preset.key)).toEqual([
        'in_1_hour',
        'in_4_hours',
        'next_business_day',
        'next_week',
      ]);
      expect(response.body.presets.every((preset) => Date.parse(preset.at) > Date.now())).toBe(
        true,
      );
      expect(response.body.departmentName).toBe('Support');
    });

    it('refuses a time zone that is not one, and says not found for another department’s ticket', async () => {
      const { ticket } = await createTicket({ departmentId: support });
      const path = `${brandPath()}/tickets/${ticket.id}/snooze-presets`;

      expect((await call('GET', `${path}?timeZone=Not/AZone`, ada)).status).toBe(400);
      expect((await call('GET', path, ada)).status).toBe(400);
      expect((await call('GET', `${path}?timeZone=UTC`, bea)).status).toBe(404);
    });
  });

  describe('merge and unmerge', () => {
    it('wakes a snoozed secondary on merge, and an unmerge puts it back awake where it would have woken', async () => {
      const secondary = (await createIn(awaiting)).ticket;
      const primary = (await createTicket()).ticket;
      await snooze(secondary.id, new Date(Date.now() + 3 * HOUR));

      const merged = await call('POST', `${brandPath()}/tickets/${secondary.id}/merge`, ada, {
        primaryTicketId: primary.id,
      });
      expect(merged.status).toBe(200);
      expect(await rowOf(secondary.id)).toMatchObject({
        snoozedUntil: null,
        snoozeResumeStatusId: null,
        preMergeStatusId: awaiting,
      });
      expect((await activityOf(secondary.id, 'ticket.woke'))[0]?.to).toMatchObject({
        reason: 'status_changed',
      });

      const back = await call('POST', `${brandPath()}/tickets/${secondary.id}/unmerge`, ada);
      expect(back.status).toBe(200);
      expect(await rowOf(secondary.id)).toMatchObject({ statusId: awaiting, snoozedUntil: null });
    });
  });

  describe('a Snoozed status without a wake time', () => {
    it('is refused as an import target, and a ticket found in it is repaired by Wake now', async () => {
      const scope = { brandId: seeded.brandId, source: 'zendesk' as const, runId: uuidv7() };
      const mapping = (statusId: string) =>
        ({ kind: 'status', externalValue: 'pending', target: { statusId } }) as const;

      expect(
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          validateImportMappingTarget(tx, scope, mapping(snoozedStatus)),
        ),
      ).toBe('target-missing');
      expect(
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          validateImportMappingTarget(tx, scope, mapping(open)),
        ),
      ).toBeNull();

      const { ticket } = await createTicket();
      await owner.db
        .update(tickets)
        .set({ statusId: snoozedStatus })
        .where(eq(tickets.id, ticket.id));
      const woke = await snooze(ticket.id, null);
      expect(woke.status).toBe(200);
      expect(woke.body.status.id).toBe(open);
    });
  });

  describe('snoozing', () => {
    it('moves the ticket to Snoozed, remembers where it was and who snoozed it, and queues the timer through the outbox', async () => {
      const { ticket } = await createIn(awaiting);
      const until = new Date(Date.now() + 4 * HOUR);

      const response = await snooze(ticket.id, until);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        snoozedUntil: until.toISOString(),
        snoozedBy: ada.id,
        status: { id: snoozedStatus, isSnoozed: true },
      });
      const row = await rowOf(ticket.id);
      expect(row).toMatchObject({
        statusId: snoozedStatus,
        snoozeResumeStatusId: awaiting,
        snoozedBy: ada.id,
        snoozeVersion: 1,
      });
      const [snoozedRow] = await activityOf(ticket.id, 'ticket.snoozed');
      expect(snoozedRow).toMatchObject({
        actorId: ada.id,
        from: { snoozedUntil: null },
        to: { snoozedUntil: until.toISOString(), resumeStatusId: awaiting },
      });
      const planned = await planTimer(ticket.id);
      expect(planned).toMatchObject({ version: 1, snoozedUntil: until.toISOString() });
      const job = await queue.getJob(ticketUnsnoozeJobId({ ticketId: ticket.id, version: 1 }));
      expect(job?.data).toEqual({ brandId: seeded.brandId, ticketId: ticket.id, version: 1 });
      expect(job?.opts.delay).toBeGreaterThan(3 * HOUR);
    });

    it('moves the time of a snooze without losing the status before it, and supersedes the old timer', async () => {
      const { ticket } = await createTicket();
      await snooze(ticket.id, new Date(Date.now() + 2 * HOUR));
      await planTimer(ticket.id);
      const later = new Date(Date.now() + 6 * HOUR);

      const response = await snooze(ticket.id, later);

      expect(response.status).toBe(200);
      expect(await rowOf(ticket.id)).toMatchObject({
        snoozeResumeStatusId: open,
        snoozeVersion: 2,
      });
      await planTimer(ticket.id);
      expect(
        await queue.getJob(ticketUnsnoozeJobId({ ticketId: ticket.id, version: 1 })),
      ).toBeUndefined();
      expect(
        await queue.getJob(ticketUnsnoozeJobId({ ticketId: ticket.id, version: 2 })),
      ).toBeDefined();
    });

    it('refuses a time too soon or too far ahead, a closed ticket, and the bare status', async () => {
      const { ticket } = await createTicket();

      expect((await snooze(ticket.id, new Date(Date.now() + MINUTE))).status).toBe(400);
      expect((await snooze(ticket.id, new Date(Date.now() + 91 * 24 * HOUR))).status).toBe(400);
      const bare = await call<Refusal>('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
        statusId: snoozedStatus,
      });
      expect(bare.status).toBe(409);
      await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId: closed });
      expect((await snooze(ticket.id, new Date(Date.now() + 2 * HOUR))).status).toBe(409);
      expect(await activityOf(ticket.id, 'ticket.snoozed')).toHaveLength(0);
      expect((await rowOf(ticket.id)).snoozedUntil).toBeNull();
    });

    it('does not let an Agent of another department snooze it, and says no more than not found', async () => {
      const { ticket } = await createTicket({ departmentId: support });

      const response = await snooze(ticket.id, new Date(Date.now() + 2 * HOUR), bea);

      expect(response.status).toBe(404);
      expect((await rowOf(ticket.id)).snoozedUntil).toBeNull();
    });
  });

  describe('lists', () => {
    it('leaves a snoozed ticket out by default, shows it for only and include, and still finds it by number', async () => {
      const { ticket } = await createTicket({ subject: 'Snooze list probe' });
      await snooze(ticket.id, new Date(Date.now() + 2 * HOUR));
      const ids = async (query: string) =>
        (
          await call<TicketList>('GET', `${brandPath()}/tickets?limit=100${query}`, ada)
        ).body.tickets.map((row) => row.id);

      expect(await ids('')).not.toContain(ticket.id);
      expect(await ids('&snoozed=exclude')).not.toContain(ticket.id);
      expect(await ids('&snoozed=only')).toContain(ticket.id);
      expect(await ids('&snoozed=include')).toContain(ticket.id);
      expect(await ids(`&q=${ticket.prefix}-${ticket.number}`)).toContain(ticket.id);
      expect(await ids(`&q=${ticket.number}`)).toContain(ticket.id);
      expect(await ids('&snoozed=only&assigneeId=me')).not.toContain(ticket.id);
    });
  });

  describe('waking', () => {
    it('wakes by time into the status before, once, and tells the assignee', async () => {
      const { ticket } = await createIn(awaiting, { assigneeId: ada.id });
      const until = new Date(Date.now() + 2 * HOUR);
      await snooze(ticket.id, until);
      const version = (await rowOf(ticket.id)).snoozeVersion;

      expect(await unsnooze(ticket.id, version, new Date(until.getTime() - HOUR))).toMatchObject({
        kind: 'early',
      });
      expect(await unsnooze(ticket.id, version, new Date(until.getTime() + MINUTE))).toEqual({
        kind: 'woke',
      });

      expect(await rowOf(ticket.id)).toMatchObject({
        statusId: awaiting,
        snoozedUntil: null,
        snoozedBy: null,
        snoozeResumeStatusId: null,
      });
      const [woke] = await activityOf(ticket.id, 'ticket.woke');
      expect(woke).toMatchObject({
        actorType: 'system',
        actorId: 'snooze',
        to: { statusId: awaiting, reason: 'time' },
      });
      const [ended] = await outboxOf('ticket.snooze_ended', ticket.id);
      expect(ended).toMatchObject({ cause: 'time', snoozedBy: ada.id });

      // Running the job again, or an older one, does nothing.
      expect(await unsnooze(ticket.id, version, new Date(until.getTime() + 2 * MINUTE))).toEqual({
        kind: 'noop',
      });
      expect(await activityOf(ticket.id, 'ticket.woke')).toHaveLength(1);
      expect(await outboxOf('ticket.snooze_ended', ticket.id)).toHaveLength(1);
    });

    it('turns the wake into a snooze_ended notification for the assignee only', async () => {
      const { ticket } = await createTicket({ assigneeId: ada.id });
      const until = new Date(Date.now() + 2 * HOUR);
      await snooze(ticket.id, until);
      await unsnooze(
        ticket.id,
        (await rowOf(ticket.id)).snoozeVersion,
        new Date(until.getTime() + MINUTE),
      );
      const [ended] = await outboxOf('ticket.snooze_ended', ticket.id);
      registerNotificationHandlers({
        repository: new NotificationsRepository(),
        broadcast: { emit: async () => {} },
        pushConfigured: async () => false,
        addEmailSchedule: async () => {},
        addPush: async () => {},
      } as never);

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        outboxEvents.dispatch({
          outboxId: ended?.id ?? '',
          brandId: seeded.brandId,
          event: 'ticket.snooze_ended',
          payload: { ticketId: ticket.id, departmentId: support, cause: 'time', snoozedBy: ada.id },
          tx,
          log: silentLogger,
        }),
      );

      const rows = await owner.db
        .select()
        .from(notifications)
        .where(eq(notifications.ticketId, ticket.id));
      expect(rows).toEqual([
        expect.objectContaining({
          userId: ada.id,
          kind: 'snooze_ended',
          detail: { wokeBy: 'time' },
        }),
      ]);
    });

    it('wakes on a customer reply into the default open status, and the timer then finds nothing to do', async () => {
      const { ticket } = await createIn(awaiting);
      await snooze(ticket.id, new Date(Date.now() + 5 * HOUR));
      const snoozedRow = await rowOf(ticket.id);

      const landing = await withSystem(runtime.db, seeded.brandId, async (tx) => {
        const tickets = new TicketRepository();
        const found = await tickets.findTicket(tx, ticket.id);
        if (found === undefined) {
          throw new Error('the ticket vanished');
        }
        return lifecycle.onCustomerReply(
          {
            tx,
            brandId: seeded.brandId,
            actor: { actorType: 'system', actorId: 'inbound', via: 'system' },
            now: new Date(),
          },
          found.ticket,
          found.status,
          { channel: 'email' } as never,
        );
      });

      expect(landing.status.id).toBe(open);
      expect(await rowOf(ticket.id)).toMatchObject({
        statusId: open,
        snoozedUntil: null,
        snoozeResumeStatusId: null,
      });
      const [woke] = await activityOf(ticket.id, 'ticket.woke');
      expect(woke).toMatchObject({ to: { statusId: open, reason: 'customer_reply' } });
      expect(
        await unsnooze(ticket.id, snoozedRow.snoozeVersion, new Date(Date.now() + 6 * HOUR)),
      ).toEqual({ kind: 'noop' });
      // A customer's reply is not "snooze ended" news: they are the news.
      expect(await outboxOf('ticket.snooze_ended', ticket.id)).toHaveLength(0);
    });

    it('wakes when a person picks another status, and by Wake now, each with its reason', async () => {
      const first = (await createTicket()).ticket;
      await snooze(first.id, new Date(Date.now() + 3 * HOUR));
      const picked = await call<TicketDetail['ticket']>(
        'PATCH',
        `${brandPath()}/tickets/${first.id}`,
        ada,
        { statusId: awaiting },
      );
      expect(picked.body).toMatchObject({ snoozedUntil: null, status: { id: awaiting } });
      expect((await activityOf(first.id, 'ticket.woke'))[0]?.to).toMatchObject({
        reason: 'status_changed',
      });

      const second = (await createIn(awaiting)).ticket;
      await snooze(second.id, new Date(Date.now() + 3 * HOUR));
      const woke = await snooze(second.id, null);
      expect(woke.body).toMatchObject({ snoozedUntil: null, status: { id: awaiting } });
      expect((await activityOf(second.id, 'ticket.woke'))[0]?.to).toMatchObject({
        reason: 'manual',
      });
      // Waking a ticket that is not asleep is nothing.
      expect((await snooze(second.id, null)).status).toBe(200);
      expect(await activityOf(second.id, 'ticket.woke')).toHaveLength(1);
    });

    it('clears the snooze whichever code path moves the status, and marks spam and closes with their reason', async () => {
      const direct = (await createTicket()).ticket;
      await snooze(direct.id, new Date(Date.now() + 3 * HOUR));
      const before = await rowOf(direct.id);
      // Not through the api: a writer that never heard of snooze.
      await owner.db.update(tickets).set({ statusId: closed }).where(eq(tickets.id, direct.id));
      const after = await rowOf(direct.id);
      expect(after).toMatchObject({
        snoozedUntil: null,
        snoozedBy: null,
        snoozeResumeStatusId: null,
        snoozeVersion: before.snoozeVersion + 1,
      });

      const spammed = (await createTicket()).ticket;
      await snooze(spammed.id, new Date(Date.now() + 3 * HOUR));
      const marked = await call('POST', `${brandPath()}/tickets/${spammed.id}/spam`, ada, {
        blockSender: false,
      });
      expect(marked.status).toBeLessThan(300);
      expect((await rowOf(spammed.id)).snoozedUntil).toBeNull();
      expect((await activityOf(spammed.id, 'ticket.woke'))[0]?.to).toMatchObject({
        reason: 'status_changed',
      });

      const closing = (await createTicket()).ticket;
      await snooze(closing.id, new Date(Date.now() + 3 * HOUR));
      await call('PATCH', `${brandPath()}/tickets/${closing.id}`, ada, { statusId: closed });
      expect((await rowOf(closing.id)).snoozedUntil).toBeNull();
      expect((await activityOf(closing.id, 'ticket.woke'))[0]?.to).toMatchObject({
        reason: 'status_changed',
      });
    });
  });

  describe('the clocks', () => {
    let policy: SlaPolicy;

    beforeAll(async () => {
      const created = await call<SlaPolicy>('POST', `${brandPath()}/sla-policies`, ada, {
        name: 'Support, every minute',
        conditions: [{ field: 'department', operator: 'any', values: [support] }],
        timeMode: 'calendar',
        targets: {
          low: { firstResponseMinutes: 60, resolutionMinutes: 480 },
          medium: { firstResponseMinutes: 60, resolutionMinutes: 480 },
          high: { firstResponseMinutes: 30, resolutionMinutes: 240 },
          urgent: { firstResponseMinutes: 15, resolutionMinutes: 120 },
        },
        escalation: [
          { atPercent: 50, actions: [{ type: 'notify', recipient: { kind: 'department_leads' } }] },
        ],
      });
      expect(created.status).toBe(201);
      policy = created.body;
    });

    it('pauses the resolution clock and leaves the unanswered first-response clock running', async () => {
      const { ticket } = await createTicket();
      expect(policy.id).toBeTruthy();
      expect((await clocksOf(ticket.id)).map((clock) => clock.pausedAt)).toEqual([null, null]);

      await snooze(ticket.id, new Date(Date.now() + 3 * HOUR));

      const clocks = await clocksOf(ticket.id);
      const response = clocks.find((clock) => clock.kind === 'first_response');
      const resolution = clocks.find((clock) => clock.kind === 'resolution');
      expect(response?.pausedAt).toBeNull();
      expect(response?.dueAt).not.toBeNull();
      expect(resolution?.pausedAt).not.toBeNull();
      expect(resolution?.dueAt).toBeNull();
      const row = await rowOf(ticket.id);
      expect(row.firstResponseDueAt).not.toBeNull();
      expect(row.resolutionDueAt).toBeNull();
    });

    it('wakes the ticket when a response clock reaches a step, into the status before, with the reason sla', async () => {
      const { ticket } = await createTicket();
      await snooze(ticket.id, new Date(Date.now() + 5 * HOUR));
      const due = (await clocksOf(ticket.id)).find((row) => row.kind === 'first_response')?.dueAt;

      const outcome = await withSystem(runtime.db, seeded.brandId, (tx) =>
        fireSlaTimer(
          tx,
          slaDeps(),
          {
            brandId: seeded.brandId,
            ticketId: ticket.id,
            clock: 'first_response',
            stepPercent: 100,
          },
          new Date((due?.getTime() ?? 0) + MINUTE),
        ),
      );

      expect(outcome).toEqual({ kind: 'fired' });
      expect(await rowOf(ticket.id)).toMatchObject({ statusId: open, snoozedUntil: null });
      expect((await activityOf(ticket.id, 'ticket.woke'))[0]).toMatchObject({
        actorId: 'sla',
        to: { statusId: open, reason: 'sla' },
      });
      expect((await outboxOf('ticket.snooze_ended', ticket.id))[0]).toMatchObject({ cause: 'sla' });
      // The resolution clock runs again now the ticket is awake.
      const resolution = (await clocksOf(ticket.id)).find((row) => row.kind === 'resolution');
      expect(resolution?.pausedAt).toBeNull();
    });
  });

  describe('a long outage', () => {
    it('wakes every overdue snooze across batches, one transaction per batch', async () => {
      const made = await Promise.all([1, 2, 3, 4, 5].map(() => createTicket()));
      for (const { ticket } of made) {
        await snooze(ticket.id, new Date(Date.now() + 2 * HOUR));
      }
      const ids = made.map(({ ticket }) => ticket.id);
      await owner.db
        .update(tickets)
        .set({ snoozedUntil: new Date(Date.now() - HOUR) })
        .where(
          sql`${tickets.id} IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        );

      let after: string | undefined;
      let batches = 0;
      let woke = 0;
      do {
        const cursor = after;
        const result = await withSystem(runtime.db, seeded.brandId, (tx) =>
          rebuildSnoozes(tx, { ...slaDeps(), batchSize: 2 }, seeded.brandId, cursor),
        );
        batches += 1;
        woke += result.woke;
        after = result.next;
      } while (after !== undefined);

      // Other tests leave snoozed tickets behind, so at least three batches of two.
      expect(batches).toBeGreaterThanOrEqual(3);
      expect(woke).toBeGreaterThanOrEqual(5);
      for (const id of ids) {
        expect((await rowOf(id)).snoozedUntil).toBeNull();
      }
    });
  });

  describe('a Redis that lost its timers', () => {
    it('wakes what is already due and re-adds the timer of what is not', async () => {
      const due = (await createTicket({ subject: 'Overdue snooze' })).ticket;
      const later = (await createTicket({ subject: 'Later snooze' })).ticket;
      await snooze(due.id, new Date(Date.now() + 2 * HOUR));
      await snooze(later.id, new Date(Date.now() + 8 * HOUR));
      await planTimer(due.id);
      await planTimer(later.id);
      // The relay was down for hours, and then Redis was lost.
      await owner.db
        .update(tickets)
        .set({ snoozedUntil: new Date(Date.now() - 10 * MINUTE) })
        .where(eq(tickets.id, due.id));
      await queue.obliterate({ force: true });
      expect(
        await queue.getJob(ticketUnsnoozeJobId({ ticketId: later.id, version: 1 })),
      ).toBeUndefined();

      const result = await withSystem(runtime.db, seeded.brandId, (tx) =>
        rebuildSnoozes(tx, slaDeps(), seeded.brandId),
      );
      expect(result.next).toBeUndefined();

      expect(result.woke).toBeGreaterThanOrEqual(1);
      expect(result.scheduled).toBeGreaterThanOrEqual(1);
      expect((await rowOf(due.id)).snoozedUntil).toBeNull();
      expect((await activityOf(due.id, 'ticket.woke'))[0]?.to).toMatchObject({ reason: 'time' });
      const job = await queue.getJob(ticketUnsnoozeJobId({ ticketId: later.id, version: 1 }));
      expect(job?.opts.delay).toBeGreaterThan(7 * HOUR);
      expect((await rowOf(later.id)).snoozedUntil).not.toBeNull();
    });
  });
});
