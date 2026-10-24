import { setTimeout as waitForLock } from 'node:timers/promises';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  type Db,
  type DbHandle,
  type DbTransaction,
  departments,
  importExternalIds,
  importRuns,
  notifications,
  outbox,
  tags,
  ticketActivity,
  ticketSlaClocks,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  createQueueConnection,
  outboxEvents,
  QUEUE_NAMES,
  silentLogger,
  slaTimerJobId,
} from '@helpdock/jobs';
import {
  type BrandSettings,
  type BusinessHoursOverview,
  type Holiday,
  type ImportSlaOverview,
  importSlaActivationStateSchema,
  isWithinBusinessHours,
  REALTIME_EVENTS,
  type SlaPolicy,
  type SlaPolicyList,
  type TicketDetail,
  type TicketList,
  type TicketStatusList,
  userRoom,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { activateImportedSlaBatch } from '../imports/jobs/activate-sla.js';
import { createLogger } from '../logging/logger.js';
import { registerNotificationHandlers } from '../notifications/notification-events.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import type { RealtimeBroadcastInput } from '../realtime/broadcast.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../tickets/lifecycle/lifecycle.service.js';
import { TICKET_STATUS_STATE_RESYNC_EVENT } from '../tickets/lifecycle/status-state-events.js';
import { repairClosedStatusTickets } from '../tickets/lifecycle/status-state-repair.js';
import { createStatusStateResyncHandler } from '../tickets/lifecycle/status-state-worker.js';
import { TicketingSettingsService } from '../tickets/lifecycle/ticketing-settings.service.js';
import { bullSnoozeQueue } from '../tickets/snooze/snooze-worker.js';
import { TicketRepository } from '../tickets/tickets.repository.js';
import { workerDependencies } from '../worker/start-worker.js';
import { BusinessHoursService } from './business-hours.service.js';
import { fireSlaTimer } from './escalation.js';
import { SlaRepository } from './sla.repository.js';
import { SlaService } from './sla.service.js';
import { SLA_SCHEDULE_EVENT, SLA_STATUS_RESYNC_EVENT } from './sla-events.js';
import { SlaLifecycleHooks } from './sla-hooks.js';
import { bullTimerQueue } from './sla-timers.js';
import {
  createSlaScheduleHandler,
  createSlaStatusResyncHandler,
  type SlaWorkerDeps,
} from './sla-worker.js';

/**
 * M3-01 and M3-02 against a real Postgres and a real Redis, over real
 * sessions: the two tabs, the clocks as the ticket routes move them, the
 * escalation a timer runs, and two M3 exit criteria — "deleting Redis while
 * tickets are open and restarting the worker recreates every timer", and "an
 * SLA breach fires escalation and a notification, and pauses correctly on
 * Awaiting customer", through M3-07's real handlers.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
const PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;
const MINUTE = 60_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M3-01/M3-02 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface Refusal {
  readonly error: { readonly ticketing?: { readonly reason: string } };
}

const target = (firstResponseMinutes: number, resolutionMinutes: number) => ({
  firstResponseMinutes,
  resolutionMinutes,
});

const allDay = () => [{ start: '00:00', end: '24:00' }];

describe.skipIf(!hasDocker)('SLA engine', () => {
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
  let closed: string;
  let ada: Person;
  /** A Team Leader who leads Billing and nothing else. */
  let tess: Person;
  let sam: Person;

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

  const signIn = (email: string, password: string): Promise<string> =>
    signInForTest(app, { email, password });

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

  const policyBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Support, every minute',
    conditions: [{ field: 'department', operator: 'any', values: [support] }],
    timeMode: 'calendar',
    targets: {
      low: target(60, 480),
      medium: target(60, 480),
      high: target(30, 240),
      urgent: target(15, 120),
    },
    escalation: [
      {
        atPercent: 50,
        actions: [{ type: 'notify', recipient: { kind: 'department_leads' } }],
      },
      { atPercent: 100, actions: [{ type: 'set_escalated' }] },
      { atPercent: 150, actions: [{ type: 'raise_priority' }, { type: 'add_tag', tagId: '' }] },
    ],
    ...overrides,
  });

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

  const clocksOf = (ticketId: string) =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select()
        .from(ticketSlaClocks)
        .where(and(eq(ticketSlaClocks.ticketId, ticketId), eq(ticketSlaClocks.isCurrent, true))),
    );

  const clockOf = async (ticketId: string, kind: string) => {
    const clock = (await clocksOf(ticketId)).find((row) => row.kind === kind);
    if (clock === undefined) {
      throw new Error(`no current ${kind} clock on ${ticketId}`);
    }
    return clock;
  };

  const outboxOf = (event: string) =>
    withSystem(runtime.db, seeded.brandId, async (tx) =>
      (
        await tx
          .select({ payload: outbox.payload })
          .from(outbox)
          .where(eq(outbox.event, event))
          .orderBy(desc(outbox.createdAt))
      ).map((row) => row.payload),
    );

  /** Whether another transaction is queued on a `tickets … FOR UPDATE`, within ten seconds. */
  const somebodyWaitsForATicketLock = async (): Promise<boolean> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [observed] = await owner.db.execute(sql`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%tickets%FOR UPDATE%') AS waiting
      `);
      if (observed?.waiting === true) {
        return true;
      }
      await waitForLock(20);
    }
    return false;
  };

  const slaDeps = (): SlaWorkerDeps => {
    const repository = new SlaRepository();
    return {
      repository,
      sla: new SlaService(repository),
      assignment: new AssignmentRepository(),
      timers: bullTimerQueue(queue),
      snoozeTimers: bullSnoozeQueue(queue),
    };
  };

  /** What the relay and the worker do with a ticket's `sla.schedule` row. */
  const schedule = (ticketIds: string[]) =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      createSlaScheduleHandler(slaDeps())({
        outboxId: uuidv7(),
        brandId: seeded.brandId,
        event: SLA_SCHEDULE_EVENT,
        payload: { ticketIds },
        tx,
        log: silentLogger,
      }),
    );

  let policy: SlaPolicy;
  let tagId: string;

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
    tess = await addPerson(runtime.db, 'tess');
    sam = await addPerson(runtime.db, 'sam');

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
      const [tag] = await tx
        .insert(tags)
        .values({ brandId: seeded.brandId, name: 'sla-overdue', color: 'warning' })
        .returning({ id: tags.id });
      tagId = tag?.id ?? '';

      await tx.insert(userBrandRoles).values([
        { userId: tess.id, brandId: seeded.brandId, role: 'team_leader', departmentIds: [billing] },
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
      ]);
    });

    ada.token = await signIn(seeded.email, seeded.password);
    tess.token = await signIn(tess.email, PASSWORD);
    sam.token = await signIn(sam.email, PASSWORD);

    const statuses = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`, ada);
    awaiting = statuses.body.statuses.find((status) => status.awaitingCustomer)?.id ?? '';
    open = statuses.body.statuses.find((status) => status.isDefault)?.id ?? '';
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

  // ------------------------------------------------------------ M3-01

  describe('business hours', () => {
    it('starts a brand on the default week in its own zone', async () => {
      const response = await call<BusinessHoursOverview>(
        'GET',
        `${brandPath()}/business-hours`,
        ada,
      );

      expect(response.status).toBe(200);
      expect(response.body.brand.weekly.map((day) => day.length)).toEqual([0, 1, 1, 1, 1, 1, 0]);
      expect(response.body.departments.map((row) => row.departmentId)).toEqual(
        expect.arrayContaining([support, billing]),
      );
    });

    it('saves the brand hours and a department override for an Admin', async () => {
      const response = await call<BusinessHoursOverview>(
        'PUT',
        `${brandPath()}/business-hours`,
        ada,
        {
          brand: {
            timezone: 'Asia/Riyadh',
            weekly: [allDay(), allDay(), allDay(), allDay(), allDay(), allDay(), allDay()],
          },
          departments: [
            {
              departmentId: billing,
              override: {
                timezone: 'Asia/Dubai',
                weekly: [[{ start: '09:00', end: '17:00' }], [], [], [], [], [], []],
              },
            },
          ],
        },
      );

      expect(response.status).toBe(200);
      expect(response.body.brand.timezone).toBe('Asia/Riyadh');
      expect(
        response.body.departments.find((row) => row.departmentId === billing)?.override?.timezone,
      ).toBe('Asia/Dubai');
    });

    it('refuses a Team Leader the brand hours, lets them change a department they lead, and refuses an Agent', async () => {
      const current = (
        await call<BusinessHoursOverview>('GET', `${brandPath()}/business-hours`, ada)
      ).body;

      const brandWide = await call<Refusal>('PUT', `${brandPath()}/business-hours`, tess, {
        brand: { ...current.brand, timezone: 'UTC' },
        departments: [],
      });
      expect(brandWide.status).toBe(403);
      expect(brandWide.body.error.ticketing?.reason).toBe('out-of-scope');

      const own = await call<BusinessHoursOverview>('PUT', `${brandPath()}/business-hours`, tess, {
        brand: current.brand,
        departments: [{ departmentId: billing, override: null }],
      });
      expect(own.status).toBe(200);
      expect(own.body.departments.find((row) => row.departmentId === billing)?.override).toBeNull();

      const other = await call<Refusal>('PUT', `${brandPath()}/business-hours`, tess, {
        brand: current.brand,
        departments: [{ departmentId: support, override: current.brand }],
      });
      expect(other.status).toBe(403);

      expect((await call('GET', `${brandPath()}/business-hours`, sam)).status).toBe(403);
    });

    it('refuses a range that ends before it starts and a department of no brand', async () => {
      const bad = await call('PUT', `${brandPath()}/business-hours`, ada, {
        brand: {
          timezone: 'UTC',
          weekly: [[{ start: '17:00', end: '09:00' }], [], [], [], [], [], []],
        },
        departments: [],
      });
      expect(bad.status).toBe(400);

      const stranger = await call('PUT', `${brandPath()}/business-hours`, ada, {
        brand: {
          timezone: 'Asia/Riyadh',
          weekly: [allDay(), allDay(), allDay(), allDay(), allDay(), allDay(), allDay()],
        },
        departments: [{ departmentId: uuidv7(), override: null }],
      });
      expect(stranger.status).toBe(404);
    });

    it('answers calendarFor with the department override, or the brand’s hours', async () => {
      const hours = new BusinessHoursService(
        new SlaRepository(),
        new SlaService(new SlaRepository()),
      );
      await call('PUT', `${brandPath()}/business-hours`, ada, {
        brand: {
          timezone: 'Asia/Riyadh',
          weekly: [allDay(), allDay(), allDay(), allDay(), allDay(), allDay(), allDay()],
        },
        departments: [
          {
            departmentId: billing,
            override: {
              timezone: 'Asia/Dubai',
              weekly: [[{ start: '09:00', end: '17:00' }], [], [], [], [], [], []],
            },
          },
        ],
      });

      const [own, brand] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        Promise.all([
          hours.calendarFor(seeded.brandId, billing, tx),
          hours.calendarFor(seeded.brandId, null, tx),
        ]),
      );
      expect(own).toMatchObject({ timezone: 'Asia/Dubai' });
      expect(isWithinBusinessHours(own, new Date('2026-10-04T06:00:00Z'))).toBe(true);
      expect(isWithinBusinessHours(own, new Date('2026-10-05T06:00:00Z'))).toBe(false);
      expect(brand).toMatchObject({ timezone: 'Asia/Riyadh' });

      await call('PUT', `${brandPath()}/business-hours`, ada, {
        brand: {
          timezone: 'Asia/Riyadh',
          weekly: [allDay(), allDay(), allDay(), allDay(), allDay(), allDay(), allDay()],
        },
        departments: [{ departmentId: billing, override: null }],
      });
    });

    it('adds and removes holidays, a brand-wide one for the Admin only', async () => {
      const refused = await call<Refusal>('POST', `${brandPath()}/holidays`, tess, {
        name: 'Founding Day',
        startsOn: '2027-02-22',
      });
      expect(refused.status).toBe(403);

      const own = await call<Holiday>('POST', `${brandPath()}/holidays`, tess, {
        name: 'Stock count',
        startsOn: '2026-12-30',
        departmentId: billing,
      });
      expect(own.status).toBe(201);
      expect(own.body).toMatchObject({ endsOn: '2026-12-30', departmentId: billing });

      const created = await call<Holiday>('POST', `${brandPath()}/holidays`, ada, {
        name: 'Eid al-Fitr',
        startsOn: '2027-03-09',
        endsOn: '2027-03-11',
      });
      expect(created.status).toBe(201);

      expect(
        (await call('DELETE', `${brandPath()}/holidays/${created.body.id}`, tess)).status,
      ).toBe(403);
      expect((await call('DELETE', `${brandPath()}/holidays/${created.body.id}`, ada)).status).toBe(
        204,
      );
      expect((await call('DELETE', `${brandPath()}/holidays/${created.body.id}`, ada)).status).toBe(
        404,
      );
      expect((await call('DELETE', `${brandPath()}/holidays/${own.body.id}`, tess)).status).toBe(
        204,
      );
    });
  });

  // ------------------------------------------------------------ policies

  describe('SLA policies', () => {
    it('creates a policy and lists it with who changed it', async () => {
      const body = policyBody();
      body.escalation[2] = {
        atPercent: 150,
        actions: [{ type: 'raise_priority' }, { type: 'add_tag', tagId }],
      };
      const created = await call<SlaPolicy>('POST', `${brandPath()}/sla-policies`, ada, body);
      expect(created.status).toBe(201);
      policy = created.body;

      const list = await call<SlaPolicyList>('GET', `${brandPath()}/sla-policies`, ada);
      expect(list.body.policies.map((row) => row.id)).toEqual([policy.id]);
      expect(list.body.policies[0]?.updatedBy?.id).toBe(ada.id);
    });

    it('lets a Team Leader own a policy confined to departments they lead, and nothing wider', async () => {
      const wide = await call<Refusal>('POST', `${brandPath()}/sla-policies`, tess, {
        ...policyBody({ name: 'Everything', conditions: [] }),
        escalation: [],
      });
      expect(wide.status).toBe(403);

      const own = await call<SlaPolicy>('POST', `${brandPath()}/sla-policies`, tess, {
        ...policyBody({
          name: 'Billing',
          conditions: [{ field: 'department', operator: 'any', values: [billing] }],
        }),
        escalation: [],
      });
      expect(own.status).toBe(201);

      const reorder = await call<Refusal>('POST', `${brandPath()}/sla-policies/reorder`, tess, {
        policyIds: [own.body.id, policy.id],
      });
      expect(reorder.status).toBe(403);
      expect((await call('DELETE', `${brandPath()}/sla-policies/${policy.id}`, tess)).status).toBe(
        403,
      );
      expect(
        (await call('DELETE', `${brandPath()}/sla-policies/${own.body.id}`, tess)).status,
      ).toBe(204);
    });

    it('refuses a department that is not the brand’s and an unknown policy', async () => {
      const stranger = await call('POST', `${brandPath()}/sla-policies`, ada, {
        ...policyBody({
          conditions: [{ field: 'department', operator: 'any', values: [uuidv7()] }],
        }),
        escalation: [],
      });
      expect(stranger.status).toBe(404);
      expect(
        (
          await call('PUT', `${brandPath()}/sla-policies/${uuidv7()}`, ada, {
            ...policyBody(),
            escalation: [],
          })
        ).status,
      ).toBe(404);
    });

    it('saves the settings for every policy', async () => {
      const response = await call<BrandSettings>(
        'PATCH',
        `${brandPath()}/ticketing/sla-settings`,
        ada,
        {
          aiCountsAsFirstResponse: false,
          slaCountReopens: true,
        },
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        aiCountsAsFirstResponse: false,
        slaCountReopens: true,
      });
    });
  });

  // ------------------------------------------------------------ the clocks

  describe('clocks', () => {
    it('activates a completed source account after staging retention, resumes a cursor and excludes later/foreign/live tickets', async () => {
      const runId = uuidv7();
      const account = 'a'.repeat(64);
      const ids = Array.from({ length: 58 }, () => uuidv7());
      const completedAt = new Date('2019-01-01T00:00:00Z');
      try {
        await owner.db.insert(importRuns).values({
          id: runId,
          brandId: seeded.brandId,
          source: 'zendesk',
          sourceAccountKey: account,
          status: 'completed',
          finishedAt: completedAt,
          startedBy: ada.id,
        });
        await owner.db.insert(tickets).values(
          ids.map((id, index) => ({
            id,
            brandId: seeded.brandId,
            departmentId: support,
            number: 2000000 + index,
            prefix: 'ACT',
            subject: `Activation ${index}`,
            statusId: index === 55 ? closed : open,
            deletedAt: index === 56 ? new Date() : null,
            mergedIntoId: index === 57 ? (ids[0] ?? null) : null,
            channel: 'manual' as const,
            createdAt: new Date('2000-01-01T00:00:00Z'),
            importedAt: index === 53 ? null : new Date('2010-01-01T00:00:00Z'),
            importSource: index === 53 ? null : ('zendesk' as const),
          })),
        );
        await owner.db.insert(importExternalIds).values(
          ids.map((id, index) => ({
            brandId: seeded.brandId,
            source: 'zendesk' as const,
            sourceAccountKey: index === 52 ? 'b'.repeat(64) : account,
            entity: 'ticket' as const,
            externalId: id,
            helpdockId: id,
            payloadHash: 'f'.repeat(64),
          })),
        );
        const path = `${brandPath()}/imports/${runId}/sla`;
        expect((await call('POST', `${path}/start`, ada, { acknowledge: false })).status).toBe(400);
        const requested = await call<ImportSlaOverview>('POST', `${path}/start`, ada, {
          acknowledge: true,
        });
        expect(requested.status).toBe(200);
        expect(requested.body.activation?.status).toBe('queued');
        const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
        const initial = importSlaActivationStateSchema.parse(run?.options.slaActivation);
        // This ticket arrived after the explicit request, so it retains the default even within the same account.
        const laterId = ids[54];
        if (!laterId) throw new Error('Missing activation fixture ticket');
        await owner.db
          .update(tickets)
          .set({ importedAt: new Date(Date.parse(initial.requestedAt) + 1) })
          .where(eq(tickets.id, laterId));
        const first = { brandId: seeded.brandId, runId, revision: initial.revision, after: null };
        await activateImportedSlaBatch(runtime.db, first, 'activation-first');
        await activateImportedSlaBatch(runtime.db, first, 'activation-replay');
        const [midRun] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
        const mid = importSlaActivationStateSchema.parse(midRun?.options.slaActivation);
        expect(mid).toMatchObject({ status: 'running', checked: 50, started: 50, skipped: 0 });
        await activateImportedSlaBatch(
          runtime.db,
          { ...first, after: mid.after },
          'activation-resume',
        );
        const summary = await call<ImportSlaOverview>('GET', path, ada);
        expect(summary.body.activation).toMatchObject({
          status: 'completed',
          checked: 52,
          started: 52,
          skipped: 0,
        });
        const stored = await owner.db.select().from(tickets).where(inArray(tickets.id, ids));
        expect(stored.filter((ticket) => ticket.importSlaStartedAt !== null)).toHaveLength(52);
        expect(
          stored.every((ticket) => ticket.createdAt.toISOString() === '2000-01-01T00:00:00.000Z'),
        ).toBe(true);
        for (const id of ids.slice(52)) expect(await clocksOf(id)).toEqual([]);
      } finally {
        await owner.db
          .delete(importExternalIds)
          .where(
            and(
              eq(importExternalIds.brandId, seeded.brandId),
              inArray(importExternalIds.helpdockId, ids),
            ),
          );
        await owner.db.delete(tickets).where(inArray(tickets.id, ids));
        await owner.db.delete(importRuns).where(eq(importRuns.id, runId));
      }
    });

    it('keeps imported history without clocks across sync/reopen/policy changes until explicit activation', async () => {
      const { ticket } = await createTicket();
      const createdAt = new Date('2010-01-01T00:00:00Z');
      const at = new Date();
      const sla = new SlaService(new SlaRepository());
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await tx.delete(ticketSlaClocks).where(eq(ticketSlaClocks.ticketId, ticket.id));
        await tx
          .update(tickets)
          .set({
            importedAt: at,
            importSource: 'zendesk',
            importSlaStartedAt: null,
            createdAt,
            slaPolicyId: null,
            firstResponseDueAt: null,
            resolutionDueAt: null,
            slaBreached: false,
          })
          .where(eq(tickets.id, ticket.id));
      });
      const scheduled = (await outboxOf(SLA_SCHEDULE_EVENT)).filter((payload) =>
        (payload.ticketIds as string[]).includes(ticket.id),
      ).length;
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await sla.sync(tx, { brandId: seeded.brandId, ticketId: ticket.id, at });
        await sla.reopen(tx, { brandId: seeded.brandId, ticketId: ticket.id, at });
        await sla.recompute(tx, seeded.brandId, at, async () => undefined);
      });
      expect(await clocksOf(ticket.id)).toEqual([]);
      expect(
        (await outboxOf(SLA_SCHEDULE_EVENT)).filter((payload) =>
          (payload.ticketIds as string[]).includes(ticket.id),
        ),
      ).toHaveLength(scheduled);
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        expect(
          await sla.activateImported(tx, { brandId: seeded.brandId, ticketId: ticket.id, at }),
        ).toBe(true);
        expect(
          await sla.activateImported(tx, {
            brandId: seeded.brandId,
            ticketId: ticket.id,
            at: new Date(at.getTime() + MINUTE),
          }),
        ).toBe(false);
      });
      const clocks = await clocksOf(ticket.id);
      expect(clocks.map((clock) => clock.kind).sort()).toEqual(['first_response', 'resolution']);
      expect(clocks.every((clock) => clock.startedAt.getTime() === at.getTime())).toBe(true);
      const [stored] = await owner.db.select().from(tickets).where(eq(tickets.id, ticket.id));
      expect(stored).toMatchObject({ createdAt, importSlaStartedAt: at });
    });

    it('starts both clocks on a new ticket and shows them on the card and the list', async () => {
      const created = await createTicket();
      const ticketId = created.ticket.id;

      const clocks = await clocksOf(ticketId);
      expect(clocks.map((clock) => clock.kind).sort()).toEqual(['first_response', 'resolution']);
      const resolution = await clockOf(ticketId, 'resolution');
      expect(resolution.dueAt?.getTime()).toBe(resolution.startedAt.getTime() + 480 * MINUTE);

      const read = await call<TicketDetail>('GET', `${brandPath()}/tickets/${ticketId}`, ada);
      expect(read.body.sla).toMatchObject({
        state: 'running',
        policyId: policy.id,
        policyName: policy.name,
      });
      expect(read.body.ticket.resolutionDueAt).toBe(resolution.dueAt?.toISOString());

      const list = await call<TicketList>('GET', `${brandPath()}/tickets`, ada);
      expect(list.body.tickets.find((row) => row.id === ticketId)?.sla).toMatchObject({
        state: 'running',
        clock: 'first_response',
        reopened: false,
      });

      expect(
        (await outboxOf(SLA_SCHEDULE_EVENT)).some((payload) =>
          (payload.ticketIds as string[]).includes(ticketId),
        ),
      ).toBe(true);
    });

    it('meets the response clock on a public staff reply and pauses on Awaiting customer', async () => {
      const { ticket } = await createTicket();

      const reply = await call('POST', `${brandPath()}/tickets/${ticket.id}/messages`, ada, {
        kind: 'public',
        bodyHtml: '<p>We are on it.</p>',
      });
      expect(reply.status).toBe(201);

      expect((await clockOf(ticket.id, 'first_response')).satisfiedAt).not.toBeNull();
      // The brand's auto-await toggle moved the ticket to Awaiting customer.
      const resolution = await clockOf(ticket.id, 'resolution');
      expect(resolution.pausedAt).not.toBeNull();
      expect(resolution.dueAt).toBeNull();

      const resumed = await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
        statusId: open,
      });
      expect(resumed.status).toBe(200);
      const running = await clockOf(ticket.id, 'resolution');
      expect(running.pausedAt).toBeNull();
      expect(running.dueAt).not.toBeNull();
      expect(Number(running.pausedTotalMs)).toBeGreaterThanOrEqual(0);
    });

    it('M14-07 generated due follows reply, pause, resume, retarget and satisfaction', async () => {
      expect(
        (await call('POST', `${brandPath()}/sla-policies`, ada, policyBody({ escalation: [] })))
          .status,
      ).toBe(201);
      const { ticket } = await createTicket({ priority: 'medium' });
      const nextDue = async () =>
        withSystem(runtime.db, seeded.brandId, async (tx) => {
          const [row] = await tx
            .select({ due: tickets.slaNextDueAt })
            .from(tickets)
            .where(eq(tickets.id, ticket.id));
          return row?.due;
        });
      const response = await clockOf(ticket.id, 'first_response');
      expect(await nextDue()).toEqual(response.dueAt);
      expect(
        (
          await call('POST', `${brandPath()}/tickets/${ticket.id}/messages`, ada, {
            kind: 'public',
            bodyHtml: '<p>Checking.</p>',
          })
        ).status,
      ).toBe(201);
      expect(await nextDue()).toBeNull();
      expect(
        (await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId: open }))
          .status,
      ).toBe(200);
      expect(await nextDue()).toEqual((await clockOf(ticket.id, 'resolution')).dueAt);
      const before = await nextDue();
      expect(
        (await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { priority: 'urgent' }))
          .status,
      ).toBe(200);
      const retargeted = await nextDue();
      expect(retargeted).toEqual((await clockOf(ticket.id, 'resolution')).dueAt);
      expect(retargeted?.getTime()).toBeLessThan(before?.getTime() ?? 0);
      expect(
        (await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId: closed }))
          .status,
      ).toBe(200);
      expect(await nextDue()).toBeNull();
    });

    describe('status re-sync (#336)', () => {
      // A brand holds a bounded number of statuses; each test leaves only what it found.
      type StatusRow = { id: string };
      const listStatuses = async () =>
        (await call<{ statuses: StatusRow[] }>('GET', `${brandPath()}/ticket-statuses`, ada)).body
          .statuses;
      let baseline = new Set<string>();
      beforeAll(async () => {
        baseline = new Set((await listStatuses()).map((row) => row.id));
      });
      afterEach(async () => {
        for (const row of await listStatuses()) {
          if (!baseline.has(row.id)) {
            await call('DELETE', `${brandPath()}/ticket-statuses/${row.id}`, ada);
          }
        }
      });

      const statusPath = (statusId: string) => `${brandPath()}/ticket-statuses/${statusId}`;
      const patchStatus = (statusId: string, body: Record<string, unknown>) =>
        call('PATCH', statusPath(statusId), ada, body);

      const columns = (ticketId: string) =>
        withSystem(runtime.db, seeded.brandId, async (tx) => {
          const [row] = await tx
            .select({
              first: tickets.firstResponseDueAt,
              resolution: tickets.resolutionDueAt,
              next: tickets.slaNextDueAt,
            })
            .from(tickets)
            .where(eq(tickets.id, ticketId));
          return row;
        });

      const statusWithTickets = async (name: string, count: number) => {
        const created = await call<{ id: string }>('POST', `${brandPath()}/ticket-statuses`, ada, {
          name,
          systemState: 'open',
          pausesSla: false,
          color: 'info',
        });
        expect(created.status).toBe(201);
        const statusId = created.body.id;
        const ids: string[] = [];
        for (let index = 0; index < count; index += 1) {
          const { ticket } = await createTicket();
          expect(
            (await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId })).status,
          ).toBe(200);
          ids.push(ticket.id);
        }
        return { statusId, ids };
      };

      /** What the worker does with the `sla.status_resync` rows of one status, a batch of two at a time. */
      const drainer = (statusId: string) => {
        const handler = createSlaStatusResyncHandler({ ...slaDeps(), statusResyncBatch: 2 });
        const handled = new Set<string>();
        const at: Date[] = [];
        const drain = async (): Promise<number> => {
          for (;;) {
            const rows = (
              await withSystem(runtime.db, seeded.brandId, (tx) =>
                tx
                  .select()
                  .from(outbox)
                  .where(eq(outbox.event, SLA_STATUS_RESYNC_EVENT))
                  .orderBy(asc(outbox.id)),
              )
            ).filter((row) => !handled.has(row.id) && row.payload.statusId === statusId);
            const row = rows[0];
            if (row === undefined) {
              return handled.size;
            }
            handled.add(row.id);
            at.push(new Date(String(row.payload.at)));
            await withSystem(runtime.db, seeded.brandId, (tx) =>
              handler({
                outboxId: row.id,
                brandId: row.brandId,
                event: row.event,
                payload: row.payload,
                tx,
                log: silentLogger,
              }),
            );
          }
        };
        return { drain, at };
      };

      const expectPaused = async (ids: string[], paused: boolean) => {
        for (const id of ids) {
          const clock = await clockOf(id, 'resolution');
          expect(clock.pausedAt === null).toBe(!paused);
          expect((await columns(id))?.resolution ?? null).toEqual(clock.dueAt);
          expect(clock.dueAt === null).toBe(paused);
        }
      };

      beforeAll(async () => {
        expect(
          (await call('POST', `${brandPath()}/sla-policies`, ada, policyBody({ escalation: [] })))
            .status,
        ).toBe(201);
      });

      it('pauses and resumes the tickets already in the status, in batches, from the change time', async () => {
        const { statusId, ids } = await statusWithTickets('On hold with vendor', 3);
        const elsewhere = (await createTicket()).ticket.id;
        const { drain, at } = drainer(statusId);
        await expectPaused(ids, false);

        expect((await patchStatus(statusId, { pausesSla: true })).status).toBe(200);
        expect(await drain()).toBe(2);

        await expectPaused(ids, true);
        for (const id of ids) {
          expect((await clockOf(id, 'resolution')).pausedAt).toEqual(at[0]);
          expect(await columns(id)).toEqual({ first: null, resolution: null, next: null });
        }
        expect((await columns(elsewhere))?.resolution).not.toBeNull();

        // A PATCH that leaves the flag as it is writes nothing.
        expect((await patchStatus(statusId, { pausesSla: true })).status).toBe(200);
        expect(await drain()).toBe(2);

        expect((await patchStatus(statusId, { pausesSla: false })).status).toBe(200);
        expect(await drain()).toBe(4);
        await expectPaused(ids, false);
        for (const id of ids) {
          expect((await columns(id))?.next).not.toBeNull();
        }
      });

      it('ends on the final flag when it flips twice before the worker runs', async () => {
        const { statusId, ids } = await statusWithTickets('Flip flop', 2);
        const { drain } = drainer(statusId);

        expect((await patchStatus(statusId, { pausesSla: true })).status).toBe(200);
        expect((await patchStatus(statusId, { pausesSla: false })).status).toBe(200);
        expect(await drain()).toBe(4);
        await expectPaused(ids, false);

        expect((await patchStatus(statusId, { pausesSla: true })).status).toBe(200);
        expect((await patchStatus(statusId, { pausesSla: false })).status).toBe(200);
        expect((await patchStatus(statusId, { pausesSla: true })).status).toBe(200);
        expect(await drain()).toBe(10);
        await expectPaused(ids, true);
      });

      it('re-syncs after a save that raced another admin, when the worker ran between their commits', async () => {
        const { statusId, ids } = await statusWithTickets('Race', 2);
        const { drain } = drainer(statusId);
        const settings = new TicketingSettingsService(new TicketLifecycleRepository());
        const save = (tx: DbTransaction, pausesSla: boolean) =>
          settings.update(
            {
              tx,
              brandId: seeded.brandId,
              actor: { actorType: 'staff', actorId: ada.id, via: 'ui' },
              now: new Date(),
            },
            statusId,
            { pausesSla },
          );
        const gate = () => {
          let open!: () => void;
          const opened = new Promise<void>((resolve) => {
            open = resolve;
          });
          return { open, opened };
        };
        const aMayCommit = gate();
        const bMayCommit = gate();
        const aSaved = gate();
        const bSaved = gate();

        // A saves "pause" and holds its transaction open.
        const a = withSystem(runtime.db, seeded.brandId, async (tx) => {
          await save(tx, true);
          aSaved.open();
          await aMayCommit.opened;
        });
        await aSaved.opened;
        // B saves "resume" having started before A commits, and holds its own open.
        const b = withSystem(runtime.db, seeded.brandId, async (tx) => {
          await save(tx, false);
          bSaved.open();
          await bMayCommit.opened;
        });
        await waitForLock(300);

        aMayCommit.open();
        await a;
        await bSaved.opened;
        // The worker handles A's event between A's commit and B's.
        await drain();
        await expectPaused(ids, true);

        bMayCommit.open();
        await b;
        await drain();
        await expectPaused(ids, false);
      });

      it('never rewinds a clock another sync already moved past the change time', async () => {
        const { statusId, ids } = await statusWithTickets('Late batch', 1);
        const id = ids[0] ?? '';
        const { drain, at } = drainer(statusId);

        expect((await patchStatus(statusId, { pausesSla: true })).status).toBe(200);
        const checkpoint = new Date(Date.now() + 60 * MINUTE);
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .update(ticketSlaClocks)
            .set({ checkpointAt: checkpoint })
            .where(eq(ticketSlaClocks.ticketId, id)),
        );
        await drain();

        expect(at[0]?.getTime()).toBeLessThan(checkpoint.getTime());
        const clock = await clockOf(id, 'resolution');
        expect(clock.pausedAt).toEqual(checkpoint);
        expect(clock.checkpointAt).toEqual(checkpoint);
      });
    });

    it('does not meet the response clock with an internal note', async () => {
      const { ticket } = await createTicket();

      await call('POST', `${brandPath()}/tickets/${ticket.id}/messages`, ada, {
        kind: 'note',
        bodyHtml: '<p>Checking with finance.</p>',
      });

      expect((await clockOf(ticket.id, 'first_response')).satisfiedAt).toBeNull();
    });

    it('retargets on a priority change and records a breach the change caused (§3.3)', async () => {
      const { ticket } = await createTicket({ priority: 'medium' });
      // Two hours already consumed, as if the ticket had waited that long.
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(ticketSlaClocks)
          .set({ elapsedMs: 130 * MINUTE })
          .where(eq(ticketSlaClocks.ticketId, ticket.id)),
      );

      const raised = await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
        priority: 'urgent',
      });
      expect(raised.status).toBe(200);

      const resolution = await clockOf(ticket.id, 'resolution');
      expect(resolution.targetMinutes).toBe(120);
      expect(resolution.breachedAt).not.toBeNull();
      expect(resolution.breachCause).toBe('change');

      const logged = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ to: ticketActivity.to })
          .from(ticketActivity)
          .where(
            and(
              eq(ticketActivity.ticketId, ticket.id),
              eq(ticketActivity.action, 'ticket.sla.breached'),
            ),
          ),
      );
      expect(logged.map((row) => row.to)).toEqual(
        expect.arrayContaining([{ clock: 'resolution', cause: 'change' }]),
      );
      expect(
        (await outboxOf('sla.breached')).some((payload) => payload.ticketId === ticket.id),
      ).toBe(true);
    });

    it('stops the clocks when the ticket leaves every policy, and follows it into another department', async () => {
      const { ticket } = await createTicket();

      const moved = await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
        departmentId: billing,
      });
      expect(moved.status).toBe(200);

      const clocks = await clocksOf(ticket.id);
      expect(clocks.every((clock) => clock.stopReason === 'no_policy')).toBe(true);
      expect(clocks.every((clock) => clock.departmentId === billing)).toBe(true);

      const read = await call<TicketDetail>('GET', `${brandPath()}/tickets/${ticket.id}`, ada);
      expect(read.body.sla?.state).toBe('none');
      expect(read.body.ticket.sla).toBeNull();
    });

    it('resolves on close and starts next-response clocks on a reopen (§3.5)', async () => {
      const { ticket } = await createTicket();
      await call('POST', `${brandPath()}/tickets/${ticket.id}/messages`, ada, {
        kind: 'public',
        bodyHtml: '<p>Done.</p>',
      });

      expect(
        (await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId: closed }))
          .status,
      ).toBe(200);
      expect((await clockOf(ticket.id, 'resolution')).satisfiedAt).not.toBeNull();

      expect(
        (await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId: open }))
          .status,
      ).toBe(200);
      const clocks = await clocksOf(ticket.id);
      expect(clocks.map((clock) => [clock.kind, clock.cycle]).sort()).toEqual([
        ['next_response', 1],
        ['resolution', 1],
      ]);

      const read = await call<TicketDetail>('GET', `${brandPath()}/tickets/${ticket.id}`, ada);
      expect(read.body.sla).toMatchObject({ initialResponse: 'met' });
      expect(read.body.sla?.reopenedAt).not.toBeNull();
    });

    it('recomputes open tickets when a policy is saved', async () => {
      const { ticket } = await createTicket({ priority: 'low' });

      const saved = await call<SlaPolicy>('PUT', `${brandPath()}/sla-policies/${policy.id}`, ada, {
        ...policyBody(),
        targets: { ...policyBody().targets, low: target(60, 960) },
        escalation: policy.escalation,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.runningTickets).toBeGreaterThan(0);

      expect((await clockOf(ticket.id, 'resolution')).targetMinutes).toBe(960);
    });
  });

  describe('status state resync (#361)', () => {
    // A policy of its own, so the suite is whole when the file is filtered
    // down to it: without one the tickets it files have no clocks to close.
    beforeAll(async () => {
      expect(
        (await call('POST', `${brandPath()}/sla-policies`, ada, policyBody({ escalation: [] })))
          .status,
      ).toBe(201);
    });

    const statusPath = (statusId: string) => `${brandPath()}/ticket-statuses/${statusId}`;
    const patchStatus = <T = unknown>(statusId: string, body: Record<string, unknown>) =>
      call<T>('PATCH', statusPath(statusId), ada, body);

    /** What the worker builds, a batch of two at a time. */
    const stateDeps = (repository?: TicketLifecycleRepository) => {
      const lifecycleRepository = new TicketLifecycleRepository();
      const slaRepository = new SlaRepository();
      return {
        repository: repository ?? lifecycleRepository,
        lifecycle: new TicketLifecycleService(
          lifecycleRepository,
          new TicketRepository(),
          new SlaLifecycleHooks(lifecycleRepository, new SlaService(slaRepository)),
        ),
        batch: 2,
      };
    };

    /** Runs every `ticket.status_state_resync` row of one status through the handler. */
    const drainer = (statusId: string, repository?: TicketLifecycleRepository) => {
      const handler = createStatusStateResyncHandler(stateDeps(repository));
      const handled = new Set<string>();
      const rows: {
        id: string;
        payload: Record<string, unknown>;
        brandId: string;
        event: string;
      }[] = [];
      const drain = async (): Promise<number> => {
        for (;;) {
          const pending = (
            await withSystem(runtime.db, seeded.brandId, (tx) =>
              tx
                .select()
                .from(outbox)
                .where(eq(outbox.event, TICKET_STATUS_STATE_RESYNC_EVENT))
                .orderBy(asc(outbox.id)),
            )
          ).filter((row) => !handled.has(row.id) && row.payload.statusId === statusId);
          const row = pending[0];
          if (row === undefined) {
            return handled.size;
          }
          handled.add(row.id);
          rows.push({ id: row.id, payload: row.payload, brandId: row.brandId, event: row.event });
          await withSystem(runtime.db, seeded.brandId, (tx) =>
            handler({
              outboxId: row.id,
              brandId: row.brandId,
              event: row.event,
              payload: row.payload,
              tx,
              log: silentLogger,
            }),
          );
        }
      };
      /** A redelivery: the same outbox row, handled again. */
      const replayFirst = async (): Promise<void> => {
        const row = rows[0];
        if (row === undefined) {
          throw new Error('nothing was drained to replay');
        }
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          handler({
            outboxId: row.id,
            brandId: row.brandId,
            event: row.event,
            payload: row.payload,
            tx,
            log: silentLogger,
          }),
        );
      };
      return { drain, replayFirst };
    };

    /** Sets what the api would refuse to, to stage a flip that raced the worker. */
    const setStateDirectly = (statusId: string, systemState: 'open' | 'closed') =>
      withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.update(ticketStatuses).set({ systemState }).where(eq(ticketStatuses.id, statusId)),
      );

    const rowOf = (ticketId: string) =>
      withSystem(runtime.db, seeded.brandId, async (tx) => {
        const [row] = await tx
          .select({ closedAt: tickets.closedAt, statusId: tickets.statusId })
          .from(tickets)
          .where(eq(tickets.id, ticketId));
        return row;
      });

    const activityOf = (ticketId: string, action: string) =>
      withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({
            actorId: ticketActivity.actorId,
            from: ticketActivity.from,
            to: ticketActivity.to,
          })
          .from(ticketActivity)
          .where(and(eq(ticketActivity.ticketId, ticketId), eq(ticketActivity.action, action))),
      );

    const statusWithTickets = async (name: string, count: number) => {
      const created = await call<{ id: string }>('POST', `${brandPath()}/ticket-statuses`, ada, {
        name,
        systemState: 'open',
        pausesSla: false,
        color: 'info',
      });
      expect(created.status).toBe(201);
      const statusId = created.body.id;
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const { ticket } = await createTicket();
        expect(
          (await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId })).status,
        ).toBe(200);
        ids.push(ticket.id);
      }
      return { statusId, ids };
    };

    /** The `ticket.status_state_resync` rows this status owns, oldest first. */
    const stateEventsOf = async (statusId: string) =>
      (
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .select({ payload: outbox.payload })
            .from(outbox)
            .where(eq(outbox.event, TICKET_STATUS_STATE_RESYNC_EVENT))
            .orderBy(asc(outbox.id)),
        )
      )
        .map((row) => row.payload as { statusId: string; at: string })
        .filter((payload) => payload.statusId === statusId);

    const eventTicketIds = async (event: string) =>
      (await outboxOf(event)).map((payload) => payload.ticketId as string);

    /** The `ticket.status_state_resync` outbox rows of one status, oldest first. */
    const stateEventsOfRows = async (statusId: string) =>
      (
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .select()
            .from(outbox)
            .where(eq(outbox.event, TICKET_STATUS_STATE_RESYNC_EVENT))
            .orderBy(asc(outbox.id)),
        )
      ).filter((row) => row.payload.statusId === statusId);

    const runHandler = (
      handler: ReturnType<typeof createStatusStateResyncHandler>,
      row: Awaited<ReturnType<typeof stateEventsOfRows>>[number] | undefined,
    ) => {
      if (row === undefined) {
        throw new Error('no state event to run');
      }
      return withSystem(runtime.db, seeded.brandId, (tx) =>
        handler({
          outboxId: row.id,
          brandId: row.brandId,
          event: row.event,
          payload: row.payload,
          tx,
          log: silentLogger,
        }),
      );
    };

    type Refusal = { error: { ticketing?: { reason: string; count?: number } } };

    it('refuses to leave the closed state while the status holds tickets, and allows it when empty', async () => {
      const { statusId } = await statusWithTickets('Vendor archive', 2);
      const { drain } = drainer(statusId);
      expect((await patchStatus(statusId, { systemState: 'closed', confirmCount: 2 })).status).toBe(
        200,
      );
      await drain();

      const refused = await patchStatus<Refusal>(statusId, { systemState: 'open' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.ticketing).toEqual({
        reason: 'status-has-closed-tickets',
        count: 2,
      });

      const empty = await call<{ id: string }>('POST', `${brandPath()}/ticket-statuses`, ada, {
        name: 'Empty archive',
        systemState: 'closed',
        pausesSla: false,
        color: 'info',
      });
      expect(empty.status).toBe(201);
      expect((await patchStatus(empty.body.id, { systemState: 'open' })).status).toBe(200);
    });

    it('needs the live-ticket count confirmed before it closes anything', async () => {
      const { statusId, ids } = await statusWithTickets('Vendor done', 2);
      const { drain } = drainer(statusId);

      const bare = await patchStatus<Refusal>(statusId, { systemState: 'closed' });
      expect(bare.status).toBe(409);
      expect(bare.body.error.ticketing).toEqual({
        reason: 'status-change-needs-confirmation',
        count: 2,
      });
      const wrong = await patchStatus<Refusal>(statusId, {
        systemState: 'closed',
        confirmCount: 1,
      });
      expect(wrong.status).toBe(409);
      expect(wrong.body.error.ticketing?.count).toBe(2);
      expect(await stateEventsOf(statusId)).toEqual([]);
      expect((await rowOf(ids[0] ?? ''))?.closedAt).toBeNull();

      expect((await patchStatus(statusId, { systemState: 'closed', confirmCount: 2 })).status).toBe(
        200,
      );
      const writtenAt = new Date(String((await stateEventsOf(statusId))[0]?.at));
      // Two rows at this batch size: the full batch and the empty successor.
      expect(await drain()).toBe(2);

      for (const id of ids) {
        const row = await rowOf(id);
        expect(row?.statusId).toBe(statusId);
        expect(row?.closedAt?.toISOString()).toBe(writtenAt.toISOString());

        const clock = await clockOf(id, 'resolution');
        expect(clock.satisfiedAt?.toISOString()).toBe(writtenAt.toISOString());

        const closed = await activityOf(id, 'ticket.closed');
        expect(closed).toHaveLength(1);
        expect(closed[0]?.actorId).toBe(ada.id);
        expect(closed[0]?.to).toMatchObject({ statusId, reason: 'status-state' });

        // Each ticket fires its own ticket.closed; a configuration change asks no survey.
        expect(await eventTicketIds('ticket.closed')).toContain(id);
        expect(await eventTicketIds('csat.requested')).not.toContain(id);
      }
    });

    it('closes an empty status without a confirmation', async () => {
      const created = await call<{ id: string }>('POST', `${brandPath()}/ticket-statuses`, ada, {
        name: 'Empty shelf',
        systemState: 'open',
        pausesSla: false,
        color: 'info',
      });
      expect(created.status).toBe(201);
      const { drain } = drainer(created.body.id);

      expect((await patchStatus(created.body.id, { systemState: 'closed' })).status).toBe(200);
      expect(await drain()).toBe(1);
    });

    it('counts and closes only live tickets: soft-deleted and merged ones are left alone', async () => {
      const { statusId, ids } = await statusWithTickets('Mixed shelf', 4);
      const [live, deleted, merged, other] = ids;
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await tx
          .update(tickets)
          .set({ deletedAt: new Date() })
          .where(eq(tickets.id, deleted ?? ''));
        await tx
          .update(tickets)
          .set({ mergedIntoId: other ?? null })
          .where(eq(tickets.id, merged ?? ''));
      });
      const { drain } = drainer(statusId);

      // Four tickets filed, two of them out of the count.
      const bare = await patchStatus<Refusal>(statusId, { systemState: 'closed' });
      expect(bare.body.error.ticketing?.count).toBe(2);
      expect((await patchStatus(statusId, { systemState: 'closed', confirmCount: 2 })).status).toBe(
        200,
      );
      await drain();

      expect((await rowOf(live ?? ''))?.closedAt).not.toBeNull();
      expect((await rowOf(other ?? ''))?.closedAt).not.toBeNull();
      expect((await rowOf(deleted ?? ''))?.closedAt).toBeNull();
      expect((await rowOf(merged ?? ''))?.closedAt).toBeNull();
    });

    it('stops a chain when the state is flipped back between two of its batches', async () => {
      const { statusId, ids } = await statusWithTickets('Flip flop', 3);
      const handler = createStatusStateResyncHandler(stateDeps());
      expect((await patchStatus(statusId, { systemState: 'closed', confirmCount: 3 })).status).toBe(
        200,
      );

      const [first] = await stateEventsOfRows(statusId);
      await runHandler(handler, first);
      // Two of three closed, the successor written with a cursor.
      const closedNow = await Promise.all(ids.map(async (id) => (await rowOf(id))?.closedAt));
      expect(closedNow.filter((value) => value !== null && value !== undefined)).toHaveLength(2);
      const rows = await stateEventsOfRows(statusId);
      expect(rows).toHaveLength(2);

      await setStateDirectly(statusId, 'open');
      await runHandler(handler, rows[1]);

      const after = await Promise.all(ids.map(async (id) => (await rowOf(id))?.closedAt));
      expect(after.filter((value) => value !== null && value !== undefined)).toHaveLength(2);
      expect(await stateEventsOfRows(statusId)).toHaveLength(2);
    });

    it('does not close a ticket that was moved out of the status mid-batch', async () => {
      const { statusId, ids } = await statusWithTickets('Racy shelf', 2);
      const [stays, leaves] = ids;
      const elsewhere = await call<{ id: string }>('POST', `${brandPath()}/ticket-statuses`, ada, {
        name: 'Elsewhere',
        systemState: 'open',
        pausesSla: false,
        color: 'info',
      });

      // The batch is read, then an agent moves one ticket before the worker
      // reaches it: the read is the real one, the move is staged after it.
      class MovingRepository extends TicketLifecycleRepository {
        override async liveTicketsToClose(
          ...args: Parameters<TicketLifecycleRepository['liveTicketsToClose']>
        ) {
          const batch = await super.liveTicketsToClose(...args);
          await args[0]
            .update(tickets)
            .set({ statusId: elsewhere.body.id })
            .where(eq(tickets.id, leaves ?? ''));
          return batch;
        }
      }
      const { drain } = drainer(statusId, new MovingRepository());

      expect((await patchStatus(statusId, { systemState: 'closed', confirmCount: 2 })).status).toBe(
        200,
      );
      await drain();

      expect((await rowOf(stays ?? ''))?.closedAt).not.toBeNull();
      const moved = await rowOf(leaves ?? '');
      expect(moved?.statusId).toBe(elsewhere.body.id);
      expect(moved?.closedAt).toBeNull();
      expect(await activityOf(leaves ?? '', 'ticket.closed')).toHaveLength(0);
      expect(await eventTicketIds('ticket.closed')).not.toContain(leaves);
    });

    it('repairs tickets an earlier edit left in a closed status without a closed_at, once', async () => {
      const { statusId, ids } = await statusWithTickets('Left behind', 2);
      // What the pre-#361 edit produced: the state flipped, the tickets untouched.
      await setStateDirectly(statusId, 'closed');
      const { drain } = drainer(statusId);

      expect(await repairClosedStatusTickets(runtime.db)).toBeGreaterThanOrEqual(1);
      await drain();

      for (const id of ids) {
        expect((await rowOf(id))?.closedAt).not.toBeNull();
        expect((await clockOf(id, 'resolution')).satisfiedAt).not.toBeNull();
        expect(await eventTicketIds('ticket.closed')).toContain(id);
        expect(await eventTicketIds('csat.requested')).not.toContain(id);
      }

      // Nothing is left to repair in this status.
      const events = (await stateEventsOf(statusId)).length;
      await repairClosedStatusTickets(runtime.db);
      expect((await stateEventsOf(statusId)).length).toBe(events);
    });

    it('leaves an open-like change to the SLA re-sync and writes no state event', async () => {
      const { statusId, ids } = await statusWithTickets('Waiting a while', 1);
      const id = ids[0] ?? '';
      const { drain } = drainer(statusId);

      expect(
        (await patchStatus(statusId, { systemState: 'on_hold', pausesSla: true })).status,
      ).toBe(200);
      expect(await drain()).toBe(0);
      expect(await stateEventsOf(statusId)).toEqual([]);

      expect((await rowOf(id))?.closedAt).toBeNull();
      expect(await activityOf(id, 'ticket.closed')).toHaveLength(0);
    });

    it('moves nothing twice when the same batch is redelivered', async () => {
      const { statusId, ids } = await statusWithTickets('Once only', 1);
      const id = ids[0] ?? '';
      const { drain, replayFirst } = drainer(statusId);

      expect((await patchStatus(statusId, { systemState: 'closed', confirmCount: 1 })).status).toBe(
        200,
      );
      await drain();
      const satisfiedAt = (await clockOf(id, 'resolution')).satisfiedAt?.toISOString();

      await replayFirst();

      expect((await rowOf(id))?.closedAt?.toISOString()).toBe(satisfiedAt);
      expect(await activityOf(id, 'ticket.closed')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------ timers

  describe('timers', () => {
    it('re-reads the parent after waiting for a concurrent quiet close', async () => {
      const { ticket } = await createTicket({ priority: 'medium' });
      const clock = await clockOf(ticket.id, 'resolution');
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const close = withSystem(runtime.db, seeded.brandId, async (tx) => {
        await new SlaRepository().lockTicket(tx, ticket.id);
        locked.resolve();
        await release.promise;
        await tx
          .update(tickets)
          .set({ statusId: closed, closedAt: clock.startedAt })
          .where(eq(tickets.id, ticket.id));
      });
      await locked.promise;
      const fire = withSystem(runtime.db, seeded.brandId, (tx) =>
        fireSlaTimer(
          tx,
          slaDeps(),
          { brandId: seeded.brandId, ticketId: ticket.id, clock: 'resolution', stepPercent: 100 },
          new Date(clock.startedAt.getTime() + 481 * MINUTE),
        ),
      );
      try {
        expect(
          await somebodyWaitsForATicketLock(),
          'timer must reach the parent lock before the close commits',
        ).toBe(true);
      } finally {
        release.resolve();
        await close;
      }
      expect(await fire).toEqual({ kind: 'done' });
      expect(await clockOf(ticket.id, 'resolution')).toEqual(clock);
      expect(
        (await outboxOf('sla.breached')).filter((event) => event.ticketId === ticket.id),
      ).toEqual([]);
      expect(
        (await outboxOf('ticket.escalated')).filter((event) => event.ticketId === ticket.id),
      ).toEqual([]);
    });

    it('lets a policy save wait for a timer that holds a ticket it recomputes (1.0.1 deadlock)', async () => {
      // Seen in the 1.0 demo: the save checkpointed a ticket's clocks before
      // locking the ticket, and a timer that had locked the ticket then waited
      // on those clock rows while the save waited on the ticket. Ticket rows are
      // locked before clock rows, so the save must queue behind the timer.
      const { ticket } = await createTicket({ priority: 'medium' });
      const clock = await clockOf(ticket.id, 'resolution');
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const timer = withSystem(runtime.db, seeded.brandId, async (tx) => {
        await new SlaRepository().lockTicket(tx, ticket.id);
        locked.resolve();
        await release.promise;
        await tx
          .update(ticketSlaClocks)
          .set({ updatedAt: new Date() })
          .where(eq(ticketSlaClocks.id, clock.id));
      });
      await locked.promise;
      const save = call<SlaPolicy>('POST', `${brandPath()}/sla-policies`, ada, {
        ...policyBody({
          name: 'Billing, while a timer runs',
          conditions: [{ field: 'department', operator: 'any', values: [billing] }],
        }),
        escalation: [],
      });
      try {
        expect(
          await somebodyWaitsForATicketLock(),
          'the save must reach the ticket lock before the timer writes its clock',
        ).toBe(true);
      } finally {
        release.resolve();
      }

      await expect(timer).resolves.toBeUndefined();
      const saved = await save;
      expect(saved.status).toBe(201);
      expect(
        (await call('DELETE', `${brandPath()}/sla-policies/${saved.body.id}`, ada)).status,
      ).toBe(204);
    });

    it.each(['closed', 'deleted', 'merged', 'unactivated-import'] as const)(
      'ignores a stale timer when a quiet import or concurrent change leaves the ticket %s',
      async (state) => {
        const { ticket } = await createTicket({ priority: 'medium' });
        const mergeTargetId = state === 'merged' ? (await createTicket()).ticket.id : undefined;
        const started = (await clockOf(ticket.id, 'resolution')).startedAt;
        // The historical writer deliberately bypasses lifecycle hooks. A queued
        // timer must recheck the parent rather than trust its old counting clock.
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .update(tickets)
            .set({
              importedAt: started,
              importSource: 'zohodesk',
              importSlaStartedAt: state === 'unactivated-import' ? null : started,
              ...(state === 'closed' ? { statusId: closed, closedAt: started } : {}),
              ...(state === 'deleted' ? { deletedAt: started } : {}),
              ...(mergeTargetId ? { mergedIntoId: mergeTargetId } : {}),
            })
            .where(eq(tickets.id, ticket.id)),
        );
        const beforeClocks = await clocksOf(ticket.id);
        const beforeEvents = await owner.db
          .select()
          .from(outbox)
          .where(eq(outbox.brandId, seeded.brandId));
        const beforeTicket = await owner.db.select().from(tickets).where(eq(tickets.id, ticket.id));
        const outcome = await withSystem(runtime.db, seeded.brandId, (tx) =>
          fireSlaTimer(
            tx,
            slaDeps(),
            { brandId: seeded.brandId, ticketId: ticket.id, clock: 'resolution', stepPercent: 100 },
            new Date(started.getTime() + 481 * MINUTE),
          ),
        );
        expect(outcome).toEqual({ kind: 'done' });
        expect(await clocksOf(ticket.id)).toEqual(beforeClocks);
        expect(await owner.db.select().from(tickets).where(eq(tickets.id, ticket.id))).toEqual(
          beforeTicket,
        );
        expect(
          await owner.db.select().from(outbox).where(eq(outbox.brandId, seeded.brandId)),
        ).toEqual(beforeEvents);
      },
    );

    it('schedules one delayed job per clock and step, keyed as §3.4 says', async () => {
      const { ticket } = await createTicket();
      await schedule([ticket.id]);

      const resolution = await clockOf(ticket.id, 'resolution');
      for (const stepPercent of [50, 100, 150]) {
        const job = await queue.getJob(
          slaTimerJobId({ ticketId: ticket.id, clock: 'resolution', stepPercent }),
        );
        expect(await job?.getState()).toBe('delayed');
        expect((job?.timestamp ?? 0) + (job?.delay ?? 0)).toBeCloseTo(
          resolution.startedAt.getTime() + (480 * MINUTE * stepPercent) / 100,
          -4,
        );
      }

      // A pause removes them.
      await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId: awaiting });
      await schedule([ticket.id]);
      expect(
        await queue.getJob(
          slaTimerJobId({ ticketId: ticket.id, clock: 'resolution', stepPercent: 100 }),
        ),
      ).toBeUndefined();
    });

    it('fires the steps once: warning, breach and escalation, then post-breach actions', async () => {
      const { ticket } = await createTicket({ priority: 'medium' });
      const started = (await clockOf(ticket.id, 'resolution')).startedAt.getTime();
      const deps = slaDeps();
      const fire = (stepPercent: number, at: number) =>
        withSystem(runtime.db, seeded.brandId, (tx) =>
          fireSlaTimer(
            tx,
            deps,
            { brandId: seeded.brandId, ticketId: ticket.id, clock: 'resolution', stepPercent },
            new Date(at),
          ),
        );

      expect(await fire(50, started + 60 * MINUTE)).toMatchObject({ kind: 'early' });
      expect(await fire(50, started + 241 * MINUTE)).toEqual({ kind: 'fired' });
      expect(await fire(50, started + 242 * MINUTE)).toEqual({ kind: 'done' });
      expect(
        (await outboxOf('sla.warning')).find((payload) => payload.ticketId === ticket.id),
      ).toMatchObject({
        clock: 'resolution',
        stepPercent: 50,
        departmentLeads: true,
        userIds: [],
        teamIds: [],
      });

      expect(await fire(100, started + 481 * MINUTE)).toEqual({ kind: 'fired' });
      const breached = await clockOf(ticket.id, 'resolution');
      expect(breached.breachedAt?.getTime()).toBe(started + 480 * MINUTE);
      expect(
        (await outboxOf('sla.breached')).find((payload) => payload.ticketId === ticket.id),
      ).toMatchObject({
        clock: 'resolution',
        cause: 'timer',
      });
      expect(
        (await outboxOf('ticket.escalated')).some((payload) => payload.ticketId === ticket.id),
      ).toBe(true);

      const escalated = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({
            systemState: ticketStatuses.systemState,
            priority: tickets.priority,
            breached: tickets.slaBreached,
          })
          .from(tickets)
          .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
          .where(eq(tickets.id, ticket.id)),
      );
      expect(escalated[0]).toMatchObject({
        systemState: 'escalated',
        priority: 'medium',
        breached: true,
      });

      // Past the breach: priority raised, which the clocks follow (§3.3), and
      // the tag added. The steps already fired stay fired.
      expect(await fire(150, started + 721 * MINUTE)).toEqual({ kind: 'fired' });
      const after = await clockOf(ticket.id, 'resolution');
      expect(after.targetMinutes).toBe(240);
      expect(after.firedSteps.map((step) => step.percent)).toEqual([50, 100, 150]);
      const read = await call<TicketDetail>('GET', `${brandPath()}/tickets/${ticket.id}`, ada);
      expect(read.body.ticket.priority).toBe('high');
      expect(read.body.ticket.tags?.map((tag) => tag.id)).toContain(tagId);
      expect(read.body.sla).toMatchObject({ state: 'breached', lastStep: { percent: 150 } });
    });

    it('recreates every timer after Redis is wiped and the worker restarts (M3 exit criterion)', async () => {
      const tickets = await Promise.all([
        createTicket(),
        createTicket(),
        createTicket({ priority: 'high' }),
      ]);
      const ids = tickets.map(({ ticket }) => ticket.id);
      await schedule(ids);

      const expected = await Promise.all(
        ids.flatMap((ticketId) =>
          ['first_response', 'resolution'].flatMap((clock) =>
            [50, 100, 150].map(async (stepPercent) => {
              const jobId = slaTimerJobId({ ticketId, clock: clock as 'resolution', stepPercent });
              const job = await queue.getJob(jobId);
              return { jobId, fireAt: (job?.timestamp ?? 0) + (job?.delay ?? 0) };
            }),
          ),
        ),
      );
      expect(expected.every(({ fireAt }) => fireAt > 0)).toBe(true);

      await redis.flushall();
      expect(await queue.getJob(expected[0]?.jobId ?? '')).toBeUndefined();

      const connection = createQueueConnection(redisContainer.getConnectionUrl());
      const worker = workerDependencies.createSlaWorker({
        redis: connection,
        db: runtime.db,
        log: silentLogger,
      });
      try {
        const deadline = Date.now() + 30_000;
        let missing = expected;
        while (missing.length > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const states = await Promise.all(
            missing.map(async (entry) =>
              (await queue.getJob(entry.jobId)) === undefined ? entry : null,
            ),
          );
          missing = states.filter((entry) => entry !== null);
        }
        expect(missing).toEqual([]);

        for (const { jobId, fireAt } of expected) {
          const job = await queue.getJob(jobId);
          expect(await job?.getState()).toBe('delayed');
          expect(Math.abs((job?.timestamp ?? 0) + (job?.delay ?? 0) - fireAt)).toBeLessThan(5_000);
        }
      } finally {
        await worker.close();
        connection.disconnect();
      }
    });
  });

  // ------------------------------------------------------------ M3 exit criterion

  describe('a breach, its escalation and the notification (M3 exit criterion)', () => {
    const frames: RealtimeBroadcastInput[] = [];

    /**
     * What the relay and the `outbox.event` worker do with this ticket's rows of
     * these events: each goes through the process-wide dispatcher, where M3-07's
     * handlers are registered as the worker registers them.
     */
    const dispatchRows = async (ticketId: string, events: readonly string[]) => {
      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(outbox)
          .where(
            and(
              inArray(outbox.event, [...events]),
              sql`(${outbox.payload}->>'ticketId' = ${ticketId} OR ${outbox.event} = 'notification.created')`,
            ),
          )
          .orderBy(asc(outbox.id)),
      );
      for (const row of rows.filter((candidate) => !dispatched.has(candidate.id))) {
        dispatched.add(row.id);
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          outboxEvents.dispatch({
            outboxId: row.id,
            brandId: row.brandId,
            event: row.event,
            payload: row.payload,
            tx,
            log: silentLogger,
          }),
        );
      }
      return rows;
    };
    const dispatched = new Set<string>();

    beforeAll(() => {
      registerNotificationHandlers({
        repository: new NotificationsRepository(),
        broadcast: { emit: async (input) => void frames.push(input) },
        pushConfigured: async () => false,
        queue: {
          addEmailSchedule: async () => undefined,
          addPush: async () => undefined,
          addEmailTest: async () => undefined,
        },
      });
    });

    it('publishes SLA reassignment and delivers its assignment notification', async () => {
      const saved = await call<SlaPolicy>('PUT', `${brandPath()}/sla-policies/${policy.id}`, ada, {
        ...policyBody(),
        escalation: [{ atPercent: 100, actions: [{ type: 'reassign', userId: sam.id }] }],
      });
      expect(saved.status).toBe(200);
      const { ticket } = await createTicket();
      const clock = await clockOf(ticket.id, 'first_response');
      const payload = {
        brandId: seeded.brandId,
        ticketId: ticket.id,
        clock: 'first_response' as const,
        stepPercent: 100,
      };
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        fireSlaTimer(tx, slaDeps(), payload, new Date((clock.dueAt?.getTime() ?? 0) + MINUTE)),
      );
      const assigned = await dispatchRows(ticket.id, ['ticket.assigned']);
      expect(assigned.map((row) => row.payload)).toEqual([
        expect.objectContaining({ assigneeId: sam.id, assignedBy: 'sla', actorId: null }),
      ]);
      const notices = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(notifications).where(eq(notifications.ticketId, ticket.id)),
      );
      expect(notices).toEqual([
        expect.objectContaining({
          userId: sam.id,
          kind: 'assigned',
          detail: { assignedBy: 'sla' },
        }),
      ]);
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        fireSlaTimer(tx, slaDeps(), payload, new Date((clock.dueAt?.getTime() ?? 0) + 2 * MINUTE)),
      );
      expect(
        (await outboxOf('ticket.assigned')).filter((row) => row.ticketId === ticket.id),
      ).toHaveLength(1);
    });

    it('breaches the first response, escalates to the person the step names, and tells them', async () => {
      const saved = await call<SlaPolicy>('PUT', `${brandPath()}/sla-policies/${policy.id}`, ada, {
        ...policyBody(),
        escalation: [
          {
            atPercent: 100,
            actions: [
              { type: 'notify', recipient: { kind: 'user', userId: sam.id } },
              { type: 'set_escalated' },
            ],
          },
        ],
      });
      expect(saved.status).toBe(200);

      // 1. A ticket under the policy passes its first-response target.
      const { ticket } = await createTicket();
      const clock = await clockOf(ticket.id, 'first_response');
      expect(clock.policyId).toBe(policy.id);
      const dueAt = clock.dueAt?.getTime() ?? 0;
      expect(
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          fireSlaTimer(
            tx,
            slaDeps(),
            {
              brandId: seeded.brandId,
              ticketId: ticket.id,
              clock: 'first_response',
              stepPercent: 100,
            },
            new Date(dueAt + MINUTE),
          ),
        ),
      ).toEqual({ kind: 'fired' });

      // 2. `sla.breached` and the escalation fire, the escalation naming Sam.
      const written = await dispatchRows(ticket.id, ['sla.breached', 'ticket.escalated']);
      expect(written.map((row) => row.event).sort()).toEqual(['sla.breached', 'ticket.escalated']);
      expect(written.find((row) => row.event === 'ticket.escalated')?.payload).toMatchObject({
        clock: 'first_response',
        stepPercent: 100,
        userIds: [sam.id],
        teamIds: [],
        departmentLeads: false,
      });
      expect((await clockOf(ticket.id, 'first_response')).breachedAt).not.toBeNull();

      // 3. A notification for Sam, and nobody else: nobody holds the ticket, so
      //    the breach itself has no one to tell.
      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(notifications).where(eq(notifications.ticketId, ticket.id)),
      );
      expect(rows.map((row) => [row.userId, row.kind])).toEqual([[sam.id, 'escalated']]);
      expect(rows[0]?.detail).toEqual({ clock: 'first_response', stepPercent: 100 });

      // … and `notification.created`, whose handler tells Sam's open screens.
      const created = await dispatchRows(ticket.id, ['notification.created']);
      expect(
        created.some(
          (row) =>
            row.event === 'notification.created' && row.payload.notificationId === rows[0]?.id,
        ),
      ).toBe(true);
      expect(frames).toContainEqual({
        rooms: [userRoom(sam.id)],
        event: REALTIME_EVENTS.notificationCreated,
        data: { brandId: seeded.brandId, notificationId: rows[0]?.id },
        seq: null,
      });
    });

    it('pauses a ticket set to Awaiting customer, so its timer breaches nothing', async () => {
      const { ticket } = await createTicket();
      const due = (await clockOf(ticket.id, 'resolution')).dueAt?.getTime() ?? 0;

      const paused = await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
        statusId: awaiting,
      });
      expect(paused.status).toBe(200);

      const resolution = await clockOf(ticket.id, 'resolution');
      expect(resolution.pausedAt).not.toBeNull();
      expect(resolution.dueAt).toBeNull();

      // Its timer fires on time, and the paused clock ends it without a breach.
      expect(
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          fireSlaTimer(
            tx,
            slaDeps(),
            { brandId: seeded.brandId, ticketId: ticket.id, clock: 'resolution', stepPercent: 100 },
            new Date(due + MINUTE),
          ),
        ),
      ).toEqual({ kind: 'done' });
      expect((await clockOf(ticket.id, 'resolution')).breachedAt).toBeNull();
      expect(
        (await outboxOf('sla.breached')).some((payload) => payload.ticketId === ticket.id),
      ).toBe(false);
    });
  });
});
