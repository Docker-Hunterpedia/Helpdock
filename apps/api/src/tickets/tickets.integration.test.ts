import { createKeyring, decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  brands,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  type DbTransaction,
  departments,
  importExternalIds,
  metaAccounts,
  metaConversations,
  outbox,
  seedBrandStatuses,
  ticketActivity,
  ticketMessages,
  ticketSearchTokens,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  withTenant,
  workflowRules,
} from '@helpdock/db';
import { outboxEvents, silentLogger } from '@helpdock/jobs';
import type { ContactStats, ErrorResponse } from '@helpdock/schemas';
import {
  departmentRoom,
  REALTIME_EVENTS,
  type RoomAck,
  SOCKET_IO_PATH,
  STAFF_NAMESPACE,
  type Ticket,
  type TicketActivityList,
  type TicketDetail,
  type TicketList,
  type TicketMessage,
  type TicketMessagePage,
  type TicketRouting,
  type TicketStatus,
  type TicketStatusList,
  type TicketStatusUsage,
  ticketListQuerySchema,
  ticketRoom,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { registerContactEventHandlers } from '../contacts/contact-events.js';
import { CsatRepository } from '../csat/csat.repository.js';
import { registerCsatEventHandlers } from '../csat/csat-events.js';
import { CsatTokens } from '../csat/tokens.js';
import { createLogger } from '../logging/logger.js';
import { registerNotificationHandlers } from '../notifications/notification-events.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { RedisRealtimeBroadcast } from '../realtime/broadcast.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { noCsatDelivery } from '../testing/csat-doubles.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { ignoreAuthEmailInThisSuite, signInForTest } from '../testing/staff-sign-in.js';
import { registerTicketOutboxForTest } from '../testing/ticket-outbox.js';
import type { SearchMode } from './ticket-query.js';
import { TicketRepository } from './tickets.repository.js';

/**
 * M1-02 and M1-03 against a real Postgres and a real Redis, over real sessions.
 *
 * The unit suites prove each piece decides correctly. This proves the four
 * things that exist only when the pieces are together:
 *
 * 1. **Department scope is real.** An Agent of Support cannot reach a Billing
 *    ticket of the *same brand* — by list, by id, by message cursor, by
 *    activity, by write, by hand-written SQL, or by socket room
 *    (DOMAIN-RULES §1.3, §1.6).
 * 2. **`seq` is monotonic and dense under contention**, and a retried send is
 *    one message (DOMAIN-RULES §7).
 * 3. **The outbox commits and rolls back with the change** (DOMAIN-RULES §6).
 * 4. **The event reaches a socket in the ticket's room** and nobody in another
 *    department, over the worker → Redis → replica path the real deployment
 *    uses (§7).
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 21).toString('base64');
const AGENT_PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the ticket integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('tickets', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let worker: Redis;
  let seeded: SeededInstall;
  let url: string;

  /** One brand with two departments, and one agent confined to each. */
  let support: string;
  let billing: string;
  let sam: Person;
  let bo: Person;
  /** The install admin, whose department scope is `all`. */
  let ada: Person;
  /** A second brand, so "another brand" is a real place. */
  let otherBrand: string;
  let otherDepartment: string;
  let ola: Person;

  let openStatus: string;
  let closedStatus: string;
  let otherBrandStatus: string;

  const open: Socket[] = [];

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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
        // A 204 carries no body, and `json()` on an empty payload throws. The
        // callers that use one assert on the status alone.
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const brandPath = (brandId: string) => `/api/brands/${brandId}`;

  const signIn = (email: string, password: string): Promise<string> =>
    signInForTest(app, { email, password });

  const createTicket = async (
    who: Person,
    body: Record<string, unknown> = {},
  ): Promise<TicketDetail> => {
    const response = await call<TicketDetail>('POST', `${brandPath(seeded.brandId)}/tickets`, who, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      departmentId: support,
      ...body,
    });

    expect(response.status).toBe(201);
    return response.body;
  };

  const connect = (who: Person): Promise<Socket> => {
    const socket = io(`${url}${STAFF_NAMESPACE}`, {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      auth: { token: who.token },
      reconnection: false,
    });
    open.push(socket);

    return new Promise<Socket>((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  };

  const join = (socket: Socket, room: string): Promise<RoomAck> =>
    socket.emitWithAck(REALTIME_EVENTS.roomJoin, { brandId: seeded.brandId, room });

  /**
   * Runs the registered handler for every unpublished row of this brand, which
   * is what the worker's `outbox.event` consumer does with them. The relay and
   * BullMQ are proved in `packages/jobs`; what this suite needs is the handler
   * on the far side of a committed row.
   */
  const drainOutbox = async (brandId = seeded.brandId): Promise<number> => {
    const rows = await withSystem(runtime.db, brandId, (tx) =>
      tx.select().from(outbox).where(sql`${outbox.publishedAt} is null`).orderBy(outbox.id),
    );

    for (const row of rows) {
      await withSystem(runtime.db, row.brandId, async (tx) => {
        await outboxEvents.dispatch({
          outboxId: row.id,
          brandId: row.brandId,
          event: row.event,
          payload: row.payload,
          tx,
          log: silentLogger,
        });
        await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
      });
    }

    return rows.length;
  };

  const unpublished = (brandId = seeded.brandId) =>
    withSystem(runtime.db, brandId, (tx) =>
      tx.select().from(outbox).where(sql`${outbox.publishedAt} is null`),
    );

  const eventually = async (predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = await app.getUrl();

    // The worker's half, in this process: the handlers a worker registers at
    // start-up, publishing on a connection of its own exactly as it would.
    worker = new Redis(redisContainer.getConnectionUrl());
    registerTicketOutboxForTest(new RedisRealtimeBroadcast(worker));
    // M8-03: every contact the suite makes writes `contact.created`.
    registerContactEventHandlers();
    ignoreAuthEmailInThisSuite();
    // M1-12: a close writes `csat.requested` too, and the worker handles it.
    registerCsatEventHandlers({
      repository: new CsatRepository(),
      tokens: new CsatTokens(createKeyring(envFor())),
      delivery: noCsatDelivery,
    });
    // M3-07: an assignment writes `ticket.assigned`, a note or reply is also
    // the notifications module's, and the worker handles both.
    registerNotificationHandlers({
      repository: new NotificationsRepository(),
      broadcast: new RedisRealtimeBroadcast(worker),
      pushConfigured: async () => false,
      queue: {
        addEmailSchedule: async () => undefined,
        addPush: async () => undefined,
        addEmailTest: async () => undefined,
      },
    });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    await seed(runtime.db);
  }, 300_000);

  afterEach(() => {
    for (const socket of open.splice(0)) {
      socket.disconnect();
    }
  });

  afterAll(async () => {
    await worker?.quit();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  const addPerson = async (db: Db, name: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }

    const id = uuidv7();
    const email = `${name}-${id}@helpdock.test`;
    await db.insert(users).values({
      id,
      email,
      name,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(AGENT_PASSWORD),
    });

    return { id, email, token: '' };
  };

  const seed = async (db: Db): Promise<void> => {
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(db, 'sam');
    bo = await addPerson(db, 'bo');
    ola = await addPerson(db, 'ola');

    otherBrand = uuidv7();
    await db.insert(brands).values({ id: otherBrand, name: 'Globex', prefix: 'GLX' });

    await withSystem(db, seeded.brandId, async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });

      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';

      await tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: bo.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
      ]);
    });

    await withSystem(db, otherBrand, async (tx) => {
      await seedBrandStatuses(tx, otherBrand);
      const [created] = await tx
        .insert(departments)
        .values({ brandId: otherBrand, name: 'General' })
        .returning({ id: departments.id });
      otherDepartment = created?.id ?? '';
      await tx
        .insert(userBrandRoles)
        .values({ userId: ola.id, brandId: otherBrand, role: 'admin', departmentIds: null });
    });

    ada.token = await signIn(seeded.email, seeded.password);
    sam.token = await signIn(sam.email, AGENT_PASSWORD);
    bo.token = await signIn(bo.email, AGENT_PASSWORD);
    ola.token = await signIn(ola.email, AGENT_PASSWORD);

    const statuses = await call<TicketStatusList>(
      'GET',
      `${brandPath(seeded.brandId)}/ticket-statuses`,
      ada,
    );
    openStatus = statuses.body.statuses.find((status) => status.isDefault)?.id ?? '';
    closedStatus = statuses.body.statuses.find((status) => status.name === 'Closed')?.id ?? '';

    const theirs = await call<TicketStatusList>(
      'GET',
      `${brandPath(otherBrand)}/ticket-statuses`,
      ola,
    );
    otherBrandStatus = theirs.body.statuses[0]?.id ?? '';
  };

  // ----------------------------------------------------------------- statuses

  describe('statuses', () => {
    it('seeds every brand with the built-in seven (DOMAIN-RULES §2.1, §2.4, M14-02)', async () => {
      const { body } = await call<TicketStatusList>(
        'GET',
        `${brandPath(seeded.brandId)}/ticket-statuses`,
        sam,
      );

      expect(body.statuses.map((status) => status.name).sort()).toEqual([
        'Awaiting customer',
        'Closed',
        'Escalated',
        'Merged',
        'Open',
        'Snoozed',
        'Spam',
      ]);
    });

    it('shows a brand only its own statuses', async () => {
      const { body } = await call<TicketStatusList>(
        'GET',
        `${brandPath(otherBrand)}/ticket-statuses`,
        ola,
      );

      expect(body.statuses.map((status) => status.id)).not.toContain(closedStatus);
    });

    it('seeds idempotently, so a retried brand creation adds nothing', async () => {
      await withSystem(runtime.db, otherBrand, (tx) => seedBrandStatuses(tx, otherBrand));

      const { body } = await call<TicketStatusList>(
        'GET',
        `${brandPath(otherBrand)}/ticket-statuses`,
        ola,
      );

      expect(body.statuses).toHaveLength(7);
    });
  });

  // --------------------------------------------------------------- creating

  describe('imported provenance and source filters', () => {
    it('pages all historical activity through equal/sub-millisecond timestamps and refuses another ticket cursor', async () => {
      const visible = await createTicket(sam);
      const hidden = await createTicket(bo, { departmentId: billing });
      const eventIds = Array.from({ length: 205 }, () => uuidv7());
      const path = `${brandPath(seeded.brandId)}/tickets/${visible.ticket.id}`;
      try {
        await withSystem(runtime.db, seeded.brandId, async (tx) => {
          await tx.insert(ticketActivity).values(
            eventIds.map((id, index) => ({
              id,
              brandId: seeded.brandId,
              departmentId: support,
              ticketId: visible.ticket.id,
              actorType: 'system' as const,
              actorId: 'import:zendesk:old-author',
              action: 'ticket.imported.event',
              from: { field: 'status', value: 'open' },
              to: {
                changes: { field: 'status', value: 'closed' },
                sourceEvent: {
                  source: 'zendesk',
                  action: 'zendesk.Change',
                  authorDisplay: 'Sara Ali',
                },
              },
              via: 'system' as const,
              createdAt:
                index % 2
                  ? sql`'2001-01-01T10:00:00.123456Z'::timestamptz`
                  : sql`'2001-01-01T10:00:00.123789Z'::timestamptz`,
            })),
          );
        });
        const first = await call<TicketDetail>('GET', path, sam);
        expect(first.body.activity).toHaveLength(100);
        const rows = [...first.body.activity];
        let before = first.body.activityNextBefore;
        for (let page = 0; page < 4 && before; page++) {
          const next = await call<TicketActivityList>(
            'GET',
            `${path}/activity?before=${before}&limit=100`,
            sam,
          );
          expect(next.status).toBe(200);
          expect(next.body.activity.length).toBeLessThanOrEqual(100);
          rows.push(...next.body.activity);
          before = next.body.nextBefore;
        }
        expect(before).toBeNull();
        expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
        expect(rows.filter((row) => eventIds.includes(row.id))).toHaveLength(eventIds.length);
        const foreignCursor = hidden.activity[0]?.id;
        if (!foreignCursor) throw new Error('Missing activity cursor fixture');
        expect((await call('GET', `${path}/activity?before=${foreignCursor}`, sam)).status).toBe(
          400,
        );
        expect((await call('GET', `${path}/activity?limit=101`, sam)).status).toBe(400);
        expect(
          (
            await call(
              'GET',
              `${brandPath(seeded.brandId)}/tickets/${hidden.ticket.id}/activity`,
              sam,
            )
          ).status,
        ).toBe(404);
      } finally {
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.delete(tickets).where(inArray(tickets.id, [visible.ticket.id, hidden.ticket.id])),
        );
      }
    });

    it('resolves source numbers and former-agent names without widening department reads, including after an edit', async () => {
      const visible = await createTicket(sam);
      const hidden = await createTicket(bo, { departmentId: billing });
      const native = await createTicket(sam);
      const ids = [visible.ticket.id, hidden.ticket.id, native.ticket.id];
      const sourceNumber = '999000001';
      try {
        await withSystem(runtime.db, seeded.brandId, async (tx) => {
          await tx
            .update(tickets)
            .set({ importedAt: new Date('2015-01-01T00:00:00Z'), importSource: 'zendesk' })
            .where(inArray(tickets.id, ids.slice(0, 2)));
          await tx.insert(importExternalIds).values(
            ids.slice(0, 2).map((id) => ({
              brandId: seeded.brandId,
              source: 'zendesk' as const,
              sourceAccountKey: 'a'.repeat(64),
              entity: 'ticket' as const,
              externalId: `archive-${id}`,
              helpdockId: id,
              sourceNumber,
              sourceUrl: `https://support.example/agent/tickets/${sourceNumber}?token=private#secret`,
              payloadHash: 'f'.repeat(64),
            })),
          );
          await tx
            .update(ticketMessages)
            .set({ authorType: 'system', authorId: null, authorDisplay: 'سارة القديمة' })
            .where(eq(ticketMessages.ticketId, visible.ticket.id));
        });
        const detail = await call<TicketDetail>(
          'GET',
          `${brandPath(seeded.brandId)}/tickets/${visible.ticket.id}`,
          sam,
        );
        expect(detail.body.ticket.imported).toEqual({
          source: 'zendesk',
          number: sourceNumber,
          url: `https://support.example/agent/tickets/${sourceNumber}`,
        });
        expect(detail.body.messages.messages[0]).toMatchObject({ authorDisplay: 'سارة القديمة' });
        for (const query of [
          `q=${sourceNumber}`,
          `q=archive-${visible.ticket.id}`,
          'imported=true',
        ]) {
          const response = await call<TicketList>(
            'GET',
            `${brandPath(seeded.brandId)}/tickets?${query}`,
            sam,
          );
          expect(response.body.tickets.map((ticket) => ticket.id)).toContain(visible.ticket.id);
          expect(response.body.tickets.map((ticket) => ticket.id)).not.toContain(hidden.ticket.id);
        }
        const onlyNative = await call<TicketList>(
          'GET',
          `${brandPath(seeded.brandId)}/tickets?imported=false`,
          sam,
        );
        expect(onlyNative.body.tickets.map((ticket) => ticket.id)).toContain(native.ticket.id);
        expect(onlyNative.body.tickets.map((ticket) => ticket.id)).not.toContain(visible.ticket.id);
        const edited = await call<Ticket>(
          'PATCH',
          `${brandPath(seeded.brandId)}/tickets/${visible.ticket.id}`,
          sam,
          { subject: 'Updated imported ticket' },
        );
        expect(edited.status).toBe(200);
        expect(edited.body.imported).toEqual(detail.body.ticket.imported);
        expect(
          (await call('GET', `${brandPath(seeded.brandId)}/tickets/${hidden.ticket.id}`, sam))
            .status,
        ).toBe(404);
      } finally {
        await withSystem(runtime.db, seeded.brandId, async (tx) => {
          await tx.delete(importExternalIds).where(inArray(importExternalIds.helpdockId, ids));
          await tx.delete(tickets).where(inArray(tickets.id, ids));
        });
      }
    });
  });

  describe('creating a ticket', () => {
    it('writes the ticket, its first message, its activity row and its outbox row', async () => {
      const detail = await createTicket(sam);

      expect(detail.ticket).toMatchObject({
        subject: 'Refund for order 42',
        priority: 'medium',
        channel: 'manual',
        departmentId: support,
        status: { isDefault: true, systemState: 'open' },
      });
      expect(detail.messages.messages).toHaveLength(1);
      expect(detail.messages.messages[0]).toMatchObject({ seq: 1, kind: 'public' });
      expect(detail.activity.map((entry) => entry.action)).toEqual(['ticket.created']);
      expect(detail.activity[0]).toMatchObject({ actorType: 'staff', actorId: sam.id, via: 'ui' });

      const rows = await unpublished();
      expect(
        rows.some(
          (row) =>
            row.event === 'ticket.created' &&
            (row.payload as { ticketId?: string }).ticketId === detail.ticket.id,
        ),
      ).toBe(true);
    });

    it('numbers tickets from the brand’s own sequence, with the brand’s prefix', async () => {
      const first = await createTicket(sam);
      const second = await createTicket(sam);

      expect(second.ticket.number).toBe(first.ticket.number + 1);
      expect(second.ticket.prefix).toBe('HD');
    });

    it('starts the second brand at its own 1, because a sequence is per brand', async () => {
      const { status, body } = await call<TicketDetail>(
        'POST',
        `${brandPath(otherBrand)}/tickets`,
        ola,
        { subject: 'Hello', bodyHtml: '<p>hi</p>', departmentId: otherDepartment },
      );

      expect(status).toBe(201);
      expect(body.ticket.number).toBe(1);
      expect(body.ticket.prefix).toBe('GLX');
    });

    it('sanitises the first message rather than storing what arrived', async () => {
      const detail = await createTicket(sam, {
        bodyHtml: '<p onclick="steal()">hi</p><script>alert(1)</script>',
      });

      expect(detail.messages.messages[0]?.bodyHtml).toBe('<p>hi</p>');
      expect(detail.messages.messages[0]?.bodyText).toBe('hi');
    });

    it('refuses a department outside the actor’s scope', async () => {
      const { status } = await call('POST', `${brandPath(seeded.brandId)}/tickets`, sam, {
        subject: 'x',
        bodyHtml: '<p>x</p>',
        departmentId: billing,
      });

      expect(status).toBe(403);
    });

    it('refuses a body that is not a body', async () => {
      const { status } = await call('POST', `${brandPath(seeded.brandId)}/tickets`, sam, {
        subject: 'x',
        bodyHtml: '',
        departmentId: support,
      });

      expect(status).toBe(400);
    });
  });

  // --------------------------------------------------------------- updating

  describe('updating a ticket', () => {
    it('moves the fields it names and records what moved', async () => {
      const { ticket } = await createTicket(sam);

      const { status, body } = await call<Ticket>(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
        { priority: 'urgent', subject: 'Refund, urgently' },
      );

      expect(status).toBe(200);
      expect(body).toMatchObject({ priority: 'urgent', subject: 'Refund, urgently' });

      const detail = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
      );
      const updated = detail.body.activity.find((entry) => entry.action === 'ticket.updated');
      expect(updated?.from).toMatchObject({ priority: 'medium' });
      expect(updated?.to).toMatchObject({ priority: 'urgent' });
    });

    it('stamps closed_at through the status hook and logs the transition', async () => {
      const { ticket } = await createTicket(sam);

      const { body } = await call<Ticket>(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
        { statusId: closedStatus },
      );

      expect(body.status.systemState).toBe('closed');
      expect(body.closedAt).not.toBeNull();

      const detail = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
      );
      // DOMAIN-RULES §2.2 row 3: "Activity log records actor".
      expect(
        detail.body.activity.find((entry) => entry.action === 'ticket.status.changed'),
      ).toMatchObject({ actorType: 'staff', actorId: sam.id, via: 'ui' });
    });

    it('answers 404 for a status that is not this brand’s', async () => {
      // Not 403: the transaction cannot see the row, so the api genuinely does
      // not know whether it exists, and saying "forbidden" would tell a brand
      // that another brand's id is real.
      const { ticket } = await createTicket(sam);

      const { status } = await call(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
        { statusId: otherBrandStatus },
      );

      expect(status).toBe(404);
    });

    it('refuses a body that changes nothing rather than answering 200', async () => {
      const { ticket } = await createTicket(sam);

      const { status } = await call(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
        {},
      );

      expect(status).toBe(400);
    });

    it('takes the thread with a ticket that moves department', async () => {
      const { ticket } = await createTicket(ada);

      const { status } = await call(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        ada,
        { departmentId: billing },
      );
      expect(status).toBe(200);

      // The denormalised column is what the policies read, so both children
      // have to move with the ticket. An activity row left behind stays
      // readable by the department the ticket has left.
      const moved = await withSystem(runtime.db, seeded.brandId, async (tx) => ({
        messages: await tx
          .select({ departmentId: ticketMessages.departmentId })
          .from(ticketMessages)
          .where(eq(ticketMessages.ticketId, ticket.id)),
        activity: await tx
          .select({ departmentId: ticketActivity.departmentId })
          .from(ticketActivity)
          .where(eq(ticketActivity.ticketId, ticket.id)),
      }));

      expect(moved.messages.length).toBeGreaterThan(0);
      expect(moved.activity.length).toBeGreaterThan(0);
      expect(moved.messages.every((row) => row.departmentId === billing)).toBe(true);
      expect(moved.activity.every((row) => row.departmentId === billing)).toBe(true);
    });

    it('leaves nothing to log when a field is set to the value it already holds', async () => {
      // 200 with no activity row and no event: an activity log full of
      // "priority: medium → medium" is a log nobody reads, and a phantom
      // `ticket.updated` frame makes every screen re-read for nothing.
      const { ticket } = await createTicket(sam);
      await drainOutbox();

      const { status } = await call(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
        { priority: ticket.priority },
      );

      expect(status).toBe(200);
      expect(await unpublished()).toHaveLength(0);

      const detail = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
      );
      expect(detail.body.activity.map((entry) => entry.action)).toEqual(['ticket.created']);
    });

    it('refuses a team, because the table it would point at arrives with M1-01', async () => {
      const { ticket } = await createTicket(sam);

      const { status } = await call(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
        { teamId: uuidv7() },
      );

      expect(status).toBe(400);
    });

    it('refuses an assignee who holds no role in the brand', async () => {
      // `assignee_id` references the *global* users table, so the foreign key
      // alone would accept a stranger and produce a ticket nobody here owns.
      const { ticket } = await createTicket(sam);

      const { status } = await call(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
        { assigneeId: ola.id },
      );

      expect(status).toBe(400);
    });

    it('accepts an assignee who does hold one', async () => {
      const { ticket } = await createTicket(sam);

      const { status, body } = await call<Ticket>(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
        { assigneeId: sam.id },
      );

      expect(status).toBe(200);
      expect(body.assigneeId).toBe(sam.id);
    });
  });

  // ------------------------------------------------- fields required to close

  describe('fields required to close (M14-17)', () => {
    /**
     * The gated fields of this describe, created once against the brand and
     * taken down after it, because every later close in this file must not
     * meet them.
     */
    let gate: string;
    let legacyId: string;

    const closeAs = (who: Person, ticketId: string, body: Record<string, unknown> = {}) =>
      call<Ticket | ErrorResponse>(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticketId}`,
        who,
        { statusId: closedStatus, ...body },
      );

    beforeAll(async () => {
      const created = await call<{ key: string }>(
        'POST',
        `${brandPath(seeded.brandId)}/custom-fields`,
        ada,
        {
          target: 'ticket',
          key: 'closure_code',
          label: 'Closure code',
          type: 'text',
          requiredToClose: true,
        },
      );
      expect(created.status).toBe(201);
      gate = created.body.key;

      const legacy = await call<{ id: string }>(
        'POST',
        `${brandPath(seeded.brandId)}/custom-fields`,
        ada,
        { target: 'ticket', key: 'legacy_code', label: 'Legacy code', type: 'text' },
      );
      expect(legacy.status).toBe(201);
      legacyId = legacy.body.id;
    });

    afterAll(async () => {
      for (const key of ['legacy_code', 'closure_code']) {
        const id = await findField(key);
        if (id !== undefined) {
          await call('DELETE', `${brandPath(seeded.brandId)}/custom-fields/${id}`, ada);
        }
      }
    });

    const findField = async (key: string): Promise<string | undefined> => {
      const list = await call<{ fields: { id: string; key: string }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/custom-fields?target=ticket`,
        ada,
      );

      return list.body.fields.find((field) => field.key === key)?.id;
    };

    it('refuses a close that would leave the field empty, naming it, and writes nothing', async () => {
      const { ticket } = await createTicket(sam);

      const { status, body } = await closeAs(sam, ticket.id);

      expect(status).toBe(409);
      expect((body as ErrorResponse).error.lifecycle).toEqual({
        reason: 'fields-required-to-close',
        fields: [gate],
      });

      const detail = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
      );
      expect(detail.body.ticket.status.systemState).toBe('open');
      expect(detail.body.ticket.closedAt).toBeNull();
    });

    it('judges the values the request writes, so filling and closing in one body goes through', async () => {
      const { ticket } = await createTicket(sam);

      const { status, body } = await closeAs(sam, ticket.id, {
        custom: { [gate]: 'CR-7' },
      });

      expect(status).toBe(200);
      expect((body as Ticket).status.systemState).toBe('closed');
    });

    it('lets a close through once the field was filled by an earlier patch', async () => {
      const { ticket } = await createTicket(sam);
      await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, sam, {
        custom: { [gate]: 'CR-8' },
      });

      const { status } = await closeAs(sam, ticket.id);

      expect(status).toBe(200);
    });

    it('holds for a ticket that predates the flag: no grandfathering', async () => {
      const { ticket } = await createTicket(sam);

      const switched = await call(
        'PATCH',
        `${brandPath(seeded.brandId)}/custom-fields/${legacyId}`,
        ada,
        { requiredToClose: true },
      );
      expect(switched.status).toBe(200);

      const { status, body } = await closeAs(sam, ticket.id);

      expect(status).toBe(409);
      expect((body as ErrorResponse).error.lifecycle).toMatchObject({
        reason: 'fields-required-to-close',
        fields: expect.arrayContaining(['closure_code', 'legacy_code']),
      });
    });

    it('lets the system close: spam goes through and the row says what it went without', async () => {
      const { ticket } = await createTicket(sam);

      const marked = await call<Ticket>(
        'POST',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}/spam`,
        sam,
        {},
      );
      expect(marked.status).toBe(201);

      const detail = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
      );
      const spam = detail.body.activity.find((entry) => entry.action === 'ticket.marked_spam');
      expect(spam?.to).toMatchObject({ closedWithout: expect.arrayContaining([gate]) });
    });

    it('does not hold back Spam chosen from the status picker, and notes the gap', async () => {
      const statuses = await call<TicketStatusList>(
        'GET',
        `${brandPath(seeded.brandId)}/ticket-statuses`,
        ada,
      );
      const spamId = statuses.body.statuses.find((status) => status.isSpam)?.id ?? '';
      expect(spamId).not.toBe('');
      const { ticket } = await createTicket(sam);

      const { status } = await closeAs(sam, ticket.id, { statusId: spamId });

      expect(status).toBe(200);
      const detail = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
      );
      const closed = detail.body.activity.find((entry) => entry.action === 'ticket.closed');
      expect(closed?.to).toMatchObject({ closedWithout: expect.arrayContaining([gate]) });
    });
  });

  // ----------------------------------------------------------------- thread

  describe('the thread', () => {
    it('assigns the next seq and records the reply', async () => {
      const { ticket } = await createTicket(sam);

      const { status, body } = await call<TicketMessage>(
        'POST',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`,
        sam,
        { kind: 'public', bodyHtml: '<p>On its way.</p>' },
      );

      expect(status).toBe(201);
      expect(body).toMatchObject({ seq: 2, kind: 'public', authorType: 'staff' });
    });

    it('keeps seq monotonic and dense under twenty concurrent inserts', async () => {
      const { ticket } = await createTicket(sam);

      const replies = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          call<TicketMessage>(
            'POST',
            `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`,
            sam,
            { kind: 'note', bodyHtml: `<p>note ${index}</p>` },
          ),
        ),
      );

      expect(replies.map((reply) => reply.status)).toEqual(Array(20).fill(201));
      // Dense from 2 — the first message took 1 — and every value used once.
      expect(replies.map((reply) => reply.body.seq).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 2),
      );
    });

    it('returns the stored message for a retried send rather than a second one', async () => {
      const { ticket } = await createTicket(sam);
      const clientId = uuidv7();
      const send = () =>
        call<TicketMessage>(
          'POST',
          `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`,
          sam,
          { kind: 'public', bodyHtml: '<p>sent twice</p>', clientId },
        );

      // Concurrent, not sequential: the retry has to arrive *while* the first
      // attempt is still committing, which is what the `FOR UPDATE` ordering
      // and the partial unique index exist for (DOMAIN-RULES §7).
      const [first, second] = await Promise.all([send(), send()]);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.seq).toBe(first.body.seq);

      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(ticketMessages)
          .where(
            and(eq(ticketMessages.ticketId, ticket.id), eq(ticketMessages.clientId, clientId)),
          ),
      );
      expect(rows).toHaveLength(1);
    });

    it('pages from a cursor and says when there is no more (DOMAIN-RULES §7)', async () => {
      const { ticket } = await createTicket(sam);
      for (let index = 0; index < 3; index += 1) {
        await call('POST', `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`, sam, {
          kind: 'public',
          bodyHtml: `<p>${index}</p>`,
        });
      }

      const first = await call<TicketMessagePage>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages?after=0&limit=2`,
        sam,
      );
      expect(first.body.messages.map((message) => message.seq)).toEqual([1, 2]);
      expect(first.body.nextAfter).toBe(2);

      const rest = await call<TicketMessagePage>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages?after=2`,
        sam,
      );
      expect(rest.body.messages.map((message) => message.seq)).toEqual([3, 4]);
      expect(rest.body.nextAfter).toBeNull();
    });

    it('logs a note under its own verb, so a reply and a note are told apart', async () => {
      const { ticket } = await createTicket(sam);

      await call('POST', `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`, sam, {
        kind: 'note',
        bodyHtml: '<p>internal</p>',
      });

      const { body } = await call<{ activity: { action: string }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}/activity`,
        sam,
      );
      expect(body.activity.map((entry) => entry.action)).toContain('ticket.note_added');
    });

    it('refuses a reply the ticket’s channel cannot carry before it is written, and a note stays welcome (M10-06)', async () => {
      const { ticket } = await createTicket(sam);
      const messages = `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`;
      // A WhatsApp ticket whose customer last wrote 25 hours ago: the window is closed.
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        const [contact] = await tx
          .insert(contacts)
          .values({ brandId: seeded.brandId, name: 'Daniel Reyes' })
          .returning({ id: contacts.id });
        const [account] = await tx
          .insert(metaAccounts)
          .values({
            brandId: seeded.brandId,
            platform: 'whatsapp',
            departmentId: support,
            externalId: '106540352242922',
            displayName: 'Acme WhatsApp',
            accessToken: 'sealed',
            tokenKind: 'system_user',
            tokenUpdatedAt: new Date(),
          })
          .returning({ id: metaAccounts.id });
        await tx.update(tickets).set({ channel: 'whatsapp' }).where(eq(tickets.id, ticket.id));
        await tx.insert(metaConversations).values({
          brandId: seeded.brandId,
          accountId: account?.id ?? '',
          customerId: '16505550101',
          contactId: contact?.id ?? '',
          ticketId: ticket.id,
          lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        });
      });
      const outboxBefore = (await unpublished()).length;

      const refused = await call<ErrorResponse>('POST', messages, sam, {
        kind: 'public',
        bodyHtml: '<p>Sorry for the wait.</p>',
      });

      expect(refused.status).toBe(409);
      expect(refused.body.error.meta).toMatchObject({
        reason: 'reply-window-closed',
        details: { platform: 'whatsapp' },
      });
      // Nothing was written: no message, no delivery, no outbox row, and the next
      // message takes the number the refused one would have had.
      expect((await unpublished()).length).toBe(outboxBefore);
      const note = await call<TicketMessage>('POST', messages, sam, {
        kind: 'note',
        bodyHtml: '<p>Call them.</p>',
      });
      expect(note.status).toBe(201);
      expect(note.body.seq).toBe(2);

      // The customer writes again: the same reply is written and queued for delivery.
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(metaConversations)
          .set({ lastInboundAt: new Date() })
          .where(eq(metaConversations.ticketId, ticket.id)),
      );
      const sent = await call<TicketMessage>('POST', messages, sam, {
        kind: 'public',
        bodyHtml: '<p>Sorry for the wait.</p>',
      });
      expect(sent.status).toBe(201);
      expect(sent.body.seq).toBe(3);
      expect((await unpublished()).filter((row) => row.event === 'meta.reply')).toHaveLength(1);

      // This suite does not play the Meta worker; its row is not for `drainOutbox` to trip on.
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.event, 'meta.reply')),
      );
    });

    it('moves the ticket to the front of the queue it just became urgent in', async () => {
      const { ticket } = await createTicket(sam);
      const before = ticket.updatedAt;

      await call('POST', `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`, sam, {
        kind: 'public',
        bodyHtml: '<p>bump</p>',
      });

      const { body } = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
      );
      expect(Date.parse(body.ticket.updatedAt)).toBeGreaterThan(Date.parse(before));
    });
  });

  // ------------------------------------------------------------------- list

  describe('the list', () => {
    it('names each row’s contact, and says null for a ticket that names nobody (M1-15)', async () => {
      const contact = await call<{ id: string }>(
        'POST',
        `${brandPath(seeded.brandId)}/contacts`,
        ada,
        { name: 'Idris Vantorre' },
      );
      const named = await createTicket(sam, {
        subject: 'Vantorre parcel',
        contactId: contact.body.id,
      });
      const anonymous = await createTicket(sam, { subject: 'Vantorre walk-in' });

      const { body } = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?q=vantorre&limit=100`,
        sam,
      );
      const byId = new Map(body.tickets.map((row) => [row.id, row]));

      expect(byId.get(named.ticket.id)?.contact).toEqual({
        id: contact.body.id,
        name: 'Idris Vantorre',
      });
      expect(byId.get(anonymous.ticket.id)?.contact).toBeNull();

      // The ticket read names the same person, so the view and its row agree.
      const read = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${named.ticket.id}`,
        sam,
      );
      expect(read.body.ticket.contact).toEqual({ id: contact.body.id, name: 'Idris Vantorre' });
    });

    it('names each row’s assignee for an Agent, who cannot read the staff list (M14-20)', async () => {
      const assigned = await createTicket(sam, { subject: 'Wexford assigned' });
      const unassigned = await createTicket(sam, { subject: 'Wexford loose' });
      // A colleague, not the reader: the name has to come from the brand's people.
      const patched = await call<Ticket>(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${assigned.ticket.id}`,
        ada,
        { assigneeId: ada.id },
      );
      expect(patched.status).toBe(200);
      const colleague = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select({ name: users.name }).from(users).where(eq(users.id, ada.id)),
      );
      const colleagueName = colleague[0]?.name ?? '';
      expect(colleagueName).not.toBe('');

      const staff = await call('GET', `${brandPath(seeded.brandId)}/staff`, sam);
      expect(staff.status).toBe(403);

      const { body } = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?q=wexford&limit=100`,
        sam,
      );
      const byId = new Map(body.tickets.map((row) => [row.id, row]));

      expect(byId.get(assigned.ticket.id)?.assignee).toEqual({ id: ada.id, name: colleagueName });
      expect(byId.get(unassigned.ticket.id)?.assignee).toBeNull();

      // The detail read says the same, and a write response leaves the field off.
      const read = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${assigned.ticket.id}`,
        sam,
      );
      expect(read.body.ticket.assignee).toEqual({ id: ada.id, name: colleagueName });
      expect(patched.body.assignee).toBeUndefined();
    });

    it('finds both tickets whose subject matches the search', async () => {
      const jammed = await createTicket(sam, { subject: 'Kymera printer jammed again' });
      const silent = await createTicket(sam, { subject: 'Kymera printer will not print' });

      const { body } = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?q=kymera&limit=100`,
        sam,
      );

      expect(body.tickets.map((row) => row.id).sort()).toEqual(
        [jammed.ticket.id, silent.ticket.id].sort(),
      );
    });

    it('narrows a search with a filter', async () => {
      const urgent = await createTicket(sam, { subject: 'Lorric outage', priority: 'high' });
      await createTicket(sam, { subject: 'Lorric question' });

      const { body } = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?q=lorric&priority=high&limit=100`,
        sam,
      );

      expect(body.tickets.map((row) => row.id)).toEqual([urgent.ticket.id]);
    });

    it.each(['desc', 'asc'] as const)(
      'pages a %s ordering without repeating or skipping a row',
      async (direction) => {
        // The cursor carries a timestamp as an ISO string, which `Date` holds
        // only to the millisecond. A microsecond column would be compared
        // against a truncated copy of itself: ascending, the boundary row
        // satisfies `>` again and the client pages forever; descending, rows
        // inside the sub-millisecond window vanish. Three rows, one at a time,
        // is what catches both.
        const created = [
          await createTicket(sam, { subject: `Paging ${direction} one` }),
          await createTicket(sam, { subject: `Paging ${direction} two` }),
          await createTicket(sam, { subject: `Paging ${direction} three` }),
        ].map((detail) => detail.ticket.id);

        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 200; page += 1) {
          const url: string = `${brandPath(seeded.brandId)}/tickets?limit=1&direction=${direction}${
            cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
          }`;
          const answer = await call<TicketList>('GET', url, sam);

          const id = answer.body.tickets[0]?.id;
          if (id === undefined) {
            break;
          }
          expect(seen).not.toContain(id);
          seen.push(id);

          cursor = answer.body.nextCursor;
          if (cursor === null) {
            break;
          }
        }

        // Every ticket of this brand, each exactly once, however many other
        // tests have seeded one.
        for (const id of created) {
          expect(seen).toContain(id);
        }
      },
    );

    it('filters by system state without the caller resolving status ids', async () => {
      const { ticket } = await createTicket(sam, { subject: 'Closed by the state filter' });
      await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, sam, {
        statusId: closedStatus,
      });

      const { body } = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?systemState=closed&limit=100`,
        sam,
      );

      expect(body.tickets.map((row) => row.id)).toContain(ticket.id);
      expect(body.tickets.every((row) => row.status.systemState === 'closed')).toBe(true);
    });

    it('finds a half-typed word through the trigram index', async () => {
      await createTicket(sam, { subject: 'Subscription renewal invoice' });

      // Full text cannot match `renewa` against "renewal"; the word-similarity
      // half is what does.
      const { body } = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?q=renewa&limit=100`,
        sam,
      );

      expect(body.tickets.some((ticket) => ticket.subject.includes('Subscription'))).toBe(true);
    });

    it('treats a hostile search term as a search term', async () => {
      const { status } = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?q=${encodeURIComponent("'); drop table tickets; --")}`,
        sam,
      );

      expect(status).toBe(200);
      // And the table is still there.
      expect(
        (await call<TicketList>('GET', `${brandPath(seeded.brandId)}/tickets`, sam)).status,
      ).toBe(200);
    });

    it.each(['search', 'plain'])(
      'M14-07 %s list orders SLA due under department scope and pages tied due times and nulls',
      async (mode) => {
        const label = 'Slaordering';
        const tag = await call<{ id: string }>('POST', `${brandPath(seeded.brandId)}/tags`, ada, {
          name: `${label} ${mode}`,
        });
        expect(tag.status).toBe(201);
        const dueTimes = [
          null,
          '2026-10-20T11:00:00.000Z',
          '2026-10-20T09:00:00.000400Z',
          '2026-10-20T09:00:00.000100Z',
          null,
          '2026-10-21T09:00:00.000Z',
        ];
        const fixtures: { id: string; due: string | null }[] = [];
        for (const [index, due] of dueTimes.entries()) {
          const { ticket } = await createTicket(sam, {
            subject: label,
            tagIds: [tag.body.id],
          });
          await withSystem(runtime.db, seeded.brandId, (tx) =>
            tx
              .update(tickets)
              .set({
                firstResponseDueAt:
                  index === 1
                    ? new Date('2027-01-01T00:00:00.000Z')
                    : due === null
                      ? null
                      : new Date(due),
                resolutionDueAt: index === 1 && due !== null ? new Date(due) : null,
              })
              .where(eq(tickets.id, ticket.id)),
          );
          if (index === 2 || index === 3) {
            // Preserve sub-millisecond source precision: JS Date would hide the cursor regression.
            await withSystem(runtime.db, seeded.brandId, (tx) =>
              tx.execute(
                sql`UPDATE tickets SET first_response_due_at = ${due}::timestamptz WHERE id = ${ticket.id}`,
              ),
            );
          }
          fixtures.push({ id: ticket.id, due: due === null ? null : new Date(due).toISOString() });
        }
        const hidden = await createTicket(bo, {
          subject: label,
          departmentId: billing,
          tagIds: [tag.body.id],
        });
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .update(tickets)
            .set({
              resolutionDueAt: new Date('2020-01-01T00:00:00.000Z'),
            })
            .where(eq(tickets.id, hidden.ticket.id)),
        );
        const expected = [...fixtures]
          .sort(
            (a, b) =>
              (a.due === null
                ? b.due === null
                  ? 0
                  : 1
                : b.due === null
                  ? -1
                  : a.due.localeCompare(b.due)) || a.id.localeCompare(b.id),
          )
          .map((row) => row.id);
        for (const direction of ['asc', 'desc']) {
          const seen: string[] = [];
          let cursor: string | null = null;
          for (let page = 0; page < 10; page++) {
            const answer: { status: number; body: TicketList } = await call<TicketList>(
              'GET',
              `${brandPath(seeded.brandId)}/tickets?tagId=${tag.body.id}${mode === 'search' ? `&q=${label}` : ''}&sort=slaDue&direction=${direction}&limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
              sam,
            );
            expect(answer.status).toBe(200);
            seen.push(...answer.body.tickets.map((row) => row.id));
            cursor = answer.body.nextCursor;
            if (cursor === null) break;
          }
          expect(seen).toEqual(expected);
          expect(seen).not.toContain(hidden.ticket.id);
        }
      },
    );

    it('answers 400 for a cursor from another ordering', async () => {
      const page = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?limit=1`,
        sam,
      );

      const { status } = await call(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?sort=number&limit=1&cursor=${encodeURIComponent(page.body.nextCursor ?? '')}`,
        sam,
      );

      expect(status).toBe(400);
    });

    it('answers an empty page for a tag nothing carries, now that M1-06 applies it', async () => {
      // Until M1-06 this parameter was refused rather than ignored. It is
      // applied now, so an id no ticket carries narrows to nothing — which is
      // the answer, not an error.
      const { status, body } = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?tagId=${uuidv7()}`,
        sam,
      );

      expect(status).toBe(200);
      expect(body.tickets).toEqual([]);
    });

    it('shows a brand its own tickets and none of another brand’s', async () => {
      const mine = await call<TicketDetail>('POST', `${brandPath(otherBrand)}/tickets`, ola, {
        subject: 'Globex only',
        bodyHtml: '<p>x</p>',
        departmentId: otherDepartment,
      });

      const { body } = await call<TicketList>(
        'GET',
        `${brandPath(otherBrand)}/tickets?limit=100`,
        ola,
      );

      expect(body.tickets.map((row) => row.id)).toContain(mine.body.ticket.id);
      expect(body.tickets.every((row) => row.prefix === 'GLX')).toBe(true);
    });
  });

  // ------------------------------------------------------------------ search

  describe('search through the token table (M1-15 part 2, ADR 0011)', () => {
    const search = async (who: Person, q: string, extra = '') =>
      (
        await call<TicketList>(
          'GET',
          `${brandPath(seeded.brandId)}/tickets?q=${encodeURIComponent(q)}&limit=100${extra}`,
          who,
        )
      ).body;

    const idsFor = async (who: Person, q: string) =>
      (await search(who, q)).tickets.map((row) => row.id).sort();

    const wordsOf = (ticketId: string) =>
      withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({
            token: ticketSearchTokens.token,
            departmentId: ticketSearchTokens.departmentId,
          })
          .from(ticketSearchTokens)
          .where(eq(ticketSearchTokens.ticketId, ticketId)),
      );

    it('stores the words of the subject and the first message, in the same transaction', async () => {
      const { ticket } = await createTicket(sam, {
        subject: 'Quillon hinge squeaks',
        bodyHtml: '<p>The <b>zarkov</b> latch is loose</p>',
      });

      const words = await wordsOf(ticket.id);
      // Lexemes of the `english` configuration: stemmed, lower-cased, no stop words.
      expect(words.map((row) => row.token).sort()).toEqual(
        ['hing', 'latch', 'loos', 'quillon', 'squeak', 'zarkov'].sort(),
      );
      expect(new Set(words.map((row) => row.departmentId))).toEqual(new Set([support]));
      expect(await idsFor(sam, 'zarkov')).toEqual([ticket.id]);
    });

    it('is not searched by a later message', async () => {
      const { ticket } = await createTicket(sam, { subject: 'Ferrule cracked' });
      await call('POST', `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`, sam, {
        kind: 'public',
        bodyHtml: '<p>plumbago</p>',
      });

      expect(await idsFor(sam, 'plumbago')).toEqual([]);
      expect(await idsFor(sam, 'ferrule')).toEqual([ticket.id]);
    });

    it('follows a subject edit', async () => {
      const { ticket } = await createTicket(sam, { subject: 'Tamarisk delivery' });

      await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, sam, {
        subject: 'Oleander delivery',
      });

      expect(await idsFor(sam, 'oleander')).toEqual([ticket.id]);
      expect(await idsFor(sam, 'tamarisk')).toEqual([]);
    });

    it('asks for every word, not any of them', async () => {
      const stapler = await createTicket(sam, { subject: 'Vellum stapler jammed' });
      const binder = await createTicket(sam, { subject: 'Vellum binder torn' });

      expect(await idsFor(sam, 'vellum stapler')).toEqual([stapler.ticket.id]);
      expect(await idsFor(sam, 'vellum')).toEqual([stapler.ticket.id, binder.ticket.id].sort());
      expect(await idsFor(sam, 'vellum -binder')).toEqual([stapler.ticket.id]);
    });

    it('answers an empty page for a word nobody used, fallback included', async () => {
      const page = await search(ada, 'xylquorzz');

      expect(page.tickets).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it('finds Arabic words, whole and half-typed', async () => {
      const { ticket } = await createTicket(sam, {
        subject: 'طلب استرداد المبلغ',
        bodyHtml: '<p>لم يصل الطرد</p>',
      });

      expect(await idsFor(sam, 'استرداد')).toEqual([ticket.id]);
      expect(await idsFor(sam, 'الطرد')).toEqual([ticket.id]);
      // Half-typed: the exact half finds nothing, the fuzzy fallback does.
      expect(await idsFor(sam, 'استردا')).toEqual([ticket.id]);
    });

    it('pages a fuzzy search by the fuzzy half from start to end', async () => {
      const created = [
        await createTicket(sam, { subject: 'Glimmerton spring one' }),
        await createTicket(sam, { subject: 'Glimmerton spring two' }),
        await createTicket(sam, { subject: 'Glimmerton spring three' }),
      ].map((detail) => detail.ticket.id);

      // `glimmerto` matches nothing exactly, so page one falls back and its
      // cursor says so; without the flag, page two would ask the exact half
      // again and come back empty.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const page: TicketList = (
          await call<TicketList>(
            'GET',
            `${brandPath(seeded.brandId)}/tickets?q=glimmerto&limit=1${suffix}`,
            sam,
          )
        ).body;
        seen.push(...page.tickets.map((row) => row.id));
        cursor = page.nextCursor;
      } while (cursor !== null && seen.length < 10);

      expect(seen.sort()).toEqual([...created].sort());
    });

    it('moves the words with a ticket that changes department', async () => {
      const { ticket } = await createTicket(ada, { subject: 'Wolfram invoice' });

      await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
        departmentId: billing,
      });

      expect(new Set((await wordsOf(ticket.id)).map((row) => row.departmentId))).toEqual(
        new Set([billing]),
      );
      expect(await idsFor(sam, 'wolfram')).toEqual([]);
      expect(await idsFor(bo, 'wolfram')).toEqual([ticket.id]);
    });

    it('hides another department’s words from raw SQL, and refuses to write them', async () => {
      const { ticket } = await createTicket(bo, {
        subject: 'Cobalt refund',
        departmentId: billing,
      });
      const asSam = <T>(work: (tx: DbTransaction) => Promise<T>) =>
        withTenant(
          runtime.db,
          {
            brandIds: [seeded.brandId],
            departmentIds: [support],
            principalType: 'staff',
            principalId: sam.id,
          },
          work,
        );

      const visible = await asSam((tx) =>
        tx
          .select({ token: ticketSearchTokens.token })
          .from(ticketSearchTokens)
          .where(eq(ticketSearchTokens.ticketId, ticket.id)),
      );
      expect(visible).toEqual([]);

      const rejection = await asSam((tx) =>
        tx.insert(ticketSearchTokens).values({
          brandId: seeded.brandId,
          ticketId: ticket.id,
          departmentId: support,
          token: 'planted',
        }),
      ).then(
        () => undefined,
        (error: unknown) => error as { cause?: { message?: string } },
      );
      expect(rejection?.cause?.message).toMatch(/not visible in this transaction/i);
    });

    it.each<SearchMode>(['exact', 'fuzzy'])(
      'looks the %s words up in the token index ahead of the policy, as the runtime role',
      async (mode) => {
        // With sequential and bitmap scans off the planner must use an index,
        // and it may only put a condition into the index ahead of the policy
        // when the operator is leakproof (ADR 0011). A non-leakproof operator
        // would show as a Filter above the policy instead.
        const plan = await withTenant(
          runtime.db,
          {
            brandIds: [seeded.brandId],
            departmentIds: [support],
            principalType: 'staff',
            principalId: sam.id,
          },
          async (tx) => {
            await tx.execute(sql`SET LOCAL enable_seqscan = off`);
            await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
            const statement = new TicketRepository().listTicketsStatement(
              tx,
              { brandId: seeded.brandId, viewerId: sam.id },
              ticketListQuerySchema.parse({ q: 'renewa' }),
              mode,
            );
            const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`EXPLAIN ${statement}`);
            return [...rows].map((row) => row['QUERY PLAN']).join('\n');
          },
        );

        const tokenLookup =
          mode === 'exact' ? /Index Cond: .*token = ANY/ : /Index Cond: .*token >= "left"/;
        expect(plan).toMatch(/ticket_search_tokens_brand_token_idx/);
        expect(plan).toMatch(tokenLookup);
      },
    );

    it('keeps the reference and contact-name matches (M1-09)', async () => {
      const { ticket } = await createTicket(sam, { subject: 'Numbered only' });

      expect(await idsFor(sam, `#${ticket.number}`)).toContain(ticket.id);
      expect(await idsFor(sam, `${ticket.prefix}-${ticket.number}`)).toContain(ticket.id);
    });
  });

  describe('a term that names a ticket, past the view’s filters (#221)', () => {
    /** The default views' live states: what hides a closed ticket. */
    const OPEN_VIEW = '&systemState=open&systemState=on_hold&systemState=escalated';
    const SOURCE_NUMBER = '880580';
    const NATIVE_ID = 'zd-880580';
    const HIDDEN_SOURCE_NUMBER = '880581';

    let closed: Ticket;
    let importedClosed: Ticket;
    let hiddenClosed: Ticket;
    let deleted: Ticket;
    /** An open ticket whose subject carries the closed ticket's number as a word. */
    let mentionsNumber: Ticket;

    const search = async (who: Person, q: string, extra = '') =>
      (
        await call<TicketList>(
          'GET',
          `${brandPath(seeded.brandId)}/tickets?q=${encodeURIComponent(q)}&limit=100${extra}`,
          who,
        )
      ).body.tickets.map((row) => row.id);

    const close = async (who: Person, ticketId: string) => {
      const response = await call<Ticket>(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticketId}`,
        who,
        { statusId: closedStatus },
      );
      expect(response.status).toBe(200);
      return response.body;
    };

    const importAs = (ticketId: string, sourceNumber: string, externalId: string) =>
      withSystem(runtime.db, seeded.brandId, async (tx) => {
        await tx
          .update(tickets)
          .set({ importedAt: new Date('2015-01-01T00:00:00Z'), importSource: 'zendesk' })
          .where(eq(tickets.id, ticketId));
        await tx.insert(importExternalIds).values({
          brandId: seeded.brandId,
          source: 'zendesk',
          sourceAccountKey: 'b'.repeat(64),
          entity: 'ticket',
          externalId,
          helpdockId: ticketId,
          sourceNumber,
          payloadHash: 'e'.repeat(64),
        });
      });

    /** Every page of one search, one row at a time, so each cursor is crossed. */
    const pagesOf = async (q: string, extra: string): Promise<string[]> => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const page: TicketList = (
          await call<TicketList>(
            'GET',
            `${brandPath(seeded.brandId)}/tickets?q=${encodeURIComponent(q)}&limit=1${extra}${suffix}`,
            sam,
          )
        ).body;
        seen.push(...page.tickets.map((row) => row.id));
        cursor = page.nextCursor;
      } while (cursor !== null && seen.length < 10);

      return seen;
    };

    beforeAll(async () => {
      closed = await close(
        sam,
        (await createTicket(sam, { subject: 'Vexorian gasket recall' })).ticket.id,
      );
      mentionsNumber = (await createTicket(sam, { subject: `Follow-up on ${closed.number}` }))
        .ticket;

      const imported = (await createTicket(sam, { subject: 'Archived courier dispute' })).ticket;
      await importAs(imported.id, SOURCE_NUMBER, NATIVE_ID);
      importedClosed = await close(sam, imported.id);

      const hidden = (await createTicket(bo, { departmentId: billing })).ticket;
      await importAs(hidden.id, HIDDEN_SOURCE_NUMBER, `zd-${HIDDEN_SOURCE_NUMBER}`);
      hiddenClosed = await close(bo, hidden.id);

      deleted = (await createTicket(ada)).ticket;
      expect(
        (await call('DELETE', `${brandPath(seeded.brandId)}/tickets/${deleted.id}`, ada)).status,
      ).toBe(204);
    });

    it('finds a closed ticket by its reference or number from an open-only view, first', async () => {
      for (const q of [
        `${closed.prefix}-${closed.number}`,
        `#${closed.number}`,
        `${closed.number}`,
      ]) {
        expect((await search(sam, q, OPEN_VIEW))[0], q).toBe(closed.id);
      }
    });

    it('finds a closed imported ticket by its original number or native id from an open-only view', async () => {
      for (const q of [SOURCE_NUMBER, `#${SOURCE_NUMBER}`, NATIVE_ID]) {
        expect((await search(sam, q, OPEN_VIEW))[0], q).toBe(importedClosed.id);
      }
    });

    it('ignores the view’s other filters for the named ticket too', async () => {
      const ids = await search(
        sam,
        `#${closed.number}`,
        `${OPEN_VIEW}&priority=urgent&assigneeId=unassigned&imported=true`,
      );

      expect(ids).toEqual([closed.id]);
    });

    it('keeps a free-text match inside the view', async () => {
      expect(await search(sam, 'vexorian')).toEqual([closed.id]);
      expect(await search(sam, 'vexorian', OPEN_VIEW)).toEqual([]);
    });

    it('never names a ticket of a department the reader cannot see', async () => {
      for (const q of [
        HIDDEN_SOURCE_NUMBER,
        `zd-${HIDDEN_SOURCE_NUMBER}`,
        `#${hiddenClosed.number}`,
      ]) {
        expect(await search(sam, q, OPEN_VIEW), q).not.toContain(hiddenClosed.id);
        expect(await search(sam, q), q).not.toContain(hiddenClosed.id);
      }
      expect(await search(bo, HIDDEN_SOURCE_NUMBER, OPEN_VIEW)).toEqual([hiddenClosed.id]);
    });

    it('never names a deleted ticket', async () => {
      expect(await search(ada, `#${deleted.number}`)).not.toContain(deleted.id);
    });

    it('pages from the named ticket into the view’s matches, each once', async () => {
      // The named ticket outside the view, then the open ticket that only
      // carries its number as a word.
      expect(await pagesOf(`${closed.number}`, OPEN_VIEW)).toEqual([closed.id, mentionsNumber.id]);
      // Inside the view too, the named ticket is not read a second time by
      // the view's own half.
      expect(await pagesOf(`${closed.number}`, '')).toEqual([closed.id, mentionsNumber.id]);
    });
  });

  // ------------------------------------------------------- department scope

  describe('department scope (DOMAIN-RULES §1.3, §1.6)', () => {
    let billingTicket: string;

    beforeAll(async () => {
      const detail = await call<TicketDetail>('POST', `${brandPath(seeded.brandId)}/tickets`, bo, {
        subject: 'Invoice mismatch',
        bodyHtml: '<p>see attached</p>',
        departmentId: billing,
      });
      billingTicket = detail.body.ticket.id;

      await call('POST', `${brandPath(seeded.brandId)}/tickets/${billingTicket}/messages`, bo, {
        kind: 'note',
        bodyHtml: '<p>chasing finance</p>',
      });
    });

    it('hides another department’s ticket from the list', async () => {
      const { body } = await call<TicketList>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets?limit=100`,
        sam,
      );

      expect(body.tickets.map((ticket) => ticket.id)).not.toContain(billingTicket);
    });

    it('answers 404 to a direct read of it, not 403', async () => {
      // 403 would confirm the ticket exists. The policy cannot see it, so the
      // api genuinely does not know.
      const { status } = await call(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${billingTicket}`,
        sam,
      );

      expect(status).toBe(404);
    });

    it('answers 404 to its message cursor', async () => {
      const { status } = await call(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${billingTicket}/messages?after=0`,
        sam,
      );

      expect(status).toBe(404);
    });

    it('answers 404 to its activity', async () => {
      const { status } = await call(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${billingTicket}/activity`,
        sam,
      );

      expect(status).toBe(404);
    });

    it('answers 404 to its routing trail (M14-08)', async () => {
      const { status } = await call(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${billingTicket}/routing`,
        sam,
      );

      expect(status).toBe(404);
    });

    it('refuses a reply to it', async () => {
      const { status } = await call(
        'POST',
        `${brandPath(seeded.brandId)}/tickets/${billingTicket}/messages`,
        sam,
        { kind: 'public', bodyHtml: '<p>hello</p>' },
      );

      expect(status).toBe(404);
    });

    it('refuses a patch of it', async () => {
      const { status } = await call(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${billingTicket}`,
        sam,
        { priority: 'low' },
      );

      expect(status).toBe(404);
    });

    it('hides it in hand-written SQL too', async () => {
      // The endpoints are one way in. The policy is the one that holds when a
      // query is written by hand (DOMAIN-RULES §1.3).
      const visible = await withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: [support],
          principalType: 'staff',
          principalId: sam.id,
        },
        (tx) => tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, billingTicket)),
      );

      expect(visible).toEqual([]);
    });

    it('refuses a ticket written straight into another department, in raw SQL', async () => {
      // Every write negative above is refused by the service before the policy
      // is consulted. This is the `WITH CHECK` half itself: if it were dropped
      // from the migration tomorrow, nothing else here would fail
      // (DOMAIN-RULES §1.6).
      const rejection = await withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: [support],
          principalType: 'staff',
          principalId: sam.id,
        },
        (tx) =>
          tx.insert(tickets).values({
            brandId: seeded.brandId,
            departmentId: billing,
            number: 900_001,
            prefix: 'HD',
            subject: 'Smuggled into billing',
            statusId: openStatus,
            channel: 'manual',
          }),
      ).then(
        () => undefined,
        (error: unknown) => error as { cause?: { message?: string } },
      );

      expect(rejection?.cause?.message).toMatch(/row-level security/i);
    });

    it('refuses to move its own ticket into a department it cannot see, in raw SQL', async () => {
      const { ticket } = await createTicket(sam);

      const rejection = await withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: [support],
          principalType: 'staff',
          principalId: sam.id,
        },
        (tx) => tx.update(tickets).set({ departmentId: billing }).where(eq(tickets.id, ticket.id)),
      ).then(
        () => undefined,
        (error: unknown) => error as { cause?: { message?: string } },
      );

      // `USING` lets the row be found; `WITH CHECK` is what stops it walking out.
      expect(rejection?.cause?.message).toMatch(/row-level security/i);
    });

    it('hides its messages through the denormalised department', async () => {
      const visible = await withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: [support],
          principalType: 'staff',
          principalId: sam.id,
        },
        (tx) =>
          tx
            .select({ id: ticketMessages.id })
            .from(ticketMessages)
            .where(eq(ticketMessages.ticketId, billingTicket)),
      );

      expect(visible).toEqual([]);
    });

    it('shows it to the agent it belongs to, and to the brand’s admin', async () => {
      expect(
        (await call('GET', `${brandPath(seeded.brandId)}/tickets/${billingTicket}`, bo)).status,
      ).toBe(200);
      expect(
        (await call('GET', `${brandPath(seeded.brandId)}/tickets/${billingTicket}`, ada)).status,
      ).toBe(200);
    });
  });

  // ---------------------------------------------------------- routing trail

  describe('the routing trail (M14-08)', () => {
    it('records how a person filed a ticket, and reads the automatic steps after it in words', async () => {
      const detail = await createTicket(sam);
      const ticketId = detail.ticket.id;
      expect(detail.activity[0]?.to?.arrival).toEqual({
        entry: 'staff',
        entryId: sam.id,
        departmentId: support,
        reason: 'chosen_by_staff',
      });

      const ruleId = uuidv7();
      const goneRuleId = uuidv7();
      const at = (seconds: number) =>
        new Date(Date.parse(detail.ticket.createdAt) + seconds * 1000);
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await tx.insert(workflowRules).values({
          id: ruleId,
          brandId: seeded.brandId,
          name: 'Urgent words',
          kind: 'event',
          trigger: 'ticket.created',
          conditions: {},
          actions: [],
          position: 900,
          enabled: false,
        });
        const base = { brandId: seeded.brandId, ticketId, departmentId: support };
        await tx.insert(ticketActivity).values([
          {
            ...base,
            actorType: 'system',
            actorId: `rule:${ruleId}`,
            via: 'rule',
            action: 'ticket.updated',
            from: { priority: 'medium' },
            to: { priority: 'urgent' },
            createdAt: at(1),
          },
          {
            ...base,
            actorType: 'system',
            actorId: `rule:${goneRuleId}`,
            via: 'rule',
            action: 'ticket.updated',
            from: { priority: 'urgent' },
            to: { priority: 'high' },
            createdAt: at(2),
          },
          {
            ...base,
            actorType: 'system',
            actorId: 'assignment',
            via: 'system',
            action: 'ticket.updated',
            from: { assigneeId: null },
            to: { assigneeId: sam.id, assignedBy: 'round_robin' },
            createdAt: at(3),
          },
          {
            ...base,
            actorType: 'staff',
            actorId: sam.id,
            via: 'ui',
            action: 'ticket.updated',
            from: { priority: 'high' },
            to: { priority: 'low' },
            createdAt: at(4),
          },
        ]);
      });

      const { status, body } = await call<TicketRouting>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticketId}/routing`,
        sam,
      );

      expect(status).toBe(200);
      expect(body.origin).toEqual({
        kind: 'recorded',
        channel: 'manual',
        entry: 'staff',
        address: null,
        reason: 'chosen_by_staff',
        department: { id: support, name: 'Support', nameAr: null },
      });
      expect(body.steps.map(({ change, by }) => ({ change, by }))).toEqual([
        {
          change: { kind: 'priority', from: 'medium', to: 'urgent' },
          by: { kind: 'rule', ruleId, name: 'Urgent words' },
        },
        {
          change: { kind: 'priority', from: 'urgent', to: 'high' },
          by: { kind: 'rule', ruleId: goneRuleId, name: null },
        },
        {
          change: { kind: 'assigned', assignee: { id: sam.id, name: expect.any(String) } },
          by: { kind: 'assignment', mode: 'round_robin' },
        },
      ]);
    });

    it('says only "arrived on" for a ticket whose creation recorded no arrival', async () => {
      const { ticket } = await createTicket(sam);
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(ticketActivity)
          .set({ to: { subject: ticket.subject } })
          .where(
            and(
              eq(ticketActivity.ticketId, ticket.id),
              eq(ticketActivity.action, 'ticket.created'),
            ),
          ),
      );

      const { body } = await call<TicketRouting>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}/routing`,
        sam,
      );

      expect(body).toEqual({ origin: { kind: 'unrecorded', channel: 'manual' }, steps: [] });
    });
  });

  // ----------------------------------------------------------------- outbox

  describe('the outbox (DOMAIN-RULES §6)', () => {
    it('commits the event with the change', async () => {
      await drainOutbox();

      const { ticket } = await createTicket(sam);

      expect(
        (await unpublished()).some(
          (row) =>
            row.event === 'ticket.created' &&
            (row.payload as { ticketId?: string }).ticketId === ticket.id,
        ),
      ).toBe(true);
    });

    it('rolls the event back with the transaction that wrote it', async () => {
      await drainOutbox();

      // The domain change and the outbox row are one write. Rolling back after
      // both have been written is the case the rule exists for: "roll back a
      // transaction and assert no job appears" (§6).
      const failed = await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await tx.insert(outbox).values({
          brandId: seeded.brandId,
          event: 'ticket.updated',
          payload: { ticketId: uuidv7(), departmentId: support },
        });
        throw new Error('the handler threw after writing');
      }).catch((error: unknown) => error);

      expect(failed).toBeInstanceOf(Error);
      expect(await unpublished()).toHaveLength(0);
    });

    it('leaves nothing behind when a request fails part-way', async () => {
      await drainOutbox();
      const { ticket } = await createTicket(sam);
      await drainOutbox();

      // The status belongs to another brand, so the handler throws after it has
      // decided what else to move. One transaction means neither the change nor
      // its event survives.
      const { status } = await call(
        'PATCH',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
        { priority: 'urgent', statusId: otherBrandStatus },
      );
      expect(status).toBe(404);

      expect(await unpublished()).toHaveLength(0);
      const detail = await call<TicketDetail>(
        'GET',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
        sam,
      );
      expect(detail.body.ticket.priority).toBe('medium');
    });
  });

  // ------------------------------------------------- the contact providers

  describe('what the contact screens read (M1-04’s seam)', () => {
    let contactId: string;
    let supportSide: TicketDetail;

    beforeAll(async () => {
      const created = await call<{ id: string }>(
        'POST',
        `${brandPath(seeded.brandId)}/contacts`,
        ada,
        { name: 'Nadia Karim' },
      );
      contactId = created.body.id;

      // One in each department, so the same contact is partly visible to each
      // agent and wholly visible to the admin.
      supportSide = await createTicket(sam, { subject: 'Support side', contactId });
      await call<TicketDetail>('POST', `${brandPath(seeded.brandId)}/tickets`, bo, {
        subject: 'Billing side',
        bodyHtml: '<p>x</p>',
        departmentId: billing,
        contactId,
      });
    });

    it('counts only the tickets the reader may see, and says how many it hid', async () => {
      // DOMAIN-RULES §1.2: "the timeline shows a count of hidden tickets so the
      // agent knows history exists".
      const { status, body } = await call<{
        items: { subject: string; statusId: string }[];
        visibleCount: number;
        hiddenCount: number;
      }>('GET', `${brandPath(seeded.brandId)}/contacts/${contactId}/timeline`, sam);

      expect(status).toBe(200);
      expect(body.items.map((item) => item.subject)).toEqual(['Support side']);
      // The status by id as well as by name: the ticket screen draws its badge from it.
      expect(body.items[0]?.statusId).toBe(supportSide.ticket.status.id);
      expect(body.visibleCount).toBe(1);
      expect(body.hiddenCount).toBe(1);
    });

    it('hides nothing from somebody who may see everything', async () => {
      const { body } = await call<{ items: unknown[]; visibleCount: number; hiddenCount: number }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts/${contactId}/timeline`,
        ada,
      );

      expect(body.items).toHaveLength(2);
      expect(body.visibleCount).toBe(2);
      expect(body.hiddenCount).toBe(0);
    });

    it('counts nothing for a brand the transaction does not name', async () => {
      // The function turns `app.all_departments` on and leaves `app.brand_ids`
      // alone, so it looks past the department predicate and not past the brand
      // one: another brand's rows are invisible to it exactly as they are to
      // every other read, and it says zero rather than raising.
      const [own, other] = await withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: [support],
          principalType: 'staff',
          principalId: sam.id,
        },
        async (tx) => [
          await tx.execute<{ total: number }>(
            sql`SELECT helpdock_contact_ticket_count(${seeded.brandId}::uuid, ${contactId}::uuid)::int AS total`,
          ),
          await tx.execute<{ total: number }>(
            sql`SELECT helpdock_contact_ticket_count(${otherBrand}::uuid, ${contactId}::uuid)::int AS total`,
          ),
        ],
      );

      // Both of the contact's tickets, although this scope can see only one.
      expect([...(own ?? [])][0]?.total).toBe(2);
      expect([...(other ?? [])][0]?.total).toBe(0);
    });

    it('restores the department scope the call borrowed', async () => {
      // A function-level SET lasts for the call and no longer. If it leaked,
      // every read after a timeline would quietly see every department.
      const visible = await withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: [support],
          principalType: 'staff',
          principalId: sam.id,
        },
        async (tx) => {
          await tx.execute(
            sql`SELECT helpdock_contact_ticket_count(${seeded.brandId}::uuid, ${contactId}::uuid)`,
          );
          return tx
            .select({ id: tickets.id })
            .from(tickets)
            .where(eq(tickets.contactId, contactId));
        },
      );

      expect(visible).toHaveLength(1);
    });

    it('gives the contact list the counts it draws, scoped to the reader', async () => {
      const mine = await call<{ contacts: { id: string; stats: ContactStats }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts`,
        sam,
      );
      const everything = await call<{ contacts: { id: string; stats: ContactStats }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts`,
        ada,
      );

      const seenBySam = mine.body.contacts.find((row) => row.id === contactId)?.stats;
      const seenByAda = everything.body.contacts.find((row) => row.id === contactId)?.stats;

      expect(seenBySam?.totalTickets).toBe(1);
      expect(seenByAda?.totalTickets).toBe(2);
      expect(seenByAda?.openTickets).toBe(2);
      // M1-12 and M3-02 measure these; a zero would read as "rated badly" and
      // "answered instantly" rather than "not measured yet".
      expect(seenByAda?.csat).toBeNull();
      expect(seenByAda?.averageFirstReplySeconds).toBeNull();
      expect(Date.parse(seenByAda?.lastTicketAt ?? '')).not.toBeNaN();
    });

    it('narrows the "has open tickets" filter for real, and per reader', async () => {
      // The filter answered nothing while there were no tickets to ask about;
      // now it answers "has an open ticket *you can see*", which is the only
      // honest question for this principal.
      const withOpen = await call<{ contacts: { id: string }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts?hasOpenTickets=true`,
        sam,
      );
      const nobodyElse = await call<{ contacts: { id: string }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts?hasOpenTickets=true`,
        bo,
      );

      expect(withOpen.body.contacts.map((row) => row.id)).toContain(contactId);
      expect(nobodyElse.body.contacts.map((row) => row.id)).toContain(contactId);

      // A contact with no ticket at all is excluded by it.
      const lonely = await call<{ id: string }>(
        'POST',
        `${brandPath(seeded.brandId)}/contacts`,
        ada,
        { name: 'Nobody Withaticket' },
      );
      const again = await call<{ contacts: { id: string }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts?hasOpenTickets=true`,
        ada,
      );

      expect(again.body.contacts.map((row) => row.id)).not.toContain(lonely.body.id);
    });

    it('counts every visible ticket when the list stops at its page of 50', async () => {
      // #237: the ticket screen's "Previous tickets · N" reads this count, so
      // it must not stop where `items` does.
      const regular = await call<{ id: string }>(
        'POST',
        `${brandPath(seeded.brandId)}/contacts`,
        ada,
        { name: 'Many Tickets' },
      );
      for (let index = 0; index < 51; index += 1) {
        await createTicket(sam, { subject: `Visit ${index}`, contactId: regular.body.id });
      }

      const { body } = await call<{ items: unknown[]; visibleCount: number; hiddenCount: number }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts/${regular.body.id}/timeline`,
        sam,
      );

      expect(body.items).toHaveLength(50);
      expect(body.visibleCount).toBe(51);
      expect(body.hiddenCount).toBe(0);
    }, 60_000);

    it('leaves a deleted ticket out of the timeline and of every count', async () => {
      // DOMAIN-RULES §2.2: a soft-deleted ticket is "hidden from all views".
      const { body: contact } = await call<{ id: string }>(
        'POST',
        `${brandPath(seeded.brandId)}/contacts`,
        ada,
        { name: 'Deleted History' },
      );
      const kept = await createTicket(sam, { subject: 'Kept', contactId: contact.id });
      const deletedHere = await createTicket(sam, { subject: 'Deleted', contactId: contact.id });
      const deletedElsewhere = await createTicket(bo, {
        subject: 'Deleted in billing',
        departmentId: billing,
        contactId: contact.id,
      });
      for (const { ticket } of [deletedHere, deletedElsewhere]) {
        expect(
          (await call('DELETE', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada)).status,
        ).toBe(204);
      }

      const timeline = await call<{
        items: { id: string }[];
        visibleCount: number;
        hiddenCount: number;
      }>('GET', `${brandPath(seeded.brandId)}/contacts/${contact.id}/timeline`, sam);
      const listed = await call<{ contacts: { id: string; stats: ContactStats }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts?hasOpenTickets=true`,
        ada,
      );

      expect(timeline.body.items.map((item) => item.id)).toEqual([kept.ticket.id]);
      expect(timeline.body.visibleCount).toBe(1);
      expect(timeline.body.hiddenCount).toBe(0);
      const stats = listed.body.contacts.find((row) => row.id === contact.id)?.stats;
      expect(stats?.totalTickets).toBe(1);
      expect(stats?.openTickets).toBe(1);
    });

    it('does not call a contact whose only open ticket was deleted one with open tickets', async () => {
      const { body: contact } = await call<{ id: string }>(
        'POST',
        `${brandPath(seeded.brandId)}/contacts`,
        ada,
        { name: 'Only Deleted' },
      );
      const { ticket } = await createTicket(sam, { contactId: contact.id });
      await call('DELETE', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada);

      const { body } = await call<{ contacts: { id: string }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts?hasOpenTickets=true`,
        ada,
      );

      expect(body.contacts.map((row) => row.id)).not.toContain(contact.id);
    });

    it('leaves a spam ticket out of the timeline and of every count, and keeps a merged one', async () => {
      // Owner decision for 1.0.2: spam is not the contact's history; a merged
      // ticket still is, listed with its Merged status.
      const { body: contact } = await call<{ id: string }>(
        'POST',
        `${brandPath(seeded.brandId)}/contacts`,
        ada,
        { name: 'Spam History' },
      );
      const kept = await createTicket(sam, { subject: 'Kept', contactId: contact.id });
      const spamHere = await createTicket(sam, { subject: 'Spam', contactId: contact.id });
      const spamElsewhere = await createTicket(bo, {
        subject: 'Spam in billing',
        departmentId: billing,
        contactId: contact.id,
      });
      const merged = await createTicket(sam, { subject: 'Merged', contactId: contact.id });
      for (const { ticket } of [spamHere, spamElsewhere]) {
        const marked = await call(
          'POST',
          `${brandPath(seeded.brandId)}/tickets/${ticket.id}/spam`,
          ada,
          { blockSender: false },
        );
        expect(marked.status).toBe(201);
      }
      const merge = await call(
        'POST',
        `${brandPath(seeded.brandId)}/tickets/${merged.ticket.id}/merge`,
        ada,
        { primaryTicketId: kept.ticket.id },
      );
      expect(merge.status).toBe(200);

      const timeline = await call<{
        items: { id: string }[];
        visibleCount: number;
        hiddenCount: number;
      }>('GET', `${brandPath(seeded.brandId)}/contacts/${contact.id}/timeline`, sam);
      const listed = await call<{ contacts: { id: string; stats: ContactStats }[] }>(
        'GET',
        `${brandPath(seeded.brandId)}/contacts`,
        ada,
      );

      expect(timeline.body.items.map((item) => item.id)).toEqual([
        merged.ticket.id,
        kept.ticket.id,
      ]);
      expect(timeline.body.visibleCount).toBe(2);
      expect(timeline.body.hiddenCount).toBe(0);
      const stats = listed.body.contacts.find((row) => row.id === contact.id)?.stats;
      expect(stats?.totalTickets).toBe(2);
    });
  });

  // --------------------------------------------------------------- realtime

  describe('realtime (DOMAIN-RULES §1.4, §7)', () => {
    it('lets the ticket’s own department into its room and refuses another', async () => {
      const { ticket } = await createTicket(sam);

      const mine = await connect(sam);
      const theirs = await connect(bo);

      expect(await join(mine, ticketRoom(ticket.id))).toMatchObject({ ok: true });
      expect(await join(theirs, ticketRoom(ticket.id))).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    });

    it('lets an unrestricted scope into a department room of its own brand only', async () => {
      const admin = await connect(ada);

      expect(await join(admin, departmentRoom(support))).toMatchObject({ ok: true });
      // `all` means "every department *of this brand*", and the read says so.
      expect(await join(admin, departmentRoom(otherDepartment))).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    });

    it('tells the queue a ticket has left, and turns its ticket room out', async () => {
      // A room is authorised when it is joined, and a move changes who may read
      // the ticket. The old queue has to hear about it — its watchers are in no
      // other room the event reaches — and the ticket room has to be emptied,
      // so whoever was in it re-joins through the same check.
      const { ticket } = await createTicket(ada);
      await drainOutbox();

      const watchingSupport = await connect(ada);
      const inTicket = await connect(sam);
      expect(await join(watchingSupport, departmentRoom(support))).toMatchObject({ ok: true });
      expect(await join(inTicket, ticketRoom(ticket.id))).toMatchObject({ ok: true });

      const heardInOldQueue: unknown[] = [];
      const heardAfterEviction: unknown[] = [];
      watchingSupport.on(REALTIME_EVENTS.ticketChanged, (envelope) =>
        heardInOldQueue.push(envelope),
      );
      inTicket.on(REALTIME_EVENTS.ticketMessage, (envelope) => heardAfterEviction.push(envelope));

      await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
        departmentId: billing,
      });
      await drainOutbox();

      expect(await eventually(() => heardInOldQueue.length > 0)).toBe(true);

      // Sam was in the ticket room and is a Support agent, so after the move
      // there is no version of this they may still read. A reply now reaches
      // the room; it must not reach them.
      await call('POST', `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`, ada, {
        kind: 'note',
        bodyHtml: '<p>now a billing matter</p>',
      });
      await drainOutbox();

      expect(heardAfterEviction).toEqual([]);
      // And they may not get back in.
      expect(await join(inTicket, ticketRoom(ticket.id))).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    });

    it('delivers a reply to the ticket room and to nobody in another department', async () => {
      const { ticket } = await createTicket(sam);
      await drainOutbox();

      const inRoom = await connect(sam);
      const elsewhere = await connect(bo);
      expect(await join(inRoom, ticketRoom(ticket.id))).toMatchObject({ ok: true });
      expect(await join(elsewhere, departmentRoom(billing))).toMatchObject({ ok: true });

      const heard: { seq: number | null; data: { messageId: string } }[] = [];
      const overheard: unknown[] = [];
      inRoom.on(REALTIME_EVENTS.ticketMessage, (envelope) => heard.push(envelope));
      elsewhere.on(REALTIME_EVENTS.ticketMessage, (envelope) => overheard.push(envelope));

      const reply = await call<TicketMessage>(
        'POST',
        `${brandPath(seeded.brandId)}/tickets/${ticket.id}/messages`,
        sam,
        { kind: 'public', bodyHtml: '<p>on its way</p>' },
      );
      await drainOutbox();

      expect(await eventually(() => heard.length > 0)).toBe(true);
      expect(heard[0]?.seq).toBe(reply.body.seq);
      expect(heard[0]?.data.messageId).toBe(reply.body.id);
      expect(overheard).toEqual([]);
    });
  });

  // ------------------------------------------------------- M1-08 lifecycle

  /**
   * DOMAIN-RULES §2.2 and §2.3 against a real database.
   *
   * `transitions.test.ts` proves the table and `lifecycle.service.test.ts`
   * proves what the service does with each answer. What only a database can
   * prove is here: that the escalation of §1.2 really writes through a policy
   * that would otherwise refuse it, that a soft delete really disappears, and
   * that a status delete really moves the tickets that pointed at it.
   */
  describe('the ticket state machine (M1-08)', () => {
    const statusNamed = async (name: string): Promise<string> => {
      const statuses = await call<TicketStatusList>(
        'GET',
        `${brandPath(seeded.brandId)}/ticket-statuses`,
        ada,
      );
      const found = statuses.body.statuses.find((status) => status.name === name);
      if (found === undefined) {
        throw new Error(`no status named ${name}`);
      }

      return found.id;
    };

    const ticketRow = (ticketId: string) =>
      withSystem(runtime.db, seeded.brandId, async (tx) => {
        const rows = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
        return rows[0];
      });

    const activityOf = (ticketId: string) =>
      withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ action: ticketActivity.action })
          .from(ticketActivity)
          .where(eq(ticketActivity.ticketId, ticketId)),
      );

    // Deleting a status moves its tickets to the default Open status and leaves
    // their closed_at (`moveTicketsToStatus`), so 1.0 data has open tickets
    // that carry one. They are open tickets (#361 review).
    describe('an Open-status ticket that kept a closed_at from a deleted status', () => {
      const leftover = async () => {
        const { ticket } = await createTicket(ada);
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .update(tickets)
            .set({ closedAt: new Date('2026-01-01T00:00:00Z') })
            .where(eq(tickets.id, ticket.id)),
        );
        return ticket.id;
      };
      const path = (id: string) => `${brandPath(seeded.brandId)}/tickets/${id}`;

      it('can be snoozed', async () => {
        const id = await leftover();
        const until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

        const { status } = await call('PATCH', path(id), ada, { snoozedUntil: until });

        expect(status).toBe(200);
        // This suite's worker has no snooze handler; leave the outbox as found.
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.delete(outbox).where(eq(outbox.event, 'ticket.snoozed')),
        );
      });

      it('moves to another open status without counting as a reopen', async () => {
        const id = await leftover();

        const { status } = await call('PATCH', path(id), ada, {
          statusId: await statusNamed('Escalated'),
        });

        expect(status).toBe(200);
        expect((await activityOf(id)).map((row) => row.action)).not.toContain('ticket.reopened');
      });

      it('goes to Awaiting customer on an agent public reply, like any open ticket', async () => {
        const id = await leftover();

        const reply = await call('POST', `${path(id)}/messages`, ada, {
          kind: 'public',
          bodyHtml: '<p>On it</p>',
        });

        expect(reply.status).toBe(201);
        expect((await ticketRow(id))?.statusId).toBe(await statusNamed('Awaiting customer'));
      });
    });

    describe('closing and reopening', () => {
      it('sets closed_at on the way in and clears it on the way out (§2.2, §3.5)', async () => {
        const { ticket } = await createTicket(ada);

        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
          statusId: closedStatus,
        });
        expect((await ticketRow(ticket.id))?.closedAt).toBeInstanceOf(Date);

        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
          statusId: openStatus,
        });
        expect((await ticketRow(ticket.id))?.closedAt).toBeNull();
      });

      it('logs the close and the reopen beside the status change', async () => {
        const { ticket } = await createTicket(ada);

        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
          statusId: closedStatus,
        });
        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
          statusId: openStatus,
        });

        const actions = (await activityOf(ticket.id)).map((row) => row.action);
        expect(actions).toContain('ticket.closed');
        expect(actions).toContain('ticket.reopened');
      });

      it('names the close and the reopen as their own outbox events', async () => {
        const { ticket } = await createTicket(ada);
        await drainOutbox();

        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
          statusId: closedStatus,
        });
        expect((await unpublished()).map((row) => row.event)).toContain('ticket.closed');
        await drainOutbox();

        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
          statusId: openStatus,
        });
        expect((await unpublished()).map((row) => row.event)).toContain('ticket.reopened');
      });

      /**
       * Closed to Spam is one closure, not two. A ticket that closed twice is a
       * ticket a resolution report counts twice.
       */
      it('keeps the first closed_at when moving between two closed statuses', async () => {
        const { ticket } = await createTicket(ada);
        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
          statusId: closedStatus,
        });
        const first = (await ticketRow(ticket.id))?.closedAt;

        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
          statusId: await statusNamed('Spam'),
        });

        expect((await ticketRow(ticket.id))?.closedAt?.getTime()).toBe(first?.getTime());
      });
    });

    describe('escalating into a department the actor cannot see (§1.2)', () => {
      /**
       * The gap M1-02 named and left open. Sam is an Agent confined to Support;
       * Billing is invisible to them, and §1.2 allows the move all the same.
       */
      it('lets an Agent move a ticket to a department they cannot see', async () => {
        const { ticket } = await createTicket(sam);

        const moved = await call<Ticket>(
          'PATCH',
          `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
          sam,
          { departmentId: billing },
        );

        expect(moved.status).toBe(200);
        expect(moved.body.departmentId).toBe(billing);
      });

      it('and then answers 404 when they read it again', async () => {
        const { ticket } = await createTicket(sam);
        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, sam, {
          departmentId: billing,
        });

        expect(
          (await call('GET', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, sam)).status,
        ).toBe(404);

        // The agent who now owns it can read it, so the ticket moved rather
        // than vanishing.
        expect(
          (await call('GET', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, bo)).status,
        ).toBe(200);
      });

      it('takes the thread and the activity log with it, under the widened scope', async () => {
        const { ticket } = await createTicket(sam);
        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, sam, {
          departmentId: billing,
        });

        const moved = await withSystem(runtime.db, seeded.brandId, async (tx) => ({
          messages: await tx
            .select({ departmentId: ticketMessages.departmentId })
            .from(ticketMessages)
            .where(eq(ticketMessages.ticketId, ticket.id)),
          activity: await tx
            .select({ departmentId: ticketActivity.departmentId })
            .from(ticketActivity)
            .where(eq(ticketActivity.ticketId, ticket.id)),
        }));

        expect(moved.messages.every((row) => row.departmentId === billing)).toBe(true);
        expect(moved.activity.every((row) => row.departmentId === billing)).toBe(true);
      });

      it('audits it, because the actor can no longer see the ticket', async () => {
        const { ticket } = await createTicket(sam);
        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, sam, {
          departmentId: billing,
        });

        const audited = await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .select({ action: auditLog.action })
            .from(auditLog)
            .where(eq(auditLog.targetId, ticket.id)),
        );

        expect(audited.map((row) => row.action)).toContain('ticket.escalated');
      });

      it('puts the scope back, so the next request is narrow again', async () => {
        // Two tickets: if the widening leaked past the one statement it is for,
        // the escalated one would still be listable from Support afterwards.
        const first = await createTicket(sam);
        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${first.ticket.id}`, sam, {
          departmentId: billing,
        });

        const second = await createTicket(sam);
        const list = await call<TicketList>(
          'GET',
          `${brandPath(seeded.brandId)}/tickets?limit=100`,
          sam,
        );

        const ids = list.body.tickets.map((row) => row.id);
        expect(ids).toContain(second.ticket.id);
        expect(ids).not.toContain(first.ticket.id);
      });

      /**
       * Both halves in one request. The close writes a second activity row, and
       * the trigger stamps it with the ticket's department — by then the one the
       * actor cannot see — so it has to be written inside the same widened
       * window as the move.
       */
      it('escalates and closes in one request', async () => {
        const { ticket } = await createTicket(sam);

        const moved = await call<Ticket>(
          'PATCH',
          `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
          sam,
          { departmentId: billing, statusId: closedStatus },
        );

        expect(moved.status).toBe(200);
        expect(moved.body.departmentId).toBe(billing);
        expect((await ticketRow(ticket.id))?.closedAt).toBeInstanceOf(Date);
        expect((await activityOf(ticket.id)).map((row) => row.action)).toContain('ticket.closed');
      });

      it('still refuses a department id that is not this brands', async () => {
        const { ticket } = await createTicket(sam);

        const { status } = await call(
          'PATCH',
          `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
          sam,
          { departmentId: otherDepartment },
        );

        expect(status).toBe(404);
      });
    });

    describe('soft deletion (§2.2)', () => {
      it('hides the ticket from every view, and keeps the row', async () => {
        const { ticket } = await createTicket(ada);

        expect(
          (await call('DELETE', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada)).status,
        ).toBe(204);

        expect(
          (await call('GET', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada)).status,
        ).toBe(404);

        const list = await call<TicketList>(
          'GET',
          `${brandPath(seeded.brandId)}/tickets?limit=100`,
          ada,
        );
        expect(list.body.tickets.map((row) => row.id)).not.toContain(ticket.id);

        // The row is still there for retention to purge (§11).
        expect((await ticketRow(ticket.id))?.deletedAt).toBeInstanceOf(Date);
      });

      it('is refused to an Agent, because it hides the ticket from the whole brand', async () => {
        const { ticket } = await createTicket(sam);

        const { status } = await call(
          'DELETE',
          `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
          sam,
        );

        expect(status).toBe(403);
      });

      it('answers 404 to every later request about it', async () => {
        const { ticket } = await createTicket(ada);
        await call('DELETE', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada);

        // Invisible to a read, so the handler answers 404 before the transition
        // table is consulted — which is the stronger of the two answers.
        const { status } = await call(
          'PATCH',
          `${brandPath(seeded.brandId)}/tickets/${ticket.id}`,
          ada,
          { statusId: closedStatus },
        );

        expect(status).toBe(404);
      });
    });

    describe('the Statuses tab endpoints', () => {
      it('creates, renames and deletes a custom status', async () => {
        const created = await call<TicketStatus>(
          'POST',
          `${brandPath(seeded.brandId)}/ticket-statuses`,
          ada,
          {
            name: 'Waiting on supplier',
            systemState: 'on_hold',
            pausesSla: true,
            awaitingCustomer: false,
            color: 'warning',
          },
        );
        expect(created.status).toBe(201);
        expect(created.body.isSystem).toBe(false);

        const renamed = await call<TicketStatus>(
          'PATCH',
          `${brandPath(seeded.brandId)}/ticket-statuses/${created.body.id}`,
          ada,
          { name: 'Waiting on vendor' },
        );
        expect(renamed.body.name).toBe('Waiting on vendor');

        expect(
          (
            await call(
              'DELETE',
              `${brandPath(seeded.brandId)}/ticket-statuses/${created.body.id}`,
              ada,
            )
          ).status,
        ).toBe(204);
      });

      it('moves the tickets of a deleted status to the default, and logs each move', async () => {
        const created = await call<TicketStatus>(
          'POST',
          `${brandPath(seeded.brandId)}/ticket-statuses`,
          ada,
          {
            name: 'Waiting on legal',
            systemState: 'on_hold',
            pausesSla: false,
            awaitingCustomer: false,
            color: 'warning',
          },
        );
        const { ticket } = await createTicket(ada);
        await call('PATCH', `${brandPath(seeded.brandId)}/tickets/${ticket.id}`, ada, {
          statusId: created.body.id,
        });

        const usage = await call<TicketStatusUsage>(
          'GET',
          `${brandPath(seeded.brandId)}/ticket-statuses/${created.body.id}/usage`,
          ada,
        );
        expect(usage.body.ticketCount).toBe(1);
        expect(usage.body.fallbackStatusId).toBe(openStatus);

        await call(
          'DELETE',
          `${brandPath(seeded.brandId)}/ticket-statuses/${created.body.id}`,
          ada,
        );

        expect((await ticketRow(ticket.id))?.statusId).toBe(openStatus);
        expect((await activityOf(ticket.id)).map((row) => row.action)).toContain(
          'ticket.status.changed',
        );
      });

      it('refuses to delete a seeded status, and says which rule refused', async () => {
        const response = await call<{ error: { ticketing?: { reason: string } } }>(
          'DELETE',
          `${brandPath(seeded.brandId)}/ticket-statuses/${closedStatus}`,
          ada,
        );

        expect(response.status).toBe(409);
        expect(response.body.error.ticketing?.reason).toBe('status-is-system');
      });

      it('refuses to move a seeded statuss state or flags', async () => {
        const response = await call<{ error: { ticketing?: { reason: string } } }>(
          'PATCH',
          `${brandPath(seeded.brandId)}/ticket-statuses/${closedStatus}`,
          ada,
          { pausesSla: true },
        );

        expect(response.status).toBe(409);
        expect(response.body.error.ticketing?.reason).toBe('status-state-fixed');
      });

      it('lets a seeded status be renamed, then puts the name back', async () => {
        const response = await call<TicketStatus>(
          'PATCH',
          `${brandPath(seeded.brandId)}/ticket-statuses/${closedStatus}`,
          ada,
          { name: 'Resolved' },
        );

        expect(response.status).toBe(200);
        expect(response.body.name).toBe('Resolved');

        await call('PATCH', `${brandPath(seeded.brandId)}/ticket-statuses/${closedStatus}`, ada, {
          name: 'Closed',
        });
      });

      it('answers 404 for a status of another brand, not 403', async () => {
        const { status } = await call(
          'PATCH',
          `${brandPath(seeded.brandId)}/ticket-statuses/${otherBrandStatus}`,
          ada,
          { name: 'Theirs' },
        );

        expect(status).toBe(404);
      });

      /**
       * `tickets` is department-scoped, so a principal whose scope is not `'all'`
       * would move only their own tickets and then be refused by the foreign
       * key. Deleting a status is therefore `brand:manage`, exactly as deleting
       * a department is, and so is the count that precedes it.
       */
      it('keeps the delete and its count with the Admin', async () => {
        const created = await call<TicketStatus>(
          'POST',
          `${brandPath(seeded.brandId)}/ticket-statuses`,
          ada,
          {
            name: 'Waiting on finance',
            systemState: 'on_hold',
            pausesSla: false,
            awaitingCustomer: false,
            color: 'warning',
          },
        );

        // Bo is an Agent, and holds neither permission.
        expect(
          (
            await call(
              'GET',
              `${brandPath(seeded.brandId)}/ticket-statuses/${created.body.id}/usage`,
              bo,
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await call(
              'DELETE',
              `${brandPath(seeded.brandId)}/ticket-statuses/${created.body.id}`,
              bo,
            )
          ).status,
        ).toBe(403);

        await call(
          'DELETE',
          `${brandPath(seeded.brandId)}/ticket-statuses/${created.body.id}`,
          ada,
        );
      });

      it('is refused to an Agent, who manages no configuration at all', async () => {
        const { status } = await call('POST', `${brandPath(seeded.brandId)}/ticket-statuses`, sam, {
          name: 'Sneaky',
          systemState: 'open',
          pausesSla: false,
          awaitingCustomer: false,
          color: 'info',
        });

        expect(status).toBe(403);
      });
    });

    describe('the reply-behaviour route (§2.3)', () => {
      it('is refused to an Agent', async () => {
        const { status } = await call(
          'PATCH',
          `${brandPath(seeded.brandId)}/ticketing/reply-behaviour`,
          sam,
          { autoAwaitOnAgentReply: false },
        );

        expect(status).toBe(403);
      });

      it('writes only the keys it names, leaving the rest of settings alone', async () => {
        const response = await call<{ autoAwaitOnAgentReply: boolean; reopenPolicy: unknown }>(
          'PATCH',
          `${brandPath(seeded.brandId)}/ticketing/reply-behaviour`,
          ada,
          { reopenPolicy: { kind: 'never' } },
        );

        expect(response.status).toBe(200);
        expect(response.body.reopenPolicy).toEqual({ kind: 'never' });
        // Untouched by a request that did not name it.
        expect(response.body.autoAwaitOnAgentReply).toBe(true);

        await call('PATCH', `${brandPath(seeded.brandId)}/ticketing/reply-behaviour`, ada, {
          reopenPolicy: { kind: 'within_days', days: 7 },
        });
      });

      it('refuses a window outside the schemas range', async () => {
        const { status } = await call(
          'PATCH',
          `${brandPath(seeded.brandId)}/ticketing/reply-behaviour`,
          ada,
          { reopenPolicy: { kind: 'within_days', days: 0 } },
        );

        expect(status).toBe(400);
      });
    });
  });
});
