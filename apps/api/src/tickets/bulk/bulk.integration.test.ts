import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  type Db,
  type DbHandle,
  departments,
  notificationEmailBatches,
  notifications,
  outbox,
  ticketActivity,
  ticketBulkOperationItems,
  ticketBulkOperations,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { deliveryDelayMs, silentLogger } from '@helpdock/jobs';
import type {
  BulkChanges,
  BulkResponse,
  BulkUndoResponse,
  Tag,
  TicketDetail,
  TicketStatusList,
} from '@helpdock/schemas';
import { BULK_MAX_TICKETS } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { createLogger } from '../../logging/logger.js';
import { EmailPacingRepository } from '../../notifications/email-pacing.repository.js';
import {
  createBulkUndoneHandler,
  createFanOutHandler,
} from '../../notifications/notification-events.js';
import { NotificationsRepository } from '../../notifications/notifications.repository.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';
import { dockerAvailable } from '../../testing/docker-available.js';
import { signInForTest } from '../../testing/staff-sign-in.js';
import { BULK_EVENTS } from './bulk-events.js';

/**
 * M14-03 against a real Postgres and a real Redis, over real sessions: the
 * preview and the apply of a bulk edit, every rule a single edit has applied
 * ticket by ticket, the operation log and its Undo, and a batch racing single
 * edits on the same tickets.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;
const HOUR = 3_600_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M14-03 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface ErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly lifecycle?: { readonly reason?: string };
    readonly message?: string;
  };
}

describe.skipIf(!hasDocker)('bulk edit', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  let open: string;
  let awaiting: string;
  let closed: string;
  let snoozedStatus: string;
  let ada: Person;
  /** An Agent who works Billing and nothing else. */
  let bea: Person;
  /** An Agent who works both departments. */
  let cy: Person;
  let tagA: Tag;
  let tagB: Tag;

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

  const createTicket = async (body: Record<string, unknown> = {}): Promise<string> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, ada, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      departmentId: support,
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body.ticket.id;
  };

  const createMany = async (count: number, body: Record<string, unknown> = {}) => {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(await createTicket(body));
    }
    return ids;
  };

  const bulk = (
    who: Person,
    mode: 'preview' | 'apply',
    ticketIds: readonly string[],
    changes: BulkChanges,
    expect?: readonly string[],
  ) =>
    call<BulkResponse & ErrorBody>('POST', `${brandPath()}/tickets/bulk`, who, {
      ticketIds,
      changes,
      mode,
      ...(expect === undefined ? {} : { expect }),
    });

  /** Preview, then apply exactly what the preview said would change. */
  const previewAndApply = async (
    who: Person,
    ticketIds: readonly string[],
    changes: BulkChanges,
  ) => {
    const preview = await bulk(who, 'preview', ticketIds, changes);
    expect(preview.status).toBe(200);
    const expected = preview.body.results
      .filter((result) => result.outcome === 'will_change')
      .map((result) => result.ticketId);
    return bulk(who, 'apply', ticketIds, changes, expected);
  };

  const undo = (who: Person, operationId: string) =>
    call<BulkUndoResponse & ErrorBody>(
      'POST',
      `${brandPath()}/tickets/bulk/${operationId}/undo`,
      who,
    );

  const rowOf = async (ticketId: string) => {
    const [row] = await owner.db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (row === undefined) {
      throw new Error(`no ticket ${ticketId}`);
    }
    return row;
  };

  const activityOf = (ticketId: string, action?: string) =>
    owner.db
      .select()
      .from(ticketActivity)
      .where(
        action === undefined
          ? eq(ticketActivity.ticketId, ticketId)
          : and(eq(ticketActivity.ticketId, ticketId), eq(ticketActivity.action, action)),
      )
      .orderBy(asc(ticketActivity.createdAt), asc(ticketActivity.id));

  type OutboxRow = Record<string, unknown> & { id: string };
  const outboxOf = async (event: string, ticketIds: readonly string[]): Promise<OutboxRow[]> =>
    (
      await owner.db
        .select({ id: outbox.id, payload: outbox.payload })
        .from(outbox)
        .where(
          and(
            eq(outbox.event, event),
            inArray(sql`${outbox.payload}->>'ticketId'`, [...ticketIds]),
          ),
        )
        .orderBy(asc(outbox.id))
    ).map((row) => ({ ...(row.payload as Record<string, unknown>), id: row.id }));

  const operationCount = async () => (await owner.db.select().from(ticketBulkOperations)).length;

  /** The budget is per person per minute; each test starts with a full one. */
  beforeEach(async () => {
    const keys = await runtime.redis.keys('auth:rate:ticket-bulk-*');
    if (keys.length > 0) {
      await runtime.redis.del(...keys);
    }
  });

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
    owner = createDb({ url: ownerUrl.toString(), max: 4 });

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    bea = await addPerson(runtime.db, 'bea');
    cy = await addPerson(runtime.db, 'cy');

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
      await tx.insert(userBrandRoles).values([
        {
          userId: bea.id,
          brandId: seeded.brandId,
          role: 'agent',
          departmentIds: [billing],
        },
        {
          userId: cy.id,
          brandId: seeded.brandId,
          role: 'agent',
          departmentIds: [support, billing],
        },
      ]);
    });

    ada.token = await signInForTest(app, { email: seeded.email, password: seeded.password });
    bea.token = await signInForTest(app, { email: bea.email, password: PASSWORD });
    cy.token = await signInForTest(app, { email: cy.email, password: PASSWORD });

    const statuses = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`, ada);
    open = statuses.body.statuses.find((status) => status.isDefault)?.id ?? '';
    awaiting = statuses.body.statuses.find((status) => status.awaitingCustomer)?.id ?? '';
    snoozedStatus = statuses.body.statuses.find((status) => status.isSnoozed === true)?.id ?? '';
    closed =
      statuses.body.statuses.find(
        (status) => status.systemState === 'closed' && !status.excludedFromReports,
      )?.id ?? '';

    const tagResponses = await Promise.all(
      ['alpha', 'beta'].map((name) => call<Tag>('POST', `${brandPath()}/tags`, ada, { name })),
    );
    [tagA, tagB] = tagResponses.map((response) => response.body) as [Tag, Tag];
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('the request', () => {
    it('refuses more than the cap, repeats, an empty change, and an apply without expect', async () => {
      const ids = Array.from({ length: BULK_MAX_TICKETS + 1 }, () => uuidv7());
      const one = uuidv7();

      expect((await bulk(ada, 'preview', ids, { priority: 'high' })).status).toBe(400);
      expect((await bulk(ada, 'preview', [one, one], { priority: 'high' })).status).toBe(400);
      expect((await bulk(ada, 'preview', [one], {})).status).toBe(400);
      expect((await bulk(ada, 'apply', [one], { priority: 'high' })).status).toBe(400);
      expect((await bulk(ada, 'preview', [one], { close: true, snoozedUntil: null })).status).toBe(
        400,
      );
      expect(
        (
          await call('POST', `${brandPath()}/tickets/bulk`, ada, {
            ticketIds: [one],
            mode: 'preview',
            changes: { priority: 'high', reply: 'hello' },
          })
        ).status,
      ).toBe(400);
    });

    it('accepts exactly the cap', async () => {
      const ids = Array.from({ length: BULK_MAX_TICKETS }, () => uuidv7());

      const response = await bulk(ada, 'preview', ids, { priority: 'high' });

      expect(response.status).toBe(200);
      expect(response.body.counts.notFound).toBe(BULK_MAX_TICKETS);
    });
  });

  describe('preview', () => {
    it('says per ticket what would change, what would not and what is refused, and writes nothing', async () => {
      const [fresh, already, shut] = await createMany(3);
      await call('PATCH', `${brandPath()}/tickets/${already}`, ada, { priority: 'high' });
      await call('PATCH', `${brandPath()}/tickets/${shut}`, ada, { statusId: closed });
      const missing = uuidv7();
      const before = await outboxOf('ticket.updated', [fresh as string]);

      const response = await bulk(ada, 'preview', [fresh, already, shut, missing] as string[], {
        priority: 'high',
      });

      expect(response.status).toBe(200);
      expect(response.body.operationId).toBeNull();
      expect(response.body.results.map((result) => result.outcome)).toEqual([
        'will_change',
        'unchanged',
        'will_change',
        'not_found',
      ]);
      expect(response.body.results[0]?.fields).toEqual(['priority']);
      expect(response.body.counts).toEqual({
        willChange: 2,
        unchanged: 1,
        refused: 0,
        notFound: 1,
      });
      expect((await rowOf(fresh as string)).priority).toBe('medium');
      expect(await outboxOf('ticket.updated', [fresh as string])).toHaveLength(before.length);
      expect(await activityOf(fresh as string, 'ticket.updated')).toHaveLength(0);
      expect(await operationCount()).toBe(0);
    });

    it('refuses snoozing a closed ticket with the single edit’s own code', async () => {
      const [shut, live] = await createMany(2);
      await call('PATCH', `${brandPath()}/tickets/${shut}`, ada, { statusId: closed });

      const response = await bulk(ada, 'preview', [shut, live] as string[], {
        snoozedUntil: new Date(Date.now() + 2 * HOUR).toISOString(),
      });

      expect(response.body.results.map((result) => [result.outcome, result.code])).toEqual([
        ['refused', 'ticket-closed'],
        ['will_change', null],
      ]);
      expect(await rowOf(live as string)).toMatchObject({ statusId: open, snoozedUntil: null });
    });

    it('refuses Snoozed as a bare status, and an assignee above the actor', async () => {
      const [mine] = await createMany(1, { departmentId: billing });

      const bare = await bulk(bea, 'preview', [mine] as string[], { statusId: snoozedStatus });
      const above = await bulk(bea, 'preview', [mine] as string[], { assigneeId: ada.id });
      const peer = await bulk(bea, 'preview', [mine] as string[], { assigneeId: cy.id });

      expect(bare.body.results[0]).toMatchObject({
        outcome: 'refused',
        code: 'snooze-requires-time',
      });
      expect(above.body.results[0]).toMatchObject({
        outcome: 'refused',
        code: 'assignee-above-actor',
      });
      expect(peer.body.results[0]?.outcome).toBe('will_change');
    });
  });

  describe('department scope', () => {
    it('reports a ticket the caller cannot see as not found, like one that does not exist', async () => {
      const [elsewhere] = await createMany(1, { departmentId: support });
      const [mine] = await createMany(1, { departmentId: billing });
      const missing = uuidv7();

      const response = await bulk(bea, 'preview', [elsewhere, mine, missing] as string[], {
        priority: 'urgent',
      });

      expect(response.body.results.map((result) => result.outcome)).toEqual([
        'not_found',
        'will_change',
        'not_found',
      ]);
      expect(response.body.results[0]).toEqual({
        ticketId: elsewhere,
        outcome: 'not_found',
        fields: [],
        code: null,
      });
    });

    it('applies to the tickets in scope and leaves the others untouched', async () => {
      const [elsewhere] = await createMany(1, { departmentId: support });
      const mine = await createMany(2, { departmentId: billing });

      const response = await previewAndApply(bea, [elsewhere as string, ...mine], {
        priority: 'urgent',
      });

      expect(response.status).toBe(200);
      expect(response.body.counts).toMatchObject({ willChange: 2, notFound: 1 });
      expect((await rowOf(elsewhere as string)).priority).toBe('medium');
      for (const id of mine) {
        expect((await rowOf(id)).priority).toBe('urgent');
      }
    });

    it('lets an escalation out of sight go through, and an Undo cannot follow it', async () => {
      const mine = await createMany(2, { departmentId: billing });

      const applied = await previewAndApply(bea, mine, { departmentId: support });

      expect(applied.status).toBe(200);
      for (const id of mine) {
        expect((await rowOf(id)).departmentId).toBe(support);
      }
      const items = await owner.db
        .select()
        .from(ticketBulkOperationItems)
        .where(eq(ticketBulkOperationItems.operationId, applied.body.operationId as string));
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.departmentId === support)).toBe(true);

      const back = await undo(bea, applied.body.operationId as string);
      expect(back.status).toBe(200);
      expect(back.body.results).toEqual([]);
      expect(back.body.notFound).toBe(2);
      for (const id of mine) {
        expect((await rowOf(id)).departmentId).toBe(support);
      }
    });
  });

  describe('apply', () => {
    it('writes the single edit’s activity, events and outbox rows for every ticket, recorded as bulk', async () => {
      const ids = await createMany(3);

      const response = await previewAndApply(ada, ids, { priority: 'high', assigneeId: cy.id });

      expect(response.status).toBe(200);
      expect(response.body.counts.willChange).toBe(3);
      const operationId = response.body.operationId as string;
      expect(Date.parse(response.body.undoUntil as string) - Date.now()).toBeGreaterThan(50_000);
      for (const id of ids) {
        expect(await rowOf(id)).toMatchObject({ priority: 'high', assigneeId: cy.id });
        const [entry] = await activityOf(id, 'ticket.updated');
        expect(entry).toMatchObject({
          via: 'bulk',
          actorId: ada.id,
          from: { priority: 'medium', assigneeId: null },
          to: { priority: 'high', assigneeId: cy.id },
        });
      }
      // One event of each kind per ticket, exactly as three single edits write.
      const updated = await outboxOf('ticket.updated', ids);
      expect(ids.every((id) => updated.some((row) => row.ticketId === id))).toBe(true);
      const assigned = await outboxOf('ticket.assigned', ids);
      expect(assigned).toHaveLength(3);
      expect(assigned.every((row) => row.bulkOperationId === operationId)).toBe(true);
      const [operation] = await owner.db
        .select()
        .from(ticketBulkOperations)
        .where(eq(ticketBulkOperations.id, operationId));
      expect(operation).toMatchObject({ actorId: ada.id, ticketCount: 3, undoneAt: null });
      expect(operation?.changes).toEqual({ priority: 'high', assigneeId: cy.id });
      const items = await owner.db
        .select()
        .from(ticketBulkOperationItems)
        .where(eq(ticketBulkOperationItems.operationId, operationId));
      expect(items.map((item) => item.ticketId).sort()).toEqual([...ids].sort());
      expect(items[0]).toMatchObject({
        before: { priority: 'medium', assigneeId: null },
        after: { priority: 'high', assigneeId: cy.id },
      });
    });

    it('emits one status webhook event per changed ticket on a bulk close, and a close reaches the lifecycle once each', async () => {
      const ids = await createMany(2);

      const response = await previewAndApply(ada, ids, { close: true });

      expect(response.body.counts.willChange).toBe(2);
      const statusEvents = await outboxOf('ticket.status_changed', ids);
      expect(statusEvents).toHaveLength(2);
      expect(statusEvents.every((row) => row.statusId === closed)).toBe(true);
      for (const id of ids) {
        const row = await rowOf(id);
        expect(row.statusId).toBe(closed);
        expect(row.closedAt).not.toBeNull();
        expect((await activityOf(id, 'ticket.closed'))[0]).toMatchObject({ via: 'bulk' });
      }
    });

    it('rolls the whole batch back when a ticket the preview named is refused by apply time', async () => {
      const [first, second] = await createMany(2);
      const changes: BulkChanges = { snoozedUntil: new Date(Date.now() + 3 * HOUR).toISOString() };
      const preview = await bulk(ada, 'preview', [first, second] as string[], changes);
      expect(preview.body.counts.willChange).toBe(2);
      // Closed between the preview and the apply.
      await call('PATCH', `${brandPath()}/tickets/${second}`, ada, { statusId: closed });
      const operations = await operationCount();

      const response = await bulk(ada, 'apply', [first, second] as string[], changes, [
        first,
        second,
      ] as string[]);

      expect(response.status).toBe(409);
      expect(response.body.error?.lifecycle?.reason).toBe('bulk-changed');
      expect(await rowOf(first as string)).toMatchObject({ statusId: open, snoozedUntil: null });
      expect(await activityOf(first as string, 'ticket.snoozed')).toHaveLength(0);
      expect(await outboxOf('ticket.snoozed', [first as string])).toHaveLength(0);
      expect(await operationCount()).toBe(operations);
    });

    it('rolls back when a ticket the preview did not name would now change', async () => {
      const [first, second] = await createMany(2);
      await call('PATCH', `${brandPath()}/tickets/${second}`, ada, { priority: 'high' });
      const preview = await bulk(ada, 'preview', [first, second] as string[], {
        priority: 'high',
      });
      expect(preview.body.results.map((result) => result.outcome)).toEqual([
        'will_change',
        'unchanged',
      ]);
      await call('PATCH', `${brandPath()}/tickets/${second}`, ada, { priority: 'low' });

      const response = await bulk(ada, 'apply', [first, second] as string[], { priority: 'high' }, [
        first,
      ] as string[]);

      expect(response.status).toBe(409);
      expect((await rowOf(first as string)).priority).toBe('medium');
      expect((await rowOf(second as string)).priority).toBe('low');
    });

    it('applies nothing and records nothing when nothing would change', async () => {
      const [id] = await createMany(1);
      const operations = await operationCount();

      const response = await bulk(ada, 'apply', [id] as string[], { priority: 'medium' }, []);

      expect(response.status).toBe(200);
      expect(response.body.operationId).toBeNull();
      expect(await operationCount()).toBe(operations);
    });

    it('snoozes and wakes through the snooze path, with its timer event per ticket', async () => {
      const ids = await createMany(2);
      const until = new Date(Date.now() + 4 * HOUR).toISOString();

      const asleep = await previewAndApply(ada, ids, { snoozedUntil: until });

      expect(asleep.body.results.every((result) => result.fields.join() === 'snoozedUntil')).toBe(
        true,
      );
      for (const id of ids) {
        expect(await rowOf(id)).toMatchObject({ statusId: snoozedStatus, snoozedBy: ada.id });
        expect((await activityOf(id, 'ticket.snoozed'))[0]).toMatchObject({ via: 'bulk' });
      }
      expect(await outboxOf('ticket.snoozed', ids)).toHaveLength(2);

      const awake = await previewAndApply(ada, ids, { snoozedUntil: null });

      expect(awake.body.counts.willChange).toBe(2);
      for (const id of ids) {
        expect(await rowOf(id)).toMatchObject({ statusId: open, snoozedUntil: null });
      }
    });

    it('adds and removes tags as one tag change per ticket', async () => {
      const [one, two] = await createMany(2);
      await call('PUT', `${brandPath()}/tickets/${two}/tags`, ada, { tagIds: [tagA.id] });

      const response = await previewAndApply(ada, [one, two] as string[], {
        addTagIds: [tagB.id],
        removeTagIds: [tagA.id],
      });

      expect(response.body.results.map((result) => result.fields)).toEqual([['tags'], ['tags']]);
      for (const id of [one, two] as string[]) {
        const detail = await call<TicketDetail>('GET', `${brandPath()}/tickets/${id}`, ada);
        expect(detail.body.ticket.tags?.map((tag) => tag.id)).toEqual([tagB.id]);
        expect((await activityOf(id, 'ticket.tags.changed')).at(-1)?.via).toBe('bulk');
      }
    });

    it('marks spam through the spam path without blocking the sender', async () => {
      const [id] = await createMany(1);

      const response = await previewAndApply(ada, [id] as string[], { spam: true });

      expect(response.body.results[0]?.fields).toEqual(['spam']);
      expect((await activityOf(id as string, 'ticket.marked_spam'))[0]).toMatchObject({
        via: 'bulk',
      });
      expect(await outboxOf('ticket.spam', [id as string])).toHaveLength(1);
    });
  });

  describe('a batch that races single edits', () => {
    it('completes overlapping batches with reversed id lists and single edits without a deadlock', async () => {
      const ids = await createMany(20);
      const forward = [...ids].sort();
      const backward = [...forward].reverse();
      const expectedHigh = (await bulk(ada, 'preview', forward, { priority: 'high' })).body.results
        .filter((result) => result.outcome === 'will_change')
        .map((result) => result.ticketId);
      const expectedMine = (
        await bulk(ada, 'preview', backward, { assigneeId: cy.id })
      ).body.results
        .filter((result) => result.outcome === 'will_change')
        .map((result) => result.ticketId);

      const responses = await Promise.all([
        bulk(ada, 'apply', forward, { priority: 'high' }, expectedHigh),
        bulk(cy, 'apply', backward, { assigneeId: cy.id }, expectedMine),
        ...ids.flatMap((id) => [
          call('PATCH', `${brandPath()}/tickets/${id}`, ada, { subject: `edited ${id}` }),
          call('PATCH', `${brandPath()}/tickets/${id}`, cy, { subject: `again ${id}` }),
        ]),
      ]);

      expect(responses.map((response) => response.status)).toEqual(responses.map(() => 200));
      for (const id of ids) {
        expect(await rowOf(id)).toMatchObject({ priority: 'high', assigneeId: cy.id });
      }
    });
  });

  describe('undo', () => {
    it('puts back what the operation changed, as a bulk undo, and once only', async () => {
      const ids = await createMany(2);
      const applied = await previewAndApply(ada, ids, { priority: 'urgent', assigneeId: cy.id });
      const operationId = applied.body.operationId as string;

      const response = await undo(ada, operationId);

      expect(response.status).toBe(200);
      expect(response.body.results.map((result) => result.outcome)).toEqual([
        'reverted',
        'reverted',
      ]);
      for (const id of ids) {
        expect(await rowOf(id)).toMatchObject({ priority: 'medium', assigneeId: null });
        expect((await activityOf(id, 'ticket.updated')).at(-1)).toMatchObject({
          via: 'bulk_undo',
          to: { priority: 'medium', assigneeId: null },
        });
      }
      const [operation] = await owner.db
        .select()
        .from(ticketBulkOperations)
        .where(eq(ticketBulkOperations.id, operationId));
      expect(operation?.undoneAt).not.toBeNull();
      expect(await outboxOf('ticket.updated', ids)).toEqual(
        expect.arrayContaining(ids.map((ticketId) => expect.objectContaining({ ticketId }))),
      );

      const again = await undo(ada, operationId);
      expect(again.status).toBe(409);
      expect(again.body.error?.lifecycle?.reason).toBe('bulk-already-undone');
    });

    it('keeps a field somebody changed since, and says so', async () => {
      const [changedAfter, untouched] = await createMany(2);
      const applied = await previewAndApply(ada, [changedAfter, untouched] as string[], {
        priority: 'urgent',
      });
      await call('PATCH', `${brandPath()}/tickets/${changedAfter}`, cy, { priority: 'low' });

      const response = await undo(ada, applied.body.operationId as string);

      expect(response.body.results).toEqual([
        expect.objectContaining({
          ticketId: changedAfter,
          outcome: 'kept',
          reverted: [],
          kept: ['priority'],
        }),
        expect.objectContaining({
          ticketId: untouched,
          outcome: 'reverted',
          reverted: ['priority'],
        }),
      ]);
      expect((await rowOf(changedAfter as string)).priority).toBe('low');
      expect((await rowOf(untouched as string)).priority).toBe('medium');
    });

    it('reverts the fields still holding the operation’s value and keeps the rest', async () => {
      const [id] = await createMany(1);
      const applied = await previewAndApply(ada, [id] as string[], {
        priority: 'urgent',
      });
      const second = await previewAndApply(ada, [id] as string[], { assigneeId: cy.id });
      expect(second.body.counts.willChange).toBe(1);

      const response = await undo(ada, applied.body.operationId as string);

      expect(response.body.results[0]).toMatchObject({
        outcome: 'reverted',
        reverted: ['priority'],
      });
      expect(await rowOf(id as string)).toMatchObject({ priority: 'medium', assigneeId: cy.id });
    });

    it('puts tags back as a set, leaving a tag a colleague added', async () => {
      const [id] = await createMany(1);
      await call('PUT', `${brandPath()}/tickets/${id}/tags`, ada, { tagIds: [tagA.id] });
      const applied = await previewAndApply(ada, [id] as string[], {
        addTagIds: [tagB.id],
        removeTagIds: [tagA.id],
      });
      await call('PUT', `${brandPath()}/tickets/${id}/tags`, cy, {
        tagIds: [tagB.id, tagA.id],
      });
      // The colleague put alpha back; the undo takes beta off and leaves alpha.
      const response = await undo(ada, applied.body.operationId as string);

      expect(response.body.results[0]?.reverted).toEqual(['tags']);
      const detail = await call<TicketDetail>('GET', `${brandPath()}/tickets/${id}`, ada);
      expect(detail.body.ticket.tags?.map((tag) => tag.id)).toEqual([tagA.id]);
    });

    it('undoes a close and a snooze through the same paths as a single edit', async () => {
      const [shut, asleep] = await createMany(2);
      const closedOp = await previewAndApply(ada, [shut] as string[], { close: true });
      const snoozeOp = await previewAndApply(ada, [asleep] as string[], {
        snoozedUntil: new Date(Date.now() + 5 * HOUR).toISOString(),
      });

      const reopened = await undo(ada, closedOp.body.operationId as string);
      const woken = await undo(ada, snoozeOp.body.operationId as string);

      expect(reopened.body.results[0]?.outcome).toBe('reverted');
      expect(await rowOf(shut as string)).toMatchObject({ statusId: open, closedAt: null });
      expect((await activityOf(shut as string, 'ticket.reopened')).at(-1)?.via).toBe('bulk_undo');
      expect(woken.body.results[0]?.outcome).toBe('reverted');
      expect(await rowOf(asleep as string)).toMatchObject({ statusId: open, snoozedUntil: null });
    });

    it('puts a bulk reopen’s tickets back as they were closed, with the original close time and no new survey', async () => {
      const ids = await createMany(2);
      for (const id of ids) {
        await call('PATCH', `${brandPath()}/tickets/${id}`, ada, { statusId: closed });
      }
      const closedAt = await Promise.all(ids.map(async (id) => (await rowOf(id)).closedAt));
      const surveys = (await outboxOf('csat.requested', ids)).length;
      const reopened = await previewAndApply(ada, ids, { statusId: open });
      expect(reopened.body.counts.willChange).toBe(2);

      const response = await undo(ada, reopened.body.operationId as string);

      expect(response.body.results.map((result) => result.outcome)).toEqual([
        'reverted',
        'reverted',
      ]);
      for (const [index, id] of ids.entries()) {
        expect(await rowOf(id)).toMatchObject({ statusId: closed, closedAt: closedAt[index] });
      }
      expect(await outboxOf('csat.requested', ids)).toHaveLength(surveys);
    });

    it('sends no survey when the undo of a bulk close reopens the tickets', async () => {
      const ids = await createMany(2);
      const closedAll = await previewAndApply(ada, ids, { close: true });
      const surveys = (await outboxOf('csat.requested', ids)).length;

      await undo(ada, closedAll.body.operationId as string);

      expect(await outboxOf('csat.requested', ids)).toHaveLength(surveys);
      for (const id of ids) {
        expect(await rowOf(id)).toMatchObject({ statusId: open, closedAt: null });
      }
    });

    it('is the actor’s alone, and gone after its 60 seconds', async () => {
      const [id] = await createMany(1);
      const applied = await previewAndApply(ada, [id] as string[], { priority: 'high' });
      const operationId = applied.body.operationId as string;

      expect((await undo(cy, operationId)).status).toBe(404);
      expect((await undo(ada, uuidv7())).status).toBe(404);

      await owner.db
        .update(ticketBulkOperations)
        .set({ undoUntil: new Date(Date.now() - 1_000) })
        .where(eq(ticketBulkOperations.id, operationId));
      const late = await undo(ada, operationId);
      expect(late.status).toBe(409);
      expect(late.body.error?.lifecycle?.reason).toBe('bulk-undo-expired');
      expect((await rowOf(id as string)).priority).toBe('high');
    });

    it('reports a field a rule refuses to put back, with the rule’s code, and keeps it', async () => {
      const [id] = await createMany(1);
      const asleep = new Date(Date.now() + 6 * HOUR).toISOString();
      await call('PATCH', `${brandPath()}/tickets/${id}`, ada, { snoozedUntil: asleep });
      const applied = await previewAndApply(ada, [id] as string[], { close: true });
      expect(applied.body.results[0]?.fields).toEqual(['statusId']);

      // The ticket was Snoozed before the close; Snoozed cannot be put back without a wake time.
      const response = await undo(ada, applied.body.operationId as string);

      expect(response.body.results[0]).toMatchObject({
        outcome: 'kept',
        reverted: [],
        kept: ['statusId'],
        code: 'snooze-requires-time',
      });
      expect((await rowOf(id as string)).statusId).toBe(closed);
    });
  });

  describe('surveys after a bulk close', () => {
    it('asks for the survey after the Undo window, and an undone close sends none', async () => {
      const [kept, undone] = await createMany(2);

      const closedAll = await previewAndApply(ada, [kept, undone] as string[], { close: true });
      await undo(ada, closedAll.body.operationId as string);
      const reclosed = await previewAndApply(ada, [kept] as string[], { close: true });
      expect(reclosed.status).toBe(200);

      const requests = await outboxOf('csat.requested', [kept, undone] as string[]);
      const now = new Date();
      expect(requests.length).toBeGreaterThanOrEqual(3);
      for (const request of requests) {
        expect(request.deliverAfter).toEqual(expect.any(String));
        expect(deliveryDelayMs(request, now)).toBeGreaterThan(0);
      }
      // The first close was undone: its survey would find the ticket open and skip.
      expect((await rowOf(undone as string)).closedAt).toBeNull();
    });
  });

  describe('notifications', () => {
    const fanOut = createFanOutHandler({
      repository: new NotificationsRepository(),
      pushConfigured: () => Promise.resolve(false),
    });
    const withdraw = createBulkUndoneHandler({ repository: new NotificationsRepository() });

    const dispatch = (event: string, row: OutboxRow) =>
      withSystem(runtime.db, seeded.brandId, (tx) => {
        const { id, ...payload } = row;
        const handler = event === BULK_EVENTS.undone ? withdraw : fanOut;
        return handler({
          outboxId: id,
          brandId: seeded.brandId,
          event,
          payload,
          tx,
          log: silentLogger,
        });
      });

    const bulkNotifications = (operationId: string) =>
      owner.db.select().from(notifications).where(eq(notifications.bulkOperationId, operationId));

    it('carries the operation on an assignment’s notification, and an Undo withdraws what is unread', async () => {
      const ids = await createMany(2);
      const applied = await previewAndApply(ada, ids, { assigneeId: cy.id });
      const operationId = applied.body.operationId as string;
      for (const row of await outboxOf('ticket.assigned', ids)) {
        await dispatch('ticket.assigned', row);
      }
      const made = await bulkNotifications(operationId);
      expect(made).toHaveLength(2);
      expect(made.every((row) => row.userId === cy.id && row.kind === 'assigned')).toBe(true);
      await owner.db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(eq(notifications.id, made[0]?.id ?? ''));

      await undo(ada, operationId);
      const [undone] = await owner.db
        .select({ id: outbox.id, payload: outbox.payload })
        .from(outbox)
        .where(
          and(
            eq(outbox.event, BULK_EVENTS.undone),
            sql`${outbox.payload}->>'operationId' = ${operationId}`,
          ),
        );
      expect(undone).toBeDefined();
      await dispatch(BULK_EVENTS.undone, {
        id: undone?.id ?? '',
        ...(undone?.payload as Record<string, unknown>),
      });

      const left = await bulkNotifications(operationId);
      expect(left.map((row) => row.id)).toEqual([made[0]?.id]);
    });

    it('withdraws only the tickets whose assignee the Undo put back, and keeps one it had to keep', async () => {
      const [reverted, kept] = await createMany(2);
      const applied = await previewAndApply(ada, [reverted, kept] as string[], {
        assigneeId: cy.id,
      });
      const operationId = applied.body.operationId as string;
      for (const row of await outboxOf('ticket.assigned', [reverted, kept] as string[])) {
        await dispatch('ticket.assigned', row);
      }
      // A colleague reassigns one ticket after the bulk edit, so the Undo has to leave it.
      await call('PATCH', `${brandPath()}/tickets/${kept}`, ada, { assigneeId: ada.id });

      const response = await undo(ada, operationId);
      expect(response.body.results.map((result) => [result.ticketId, result.outcome])).toEqual(
        expect.arrayContaining([
          [reverted, 'reverted'],
          [kept, 'kept'],
        ]),
      );
      const [undone] = await owner.db
        .select({ id: outbox.id, payload: outbox.payload })
        .from(outbox)
        .where(
          and(
            eq(outbox.event, BULK_EVENTS.undone),
            sql`${outbox.payload}->>'operationId' = ${operationId}`,
          ),
        );
      expect(undone?.payload).toMatchObject({ ticketIds: [reverted] });
      await dispatch(BULK_EVENTS.undone, { ...(undone?.payload as object), id: undone?.id ?? '' });

      expect((await bulkNotifications(operationId)).map((row) => row.ticketId)).toEqual([kept]);
    });

    it('hands the operation to the bell’s panel and to the email batch, which fold on it', async () => {
      const ids = await createMany(2);
      const applied = await previewAndApply(ada, ids, { assigneeId: cy.id });
      const operationId = applied.body.operationId as string;
      for (const row of await outboxOf('ticket.assigned', ids)) {
        await dispatch('ticket.assigned', row);
      }

      const panel = await withSystem(runtime.db, seeded.brandId, (tx) =>
        new NotificationsRepository().panel(tx, {
          brandId: seeded.brandId,
          userId: cy.id,
          unreadOnly: false,
          since: new Date(Date.now() - 60_000),
          limit: 10,
        }),
      );
      const folded = panel.filter((row) => row.bulkOperationId === operationId);
      expect(folded).toHaveLength(2);
      // The count is the operation's, however many rows the panel was asked for.
      expect(folded.map((row) => row.bulkOperationCount)).toEqual([2, 2]);
      expect(
        panel
          .filter((row) => row.bulkOperationId === null)
          .every((row) => row.bulkOperationCount === 0),
      ).toBe(true);

      const [batch] = await owner.db
        .insert(notificationEmailBatches)
        .values({
          brandId: seeded.brandId,
          userId: cy.id,
          kind: 'immediate',
          scheduledFor: new Date(),
        })
        .returning({ id: notificationEmailBatches.id });
      await owner.db
        .update(notifications)
        .set({ emailBatchId: batch?.id ?? '', emailState: 'pending' })
        .where(eq(notifications.bulkOperationId, operationId));
      const items = await withSystem(runtime.db, seeded.brandId, (tx) =>
        new EmailPacingRepository().batchItems(tx, batch?.id ?? ''),
      );
      expect(items.map((item) => item.bulkOperationId)).toEqual([operationId, operationId]);
    });

    it('counts only the operation’s tickets the reader can still see', async () => {
      const [stays, moves] = await createMany(2, { departmentId: billing });
      const named = [stays, moves] as string[];
      const applied = await previewAndApply(ada, named, { assigneeId: bea.id });
      const operationId = applied.body.operationId as string;
      for (const row of await outboxOf('ticket.assigned', named)) {
        await dispatch('ticket.assigned', row);
      }
      // Bea works Billing only: once one ticket moves to Support it is out of her sight.
      expect(
        (await call('PATCH', `${brandPath()}/tickets/${moves}`, ada, { departmentId: support }))
          .status,
      ).toBe(200);

      const panel = await call<{
        items: { bulkOperationId: string | null; bulkOperationCount: number }[];
      }>('GET', `${brandPath()}/notifications`, bea);

      const rows = panel.body.items.filter((row) => row.bulkOperationId === operationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.bulkOperationCount).toBe(1);
    });

    it('withdraws nothing for tickets the Undo could not follow out of sight', async () => {
      const mine = await createMany(2, { departmentId: billing });
      const applied = await previewAndApply(bea, mine, {
        assigneeId: cy.id,
        departmentId: support,
      });
      const operationId = applied.body.operationId as string;
      for (const row of await outboxOf('ticket.assigned', mine)) {
        await dispatch('ticket.assigned', row);
      }

      const response = await undo(bea, operationId);

      expect(response.body).toMatchObject({ results: [], notFound: 2 });
      const withdrawals = await owner.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.event, BULK_EVENTS.undone),
            sql`${outbox.payload}->>'operationId' = ${operationId}`,
          ),
        );
      expect(withdrawals).toEqual([]);
      expect(await bulkNotifications(operationId)).toHaveLength(2);
    });

    it('makes no notification for an operation that was undone before its event ran', async () => {
      const [id] = await createMany(1);
      const applied = await previewAndApply(ada, [id] as string[], { assigneeId: cy.id });
      await undo(ada, applied.body.operationId as string);

      for (const row of await outboxOf('ticket.assigned', [id as string])) {
        if (row.bulkOperationId === applied.body.operationId) {
          await dispatch('ticket.assigned', row);
        }
      }

      expect(await bulkNotifications(applied.body.operationId as string)).toEqual([]);
    });
  });

  describe('status and custom fields', () => {
    it('moves a ticket through the status path, so the same transition rules apply', async () => {
      const [id] = await createMany(1);

      const response = await previewAndApply(ada, [id] as string[], { statusId: awaiting });

      expect(response.body.results[0]?.fields).toEqual(['statusId']);
      expect((await rowOf(id as string)).statusId).toBe(awaiting);
    });

    it('sets one custom field value, validated like a single edit, and undoes it', async () => {
      const field = await call<{ key: string }>('POST', `${brandPath()}/custom-fields`, ada, {
        target: 'ticket',
        key: 'order_ref',
        label: 'Order',
        type: 'text',
      });
      expect(field.status).toBe(201);
      const [id] = await createMany(1);

      const bad = await bulk(ada, 'preview', [id] as string[], {
        customField: { key: 'no_such_field', value: 'x' },
      });
      expect(bad.body.results[0]).toMatchObject({ outcome: 'refused' });

      const applied = await previewAndApply(ada, [id] as string[], {
        customField: { key: 'order_ref', value: 'A-1' },
      });
      expect(applied.body.results[0]?.fields).toEqual(['custom']);
      expect((await rowOf(id as string)).custom).toMatchObject({ order_ref: 'A-1' });

      await undo(ada, applied.body.operationId as string);
      expect((await rowOf(id as string)).custom.order_ref ?? null).toBeNull();
    });
  });

  describe('the rate limit', () => {
    it('allows twenty applies a minute per person and then answers 429, per person', async () => {
      const [id] = await createMany(1);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const ok = await bulk(cy, 'apply', [id] as string[], { priority: 'medium' }, []);
        expect(ok.status).toBe(200);
      }
      const limited = await bulk(cy, 'apply', [id] as string[], { priority: 'medium' }, []);
      const other = await bulk(ada, 'apply', [id] as string[], { priority: 'medium' }, []);

      expect(limited.status).toBe(429);
      expect(other.status).toBe(200);
    });
  });
});
