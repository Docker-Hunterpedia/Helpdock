import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EmailMessage } from '@helpdock/channels';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  type Db,
  type DbHandle,
  departments,
  notifications,
  outbox,
  ticketMessages,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  enqueueOutbox,
  type NotifyEmailPayload,
  type NotifyPushPayload,
  notifyEmailJob,
  silentLogger,
} from '@helpdock/jobs';
import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
  type NotificationList,
  type NotificationPreferencesView,
  type PushSubscriptionView,
  REALTIME_EVENTS,
  type TicketDetail,
  userRoom,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import type { RealtimeBroadcastInput } from '../realtime/broadcast.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { createNotifyProcessor } from './delivery.js';
import {
  CONSUMED_EVENTS,
  createFanOutHandler,
  createNotificationCreatedHandler,
  NOTIFICATION_EVENTS,
} from './notification-events.js';
import { NotificationsRepository } from './notifications.repository.js';

/**
 * M3-07 against a real Postgres and Redis, over real sessions.
 *
 * The unit suites prove who is told from values. This proves what only exists
 * with a database under it: that a ticket change leaves the event, that the
 * fan-out writes rows the owner policy keeps to their recipient, that the
 * panel hides a ticket its reader cannot see, and that one notification is one
 * email however often its job runs (DOMAIN-RULES §6).
 *
 * The SLA engine and the rules engine are other deliverables, so their events
 * are written here by hand, under the names the seam agrees.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
const PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M3-07 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('notifications', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  /** An Agent of Support. */
  let sam: Person;
  /** An Agent of Billing only. */
  let bo: Person;
  /** The install admin. */
  let ada: Person;

  const repository = new NotificationsRepository();
  const frames: RealtimeBroadcastInput[] = [];
  const emailJobs: NotifyEmailPayload[] = [];
  const pushJobs: NotifyPushPayload[] = [];
  const handled = new Set<string>();

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
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

  /**
   * What the worker does with the outbox, for the two hops this module owns:
   * every consumed event not yet handled goes through the fan-out, then every
   * `notification.created` through delivery. The relay and BullMQ are M0's and
   * proved there.
   */
  const drain = async (): Promise<void> => {
    const fanOut = createFanOutHandler({ repository, pushConfigured: async () => false });
    const created = createNotificationCreatedHandler({
      repository,
      broadcast: { emit: async (input) => void frames.push(input) },
      queue: {
        addEmail: async (_jobId, payload) => void emailJobs.push(payload),
        addPush: async (_jobId, payload) => void pushJobs.push(payload),
      },
    });

    for (const events of [[...CONSUMED_EVENTS], [NOTIFICATION_EVENTS.created]]) {
      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(outbox)
          .where(inArray(outbox.event, events))
          .orderBy(asc(outbox.createdAt), asc(outbox.id)),
      );
      for (const row of rows.filter((candidate) => !handled.has(candidate.id))) {
        handled.add(row.id);
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          (row.event === NOTIFICATION_EVENTS.created ? created : fanOut)({
            outboxId: row.id,
            brandId: row.brandId,
            event: row.event,
            payload: row.payload,
            tx,
            log: silentLogger,
          }),
        );
      }
    }
  };

  const emit = async (event: string, payload: Record<string, unknown>): Promise<void> => {
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      enqueueOutbox(tx, { brandId: seeded.brandId, event, payload }),
    );
  };

  const panelOf = async (who: Person, filter = 'all') => {
    const response = await call<NotificationList>(
      'GET',
      `${brandPath()}/notifications?filter=${filter}`,
      who,
    );
    expect(response.status).toBe(200);

    return response.body;
  };

  const rowsFor = (userId: string) =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(notifications).where(eq(notifications.userId, userId)),
    );

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

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(runtime.db, 'Sam');
    bo = await addPerson(runtime.db, 'Bo');

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing', nameAr: 'الفوترة' },
        ])
        .returning({ id: departments.id, name: departments.name });
      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';

      await tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: bo.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
      ]);
    });

    ada.token = await signIn(seeded.email, seeded.password);
    sam.token = await signIn(sam.email, PASSWORD);
    bo.token = await signIn(bo.email, PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('assignment', () => {
    let ticketId: string;

    it('tells the person a ticket is given to, in the bell and nowhere else', async () => {
      ticketId = (await createTicket({ assigneeId: sam.id })).ticket.id;
      await drain();

      const panel = await panelOf(sam);
      expect(panel.unreadCount).toBe(1);
      expect(panel.items).toEqual([
        expect.objectContaining({
          kind: 'assigned',
          ticketId,
          subject: 'Refund for order 42',
          departmentName: 'Support',
          actorName: expect.any(String),
          detail: { assignedBy: 'person' },
          readAt: null,
        }),
      ]);
      expect(frames).toContainEqual({
        rooms: [userRoom(sam.id)],
        event: REALTIME_EVENTS.notificationCreated,
        data: { brandId: seeded.brandId, notificationId: panel.items[0]?.id },
        seq: null,
      });
      // Nobody else hears about it — the Admin who assigned it included.
      expect((await panelOf(ada)).items).toEqual([]);
      expect((await panelOf(bo)).items).toEqual([]);
    });

    it('keeps one person’s notification from everyone else, even an Admin', async () => {
      const [mine] = (await panelOf(sam)).items;
      const foreign = await call('POST', `${brandPath()}/notifications/${mine?.id}/read`, ada);

      expect(foreign.status).toBe(404);
    });

    it('marks one read, and then all of them', async () => {
      const [mine] = (await panelOf(sam)).items;

      expect(
        (await call('POST', `${brandPath()}/notifications/${mine?.id}/read`, sam)).status,
      ).toBe(204);
      expect((await panelOf(sam, 'unread')).items).toEqual([]);

      await emit('sla.warning', { ticketId, clock: 'resolution', stepPercent: 80 });
      await drain();
      expect((await panelOf(sam)).unreadCount).toBe(1);

      expect((await call('POST', `${brandPath()}/notifications/read-all`, sam)).status).toBe(204);
      expect((await panelOf(sam)).unreadCount).toBe(0);
    });

    it('writes one row per recipient however often the event is delivered', async () => {
      const before = (await rowsFor(sam.id)).length;
      handled.clear();
      await drain();

      expect((await rowsFor(sam.id)).length).toBe(before);
    });
  });

  describe('mentions', () => {
    it('tells whoever a note names who can see the ticket, and quotes it', async () => {
      const ticket = (await createTicket()).ticket;
      const note = await call('POST', `${brandPath()}/tickets/${ticket.id}/messages`, ada, {
        kind: 'note',
        bodyHtml: '<p>@Sam and @Bo, can you confirm from finance?</p>',
      });
      expect(note.status).toBe(201);
      await drain();

      const [mention] = (await panelOf(sam)).items;
      expect(mention).toMatchObject({
        kind: 'mentioned',
        ticketId: ticket.id,
        excerpt: '@Sam and @Bo, can you confirm from finance?',
      });
      // Bo works Billing and cannot see a Support ticket (DOMAIN-RULES §1.2).
      expect((await panelOf(bo)).items).toEqual([]);
    });
  });

  describe('replies', () => {
    it('tells the assignee when the contact answers', async () => {
      const ticket = (await createTicket({ assigneeId: sam.id })).ticket;
      const messageId = uuidv7();
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await tx.insert(ticketMessages).values({
          id: messageId,
          brandId: seeded.brandId,
          ticketId: ticket.id,
          departmentId: support,
          seq: 2,
          kind: 'public',
          authorType: 'contact',
          authorId: uuidv7(),
          bodyHtml: '<p>Any news?</p>',
          bodyText: 'Any news?',
          channel: 'email',
        });
        await enqueueOutbox(tx, {
          brandId: seeded.brandId,
          event: 'ticket.replied',
          payload: {
            ticketId: ticket.id,
            departmentId: support,
            messageId,
            seq: 2,
            kind: 'public',
          },
        });
      });
      await drain();

      expect((await panelOf(sam)).items[0]).toMatchObject({
        kind: 'replied',
        excerpt: 'Any news?',
        messageChannel: 'email',
      });
    });
  });

  describe('SLA and escalation, from the events the SLA engine writes', () => {
    it('tells the team about a breach nobody holds, and follows each member’s settings', async () => {
      const ticket = (await createTicket({ departmentId: billing })).ticket;
      const turnedOff = {
        ...NOTIFICATION_PREFERENCE_DEFAULTS,
        escalated: { inApp: false, email: true, push: false },
      };
      expect(
        (await call('PUT', '/api/me/notification-preferences', bo, { preferences: turnedOff }))
          .status,
      ).toBe(200);

      await emit('sla.breached', { ticketId: ticket.id, clock: 'first_response' });
      await emit('ticket.escalated', { ticketId: ticket.id, userIds: [bo.id], stepPercent: 120 });
      await drain();

      const kinds = (await rowsFor(bo.id)).map((row) => [row.kind, row.inApp]);
      // No assignee and no team: the breach tells nobody; the escalation names Bo,
      // whose in-app switch for escalations is off, so it is email only.
      expect(kinds).toEqual([['escalated', false]]);
      expect((await panelOf(bo)).items).toEqual([]);
      expect(emailJobs.map((job) => job.notificationId)).toContain((await rowsFor(bo.id))[0]?.id);
    });
  });

  describe('email delivery', () => {
    it('sends one email per notification, however often its job runs', async () => {
      const [row] = await rowsFor(bo.id);
      const sent: EmailMessage[] = [];
      const processor = createNotifyProcessor(
        {
          repository,
          appUrl: 'https://support.example.com',
          push: { send: async () => 'sent' },
          settings: {
            systemSender: async () => ({ send: async (message) => void sent.push(message) }),
            vapidKeys: async () => null,
          },
        },
        { db: runtime.db },
      );
      const job = {
        name: notifyEmailJob.name,
        id: `notify.email.${row?.id}`,
        data: { brandId: seeded.brandId, notificationId: row?.id },
      } as Job;

      await processor(job);
      await processor(job);

      expect(sent).toHaveLength(1);
      expect(sent[0]?.to.address).toBe(bo.email);
      expect(sent[0]?.subject).toMatch(/^\[.+\] Escalated: Refund for order 42$/);
      expect(sent[0]?.text).toContain('Department: Billing');
    });
  });

  describe('preferences and browsers', () => {
    it('starts from the defaults and says push is not set up without VAPID keys', async () => {
      const response = await call<NotificationPreferencesView>(
        'GET',
        '/api/me/notification-preferences',
        sam,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        preferences: NOTIFICATION_PREFERENCE_DEFAULTS,
        email: sam.email,
        push: { configured: false, publicKey: null, subscriptions: [] },
      });
    });

    it('refuses a preference set that leaves a kind out', async () => {
      const { escalated: _left, ...partial } = NOTIFICATION_PREFERENCE_DEFAULTS;

      expect(
        (await call('PUT', '/api/me/notification-preferences', sam, { preferences: partial }))
          .status,
      ).toBe(400);
    });

    it('keeps one row per browser, and a browser that signs in as somebody else moves', async () => {
      const body = {
        endpoint: `https://push.example.com/${uuidv7()}`,
        keys: { p256dh: 'BPublicKey', auth: 'AuthSecret' },
        label: 'Chrome on macOS',
      };
      const first = await call<PushSubscriptionView>(
        'POST',
        '/api/me/push-subscriptions',
        sam,
        body,
      );
      expect(first.status).toBe(201);

      const moved = await call<PushSubscriptionView>(
        'POST',
        '/api/me/push-subscriptions',
        bo,
        body,
      );
      expect(moved.body.id).toBe(first.body.id);

      const samView = await call<NotificationPreferencesView>(
        'GET',
        '/api/me/notification-preferences',
        sam,
      );
      expect(samView.body.push.subscriptions).toEqual([]);

      expect(
        (await call('DELETE', `/api/me/push-subscriptions/${first.body.id}`, sam)).status,
      ).toBe(404);
      expect((await call('DELETE', `/api/me/push-subscriptions/${first.body.id}`, bo)).status).toBe(
        204,
      );
    });

    it('refuses an http endpoint, which a browser never issues', async () => {
      expect(
        (
          await call('POST', '/api/me/push-subscriptions', sam, {
            endpoint: 'http://push.example.com/abc',
            keys: { p256dh: 'BPublicKey', auth: 'AuthSecret' },
          })
        ).status,
      ).toBe(400);
    });

    it('refuses a test push on an install without keys', async () => {
      expect(
        (
          await call('POST', `${brandPath()}/notifications/test-push`, sam, {
            subscriptionId: uuidv7(),
          })
        ).status,
      ).toBe(409);
    });
  });
});
