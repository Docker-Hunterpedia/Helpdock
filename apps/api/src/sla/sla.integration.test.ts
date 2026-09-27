import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  type Db,
  type DbHandle,
  departments,
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
import { createQueueConnection, QUEUE_NAMES, silentLogger, slaTimerJobId } from '@helpdock/jobs';
import {
  type BrandSettings,
  type BusinessHoursOverview,
  type Holiday,
  isWithinBusinessHours,
  type SlaPolicy,
  type SlaPolicyList,
  type TicketDetail,
  type TicketList,
  type TicketStatusList,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { workerDependencies } from '../worker/start-worker.js';
import { BusinessHoursService } from './business-hours.service.js';
import { fireSlaTimer } from './escalation.js';
import { SlaRepository } from './sla.repository.js';
import { SlaService } from './sla.service.js';
import { SLA_SCHEDULE_EVENT } from './sla-events.js';
import { bullTimerQueue } from './sla-timers.js';
import { createSlaScheduleHandler, type SlaWorkerDeps } from './sla-worker.js';

/**
 * M3-01 and M3-02 against a real Postgres and a real Redis, over real
 * sessions: the two tabs, the clocks as the ticket routes move them, the
 * escalation a timer runs, and the M3 exit criterion — "deleting Redis while
 * tickets are open and restarting the worker recreates every timer".
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
const PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;
const MINUTE = 60_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

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

  const signIn = async (email: string, password: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password }),
    });
    const body = response.json() as { kind: string; accessToken?: string };
    if (body.kind !== 'session' || body.accessToken === undefined) {
      throw new Error(`sign-in did not produce a session: ${response.body}`);
    }
    return body.accessToken;
  };

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

  const slaDeps = (): SlaWorkerDeps => {
    const repository = new SlaRepository();
    return {
      repository,
      sla: new SlaService(repository),
      assignment: new AssignmentRepository(),
      timers: bullTimerQueue(queue),
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

  // ------------------------------------------------------------ timers

  describe('timers', () => {
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
        notify: { departmentLeads: true, userIds: [], teamIds: [] },
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
});
