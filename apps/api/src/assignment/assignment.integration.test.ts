import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  createDb,
  type Db,
  type DbHandle,
  departments,
  outbox,
  ticketActivity,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import { type AssignmentOfflineUnassignPayload, silentLogger } from '@helpdock/jobs';
import type {
  AssignableAgentList,
  AssignmentAgent,
  AssignmentAgentList,
  DepartmentAssignment,
  DepartmentAssignmentList,
  PresenceStatus,
  TagSummary,
  Ticket,
  TicketDetail,
  TicketStatusList,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { AssignmentRepository } from './assignment.repository.js';
import {
  ASSIGNMENT_EVENTS,
  createAccessChangedHandler,
  createAssignmentRequestedHandler,
  createOfflineUnassignProcessor,
  createStaffOfflineHandler,
  type OfflineUnassignQueue,
} from './assignment-events.js';
import { RedisOfflineSinceStore } from './presence-adapters.js';
import { OutboxStaffOfflineHook } from './staff-offline.hook.js';

/**
 * M1-07 against a real Postgres and a real Redis, over real sessions.
 *
 * The unit suites prove the rotation picks correctly from values. This proves
 * what only exists once a database is under it:
 *
 * 1. **Who may configure what.** `ticketing:manage` for the tab, a Team Leader
 *    only inside the departments they lead and only over Agents; `ticket:write`
 *    for the picker, which answers with names and never with addresses.
 * 2. **A manual assignment is held to the department**, and a move the
 *    assignee cannot follow leaves the ticket unassigned.
 * 3. **The rotation runs from the outbox**, leaves an activity row and a
 *    `ticket.updated` row, honours the cap and the skills, never touches a
 *    closed or spam ticket — and two tickets picked at once cannot both breach
 *    one agent's cap.
 * 4. **Access changes and the offline timer unassign**, and `on_unassign`
 *    decides what happens next.
 * 5. **The two new tables are brand-isolated** (DOMAIN-RULES §1.6); the
 *    cross-brand half is `packages/db`'s negative suite.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 29).toString('base64');
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
    'Skipping the M1-07 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
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

describe.skipIf(!hasDocker)('assignment', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  /** Support routes by itself; Billing is where the manual-mode checks live. */
  let support: string;
  let billing: string;
  /** Agents of Support. */
  let sam: Person;
  let sue: Person;
  /** An Agent of Billing only. */
  let bo: Person;
  /** A Team Leader who leads Support and nothing else. */
  let tess: Person;
  /** The install admin: every department. */
  let ada: Person;

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

  const createTicket = async (
    who: Person,
    body: Record<string, unknown> = {},
  ): Promise<TicketDetail> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, who, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      departmentId: support,
      ...body,
    });
    expect(response.status).toBe(201);

    return response.body;
  };

  const configure = async (departmentId: string, body: Record<string, unknown>) => {
    const response = await call<DepartmentAssignment>(
      'PATCH',
      `${brandPath()}/assignment/${departmentId}`,
      ada,
      body,
    );
    expect(response.status).toBe(200);

    return response.body;
  };

  const repository = new AssignmentRepository();
  let online = new Set<string>();
  const presence = { online: async () => online };

  /** What the worker does with one `assignment.requested` row. */
  const runRotation = (ticketId: string, trigger: 'routed' | 'on_unassign' = 'routed') =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      createAssignmentRequestedHandler({ repository, presence })({
        outboxId: uuidv7(),
        brandId: seeded.brandId,
        event: ASSIGNMENT_EVENTS.requested,
        payload: { ticketId, trigger },
        tx,
        log: silentLogger,
      }),
    );

  const assigneeOf = async (ticketId: string): Promise<string | null> =>
    withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [row] = await tx
        .select({ assigneeId: tickets.assigneeId })
        .from(tickets)
        .where(eq(tickets.id, ticketId));

      return row?.assigneeId ?? null;
    });

  const outboxEvents = async (event: string): Promise<Record<string, unknown>[]> =>
    withSystem(runtime.db, seeded.brandId, async (tx) => {
      const rows = await tx
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(eq(outbox.event, event))
        .orderBy(desc(outbox.createdAt));

      return rows.map((row) => row.payload);
    });

  /** Clears every Support ticket's assignee, so each test starts from an empty load. */
  const closeOut = async (): Promise<void> => {
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.departmentId, support)),
    );
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
    redis = new Redis(redisContainer.getConnectionUrl());

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(runtime.db, 'sam');
    sue = await addPerson(runtime.db, 'sue');
    bo = await addPerson(runtime.db, 'bo');
    tess = await addPerson(runtime.db, 'tess');

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
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: sue.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: bo.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
        { userId: tess.id, brandId: seeded.brandId, role: 'team_leader', departmentIds: [support] },
      ]);
    });

    ada.token = await signIn(seeded.email, seeded.password);
    sam.token = await signIn(sam.email, PASSWORD);
    sue.token = await signIn(sue.email, PASSWORD);
    bo.token = await signIn(bo.email, PASSWORD);
    tess.token = await signIn(tess.email, PASSWORD);
  }, 300_000);

  afterAll(async () => {
    redis?.disconnect();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // ------------------------------------------------------------ the tab

  describe('settings', () => {
    it('lists every department for an Admin and only the led ones for a Team Leader', async () => {
      const admin = await call<DepartmentAssignmentList>('GET', `${brandPath()}/assignment`, ada);
      expect(admin.status).toBe(200);
      expect(admin.body.departments.map((row) => row.departmentId)).toEqual(
        expect.arrayContaining([support, billing]),
      );
      expect(admin.body.departments.find((row) => row.departmentId === support)).toMatchObject({
        mode: 'manual',
        loadCap: null,
        autoUnassignOffline: false,
        autoUnassignAfterMinutes: 15,
        onUnassign: 'leave_unassigned',
        // Sam and Sue are Agents of Support, so in rotation by default.
        agentsInRotation: 2,
      });

      const leader = await call<DepartmentAssignmentList>('GET', `${brandPath()}/assignment`, tess);
      expect(leader.body.departments.map((row) => row.departmentId)).toEqual([support]);
    });

    it('refuses an Agent, and a Team Leader outside the departments they lead', async () => {
      const agent = await call('PATCH', `${brandPath()}/assignment/${support}`, sam, {
        mode: 'round_robin',
      });
      expect(agent.status).toBe(403);

      const leader = await call<Refusal>('PATCH', `${brandPath()}/assignment/${billing}`, tess, {
        mode: 'round_robin',
      });
      expect(leader.status).toBe(403);
      expect(leader.body.error.ticketing?.reason).toBe('out-of-scope');
    });

    it('saves what a Team Leader changes in a department they lead, and audits it', async () => {
      const response = await call<DepartmentAssignment>(
        'PATCH',
        `${brandPath()}/assignment/${support}`,
        tess,
        { loadCap: 8, autoUnassignOffline: true, autoUnassignAfterMinutes: 30 },
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ loadCap: 8, autoUnassignAfterMinutes: 30 });

      const audited = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ actorId: auditLog.actorId })
          .from(auditLog)
          .where(and(eq(auditLog.action, 'assignment.updated'), eq(auditLog.targetId, support))),
      );
      expect(audited.map((row) => row.actorId)).toContain(tess.id);

      await configure(support, { loadCap: null, autoUnassignOffline: false });
    });

    it('refuses a cap below one and an empty change', async () => {
      expect(
        (await call('PATCH', `${brandPath()}/assignment/${support}`, ada, { loadCap: 0 })).status,
      ).toBe(400);
      expect((await call('PATCH', `${brandPath()}/assignment/${support}`, ada, {})).status).toBe(
        400,
      );
    });
  });

  describe('agents in a department', () => {
    it('lists who can work it, with rotation, presence and who the viewer may edit', async () => {
      const response = await call<AssignmentAgentList>(
        'GET',
        `${brandPath()}/assignment/${support}/agents`,
        tess,
      );
      expect(response.status).toBe(200);

      const byId = new Map(response.body.agents.map((agent) => [agent.userId, agent]));
      expect(byId.get(sam.id)).toMatchObject({
        inRotation: true,
        presence: 'offline',
        editable: true,
      });
      // An Admin reaches every department, is out of rotation by default, and a
      // Team Leader may not touch their row.
      expect(byId.get(ada.id)).toMatchObject({ inRotation: false, editable: false });
      // Bo works Billing only.
      expect(byId.has(bo.id)).toBe(false);
    });

    it('puts an agent in and out of rotation and replaces their skills', async () => {
      const tag = await call<TagSummary>('POST', `${brandPath()}/tags`, ada, {
        name: 'refunds',
        color: 'success',
      });
      const response = await call<AssignmentAgent>(
        'PATCH',
        `${brandPath()}/assignment/${support}/agents/${sam.id}`,
        tess,
        { inRotation: false, skillTagIds: [tag.body.id] },
      );
      expect(response.status).toBe(200);
      expect(response.body.inRotation).toBe(false);
      expect(response.body.skills.map((skill) => skill.name)).toEqual(['refunds']);

      const back = await call<AssignmentAgent>(
        'PATCH',
        `${brandPath()}/assignment/${support}/agents/${sam.id}`,
        tess,
        { inRotation: true, skillTagIds: [] },
      );
      expect(back.body).toMatchObject({ inRotation: true, skills: [] });
    });

    it('refuses a Team Leader acting on an Admin, and anybody who cannot work the department', async () => {
      const admin = await call<Refusal>(
        'PATCH',
        `${brandPath()}/assignment/${support}/agents/${ada.id}`,
        tess,
        { inRotation: true },
      );
      expect(admin.status).toBe(403);
      expect(admin.body.error.ticketing?.reason).toBe('out-of-scope');

      const stranger = await call<Refusal>(
        'PATCH',
        `${brandPath()}/assignment/${support}/agents/${bo.id}`,
        ada,
        { inRotation: true },
      );
      expect(stranger.status).toBe(409);
      expect(stranger.body.error.ticketing?.reason).toBe('not-eligible');
    });

    it('refuses a skill that is not one of the brand tags', async () => {
      const response = await call(
        'PATCH',
        `${brandPath()}/assignment/${support}/agents/${sam.id}`,
        ada,
        { skillTagIds: [uuidv7()] },
      );
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------- the picker

  describe('the assignee picker', () => {
    it('answers an Agent with names, presence and counts, and nobody above them', async () => {
      const response = await call<AssignableAgentList>(
        'GET',
        `${brandPath()}/assignment/${support}/assignable`,
        sam,
      );
      expect(response.status).toBe(200);

      const ids = response.body.agents.map((agent) => agent.userId);
      expect(ids).toEqual(expect.arrayContaining([sam.id, sue.id, tess.id]));
      expect(ids).not.toContain(ada.id);
      expect(ids).not.toContain(bo.id);
      // The output schema strips whatever the roster knows beyond this.
      expect(Object.keys(response.body.agents[0] ?? {}).sort()).toEqual(
        ['name', 'openCount', 'presence', 'userId'].sort(),
      );
    });

    it('offers an Admin to an Admin', async () => {
      const response = await call<AssignableAgentList>(
        'GET',
        `${brandPath()}/assignment/${support}/assignable`,
        ada,
      );
      expect(response.body.agents.map((agent) => agent.userId)).toContain(ada.id);
    });

    it('answers a department outside the viewer scope as not found', async () => {
      const response = await call('GET', `${brandPath()}/assignment/${billing}/assignable`, sam);
      expect(response.status).toBe(404);
    });
  });

  // ------------------------------------------------- manual assignment

  describe('manual assignment', () => {
    it('refuses somebody who cannot work the ticket department', async () => {
      const ticket = await createTicket(sam);
      const response = await call<Refusal>(
        'PATCH',
        `${brandPath()}/tickets/${ticket.ticket.id}`,
        sam,
        { assigneeId: bo.id },
      );
      expect(response.status).toBe(409);
      expect(response.body.error.ticketing?.reason).toBe('not-eligible');

      const created = await call<Refusal>('POST', `${brandPath()}/tickets`, sam, {
        subject: 'Hello',
        bodyHtml: '<p>Hi</p>',
        departmentId: support,
        assigneeId: bo.id,
      });
      expect(created.status).toBe(409);
    });

    it('refuses a non-Admin routing work to an Admin', async () => {
      const ticket = await createTicket(sam);
      const response = await call<Refusal>(
        'PATCH',
        `${brandPath()}/tickets/${ticket.ticket.id}`,
        tess,
        { assigneeId: ada.id },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.ticketing?.reason).toBe('assignee-above-actor');

      const byAdmin = await call('PATCH', `${brandPath()}/tickets/${ticket.ticket.id}`, ada, {
        assigneeId: ada.id,
      });
      expect(byAdmin.status).toBe(200);
    });

    it('lets a person pick an agent at cap', async () => {
      await closeOut();
      await configure(support, { loadCap: 1 });
      await createTicket(sam, { assigneeId: sue.id });

      const second = await createTicket(sam, { assigneeId: sue.id });
      expect(second.ticket.assigneeId).toBe(sue.id);

      await configure(support, { loadCap: null });
    });

    it('leaves a moved ticket unassigned when the assignee cannot follow it', async () => {
      const ticket = await createTicket(ada, { assigneeId: sam.id });
      const moved = await call<Ticket>('PATCH', `${brandPath()}/tickets/${ticket.ticket.id}`, ada, {
        departmentId: billing,
      });
      expect(moved.status).toBe(200);
      expect(moved.body.assigneeId).toBeNull();

      const kept = await createTicket(ada, { assigneeId: ada.id });
      const movedWithAdmin = await call<Ticket>(
        'PATCH',
        `${brandPath()}/tickets/${kept.ticket.id}`,
        ada,
        { departmentId: billing },
      );
      expect(movedWithAdmin.body.assigneeId).toBe(ada.id);
    });
  });

  // ------------------------------------------------------ the rotation

  describe('the rotation', () => {
    it('asks for a pick only in a department that routes by itself', async () => {
      await configure(support, { mode: 'manual' });
      const manual = await createTicket(sam);
      expect(
        (await outboxEvents(ASSIGNMENT_EVENTS.requested)).map((payload) => payload.ticketId),
      ).not.toContain(manual.ticket.id);

      await configure(support, { mode: 'round_robin' });
      const routed = await createTicket(sam);
      expect(await outboxEvents(ASSIGNMENT_EVENTS.requested)).toContainEqual({
        ticketId: routed.ticket.id,
        trigger: 'routed',
      });

      const assigned = await createTicket(sam, { assigneeId: sam.id });
      expect(
        (await outboxEvents(ASSIGNMENT_EVENTS.requested)).map((payload) => payload.ticketId),
      ).not.toContain(assigned.ticket.id);
    });

    it('gives each ticket to the online agent who waited longest, and records it', async () => {
      await closeOut();
      await configure(support, { mode: 'round_robin', loadCap: null });
      online = new Set([sam.id, sue.id]);

      const first = await createTicket(ada);
      const second = await createTicket(ada);
      await runRotation(first.ticket.id);
      await runRotation(second.ticket.id);

      const picked = [await assigneeOf(first.ticket.id), await assigneeOf(second.ticket.id)];
      expect(new Set(picked)).toEqual(new Set([sam.id, sue.id]));

      const activity = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ actorType: ticketActivity.actorType, to: ticketActivity.to })
          .from(ticketActivity)
          .where(
            and(
              eq(ticketActivity.ticketId, first.ticket.id),
              eq(ticketActivity.action, 'ticket.updated'),
            ),
          ),
      );
      expect(activity).toContainEqual({
        actorType: 'system',
        to: { assigneeId: picked[0], assignedBy: 'round_robin' },
      });
      expect((await outboxEvents('ticket.updated')).map((payload) => payload.ticketId)).toContain(
        first.ticket.id,
      );
    });

    it('skips anybody offline, away or out of rotation, and leaves the ticket if nobody is left', async () => {
      await closeOut();
      await configure(support, { mode: 'round_robin', loadCap: null });
      online = new Set([sue.id]);
      const ticket = await createTicket(ada);
      await runRotation(ticket.ticket.id);
      expect(await assigneeOf(ticket.ticket.id)).toBe(sue.id);

      online = new Set();
      const nobody = await createTicket(ada);
      await runRotation(nobody.ticket.id);
      expect(await assigneeOf(nobody.ticket.id)).toBeNull();
    });

    it('skips an agent at cap rather than queueing for them', async () => {
      await closeOut();
      await configure(support, { mode: 'round_robin', loadCap: 1 });
      online = new Set([sam.id, sue.id]);

      const tickets = [await createTicket(ada), await createTicket(ada), await createTicket(ada)];
      for (const ticket of tickets) {
        await runRotation(ticket.ticket.id);
      }

      const assignees = await Promise.all(tickets.map((ticket) => assigneeOf(ticket.ticket.id)));
      expect(assignees.filter((id) => id !== null).sort()).toEqual([sam.id, sue.id].sort());
      expect(assignees.filter((id) => id === null)).toHaveLength(1);

      await configure(support, { loadCap: null });
    });

    it('never breaches a cap when two tickets are picked at once', async () => {
      await closeOut();
      await configure(support, { mode: 'round_robin', loadCap: 1 });
      online = new Set([sam.id, sue.id]);

      const tickets = await Promise.all(Array.from({ length: 6 }, () => createTicket(ada)));
      await Promise.all(tickets.map((ticket) => runRotation(ticket.ticket.id)));

      const assignees = await Promise.all(tickets.map((ticket) => assigneeOf(ticket.ticket.id)));
      const held = assignees.filter((id): id is string => id !== null);
      // Without the brand's rotation lock, two transactions both read an agent
      // at zero and both hand them a ticket.
      expect(held.sort()).toEqual([sam.id, sue.id].sort());

      await configure(support, { loadCap: null });
    });

    it('prefers a skilled agent in skill-based mode, and anyone when nobody matches', async () => {
      await closeOut();
      await configure(support, { mode: 'skill_based' });
      online = new Set([sam.id, sue.id]);
      const tag = await call<TagSummary>('POST', `${brandPath()}/tags`, ada, {
        name: 'vat',
        color: 'info',
      });
      await call('PATCH', `${brandPath()}/assignment/${support}/agents/${sue.id}`, ada, {
        skillTagIds: [tag.body.id],
      });

      // Sam has waited longer, so plain round-robin would pick him.
      const skilled = await createTicket(ada, { tagIds: [tag.body.id] });
      await runRotation(skilled.ticket.id);
      expect(await assigneeOf(skilled.ticket.id)).toBe(sue.id);

      const plain = await createTicket(ada);
      await runRotation(plain.ticket.id);
      expect(await assigneeOf(plain.ticket.id)).not.toBeNull();

      await configure(support, { mode: 'round_robin' });
    });

    it('never hands out a spam, closed or already-assigned ticket', async () => {
      await closeOut();
      await configure(support, { mode: 'round_robin', loadCap: null });
      online = new Set([sam.id, sue.id]);
      const statuses = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`, ada);
      const spam = statuses.body.statuses.find((status) => status.name === 'Spam');
      const closed = statuses.body.statuses.find(
        (status) => status.systemState === 'closed' && !status.excludedFromReports,
      );

      const spammed = await createTicket(ada);
      await call('PATCH', `${brandPath()}/tickets/${spammed.ticket.id}`, ada, {
        statusId: spam?.id,
      });
      const shut = await createTicket(ada);
      await call('PATCH', `${brandPath()}/tickets/${shut.ticket.id}`, ada, {
        statusId: closed?.id,
      });
      const taken = await createTicket(ada, { assigneeId: ada.id });

      for (const ticket of [spammed, shut, taken]) {
        await runRotation(ticket.ticket.id);
      }

      expect(await assigneeOf(spammed.ticket.id)).toBeNull();
      expect(await assigneeOf(shut.ticket.id)).toBeNull();
      expect(await assigneeOf(taken.ticket.id)).toBe(ada.id);
    });

    it('routes a ticket moved unassigned into a department that routes by itself', async () => {
      await configure(support, { mode: 'round_robin' });
      const ticket = await createTicket(ada, { departmentId: billing });
      const moved = await call('PATCH', `${brandPath()}/tickets/${ticket.ticket.id}`, ada, {
        departmentId: support,
      });
      expect(moved.status).toBe(200);
      expect(await outboxEvents(ASSIGNMENT_EVENTS.requested)).toContainEqual({
        ticketId: ticket.ticket.id,
        trigger: 'routed',
      });
    });
  });

  // ----------------------------------------------------- losing access

  describe('on_unassign', () => {
    it('unassigns what a narrowed agent can no longer work and re-routes it', async () => {
      await closeOut();
      await configure(support, { mode: 'manual', onUnassign: 'round_robin' });
      online = new Set([sam.id, sue.id]);

      const ticket = await createTicket(ada, { assigneeId: sam.id });
      const narrowed = await call('PATCH', `${brandPath()}/staff/${sam.id}`, ada, {
        departmentIds: [billing],
      });
      expect(narrowed.status).toBe(200);
      expect(await outboxEvents(ASSIGNMENT_EVENTS.accessChanged)).toContainEqual({
        userId: sam.id,
      });

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        createAccessChangedHandler({ repository, presence })({
          outboxId: uuidv7(),
          brandId: seeded.brandId,
          event: ASSIGNMENT_EVENTS.accessChanged,
          payload: { userId: sam.id },
          tx,
          log: silentLogger,
        }),
      );

      // Round-robin, even though Support's own mode is manual; Sam is no longer
      // eligible, so it can only be Sue.
      expect(await assigneeOf(ticket.ticket.id)).toBe(sue.id);

      await call('PATCH', `${brandPath()}/staff/${sam.id}`, ada, { departmentIds: [support] });
      await configure(support, { mode: 'round_robin', onUnassign: 'leave_unassigned' });
    });

    it('leaves the ticket unassigned when the department says so', async () => {
      await closeOut();
      const ticket = await createTicket(ada, { assigneeId: sue.id });
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await tx
          .update(userBrandRoles)
          .set({ departmentIds: [billing] })
          .where(eq(userBrandRoles.userId, sue.id));
        await createAccessChangedHandler({ repository, presence })({
          outboxId: uuidv7(),
          brandId: seeded.brandId,
          event: ASSIGNMENT_EVENTS.accessChanged,
          payload: { userId: sue.id },
          tx,
          log: silentLogger,
        });
        await tx
          .update(userBrandRoles)
          .set({ departmentIds: [support] })
          .where(eq(userBrandRoles.userId, sue.id));
      });

      expect(await assigneeOf(ticket.ticket.id)).toBeNull();
    });
  });

  // ---------------------------------------------------- the offline timer

  describe('auto-unassign on offline', () => {
    const added: { jobId: string; delayMs: number; payload: AssignmentOfflineUnassignPayload }[] =
      [];
    const queue: OfflineUnassignQueue = {
      add: async (job) => {
        added.push(job);
      },
    };
    const offlineSince = () => new RedisOfflineSinceStore(redis);
    let status: PresenceStatus = 'offline';
    const lookup = { statusOf: async () => status };

    const runOffline = (payload: AssignmentOfflineUnassignPayload) =>
      withSystem(runtime.db, seeded.brandId, (tx) =>
        createOfflineUnassignProcessor({
          repository,
          presence,
          lookup,
          offlineSince: offlineSince(),
        })({ payload, brandId: seeded.brandId, tx, job: {} as Job, log: silentLogger }),
      );

    it('writes nothing for a brand where no department auto-unassigns', async () => {
      const before = (await outboxEvents(ASSIGNMENT_EVENTS.staffOffline)).length;
      await new OutboxStaffOfflineHook(runtime.db).onStaffOffline(
        sam.id,
        seeded.brandId,
        new Date(),
      );

      expect(await outboxEvents(ASSIGNMENT_EVENTS.staffOffline)).toHaveLength(before);
    });

    it('schedules the department timer, unassigns when it fires, and re-routes', async () => {
      await closeOut();
      await configure(support, {
        mode: 'round_robin',
        autoUnassignOffline: true,
        autoUnassignAfterMinutes: 15,
      });
      online = new Set([sue.id]);
      const ticket = await createTicket(ada, { assigneeId: sam.id });

      const since = new Date();
      await new OutboxStaffOfflineHook(runtime.db).onStaffOffline(sam.id, seeded.brandId, since);
      const [payload] = await outboxEvents(ASSIGNMENT_EVENTS.staffOffline);
      expect(payload).toEqual({ userId: sam.id, since: since.toISOString() });

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        createStaffOfflineHandler({
          repository,
          presence,
          offlineSince: offlineSince(),
          queue,
          now: () => since,
        })({
          outboxId: uuidv7(),
          brandId: seeded.brandId,
          event: ASSIGNMENT_EVENTS.staffOffline,
          payload: payload ?? {},
          tx,
          log: silentLogger,
        }),
      );

      const job = added.find((entry) => entry.payload.userId === sam.id);
      expect(job).toMatchObject({
        delayMs: 15 * 60_000,
        payload: { brandId: seeded.brandId, userId: sam.id, departmentId: support },
      });

      status = 'online';
      await runOffline(job?.payload as AssignmentOfflineUnassignPayload);
      expect(await assigneeOf(ticket.ticket.id)).toBe(sam.id);

      status = 'offline';
      await runOffline(job?.payload as AssignmentOfflineUnassignPayload);
      expect(await assigneeOf(ticket.ticket.id)).toBe(sue.id);
    });

    it('ignores a timer that a later departure superseded', async () => {
      await closeOut();
      const ticket = await createTicket(ada, { assigneeId: sam.id });
      const earlier = new Date(Date.now() - 60_000).toISOString();
      const later = new Date().toISOString();
      await offlineSince().set(seeded.brandId, sam.id, later);
      // A redelivered older departure must not move the key backwards.
      await offlineSince().set(seeded.brandId, sam.id, earlier);

      await runOffline({
        brandId: seeded.brandId,
        userId: sam.id,
        departmentId: support,
        since: earlier,
      });
      expect(await assigneeOf(ticket.ticket.id)).toBe(sam.id);

      await configure(support, { autoUnassignOffline: false });
    });
  });

  // -------------------------------------------------------- isolation

  it('keeps the rotation tables inside the brand the transaction names', async () => {
    const otherBrand = uuidv7();
    const rows = await withTenant(
      runtime.db,
      {
        brandIds: [otherBrand],
        departmentIds: 'all',
        principalType: 'system',
        principalId: 'test',
      },
      (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT (SELECT count(*) FROM assignment_agents)::int + (SELECT count(*) FROM assignment_skills)::int AS n`,
        ),
    );
    expect([...rows][0]?.n).toBe(0);
  });
});
