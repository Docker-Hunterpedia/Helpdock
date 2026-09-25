import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  type Db,
  type DbHandle,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  views,
  withSystem,
  withTenant,
} from '@helpdock/db';
import type {
  DepartmentSummary,
  TicketDetail,
  TicketList,
  TicketView,
  TicketViewCountList,
  TicketViewList,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';

/**
 * M1-05 against a real Postgres, over real sessions.
 *
 * The unit suite proves the rules decide correctly on values. This proves what
 * only exists once a database is under them:
 *
 * 1. **The defaults are rows**, seeded with the brand, and a department's "All
 *    open" follows the department through create, rename and delete.
 * 2. **A personal view is its owner's alone**, by the owner policy: a colleague
 *    and an Admin both get 404.
 * 3. **A view never widens access.** An Agent of Support counting "Unassigned"
 *    counts Support's unassigned tickets, however many Billing has, and "My
 *    open" and "Overdue" are predicates the server evaluates for the reader.
 * 4. **Sharing follows DOMAIN-RULES §1.2**: an Agent cannot share, a Team
 *    Leader shares only with the departments they lead.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 29).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M1-05 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
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

describe.skipIf(!hasDocker)('views', () => {
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
  /** An Agent of Billing. */
  let bo: Person;
  /** A Team Leader who leads Support and nothing else. */
  let tess: Person;
  /** The install admin, whose department scope is `all`. */
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
  const viewsOf = async (who: Person): Promise<TicketView[]> =>
    (await call<TicketViewList>('GET', `${brandPath()}/views`, who)).body.views;
  const countsOf = async (who: Person): Promise<Record<string, number>> => {
    const [list, counts] = await Promise.all([
      viewsOf(who),
      call<TicketViewCountList>('GET', `${brandPath()}/views/counts`, who),
    ]);
    const nameOf = new Map(list.map((view) => [view.id, view.name]));

    return Object.fromEntries(
      counts.body.counts.map((count) => [nameOf.get(count.viewId), count.count]),
    );
  };

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
      passwordHash: await new PasswordHasher(masterKey).hash(STAFF_PASSWORD),
    });

    return { id, email, token: '' };
  };

  const addDepartment = async (name: string): Promise<string> => {
    const response = await call<DepartmentSummary>('POST', `${brandPath()}/departments`, ada, {
      name,
    });
    expect(response.status).toBe(201);

    return response.body.id;
  };

  const createTicket = async (departmentId: string, assigneeId?: string): Promise<string> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, ada, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      departmentId,
      ...(assigneeId === undefined ? {} : { assigneeId }),
    });
    expect(response.status).toBe(201);

    return response.body.ticket.id;
  };

  const shared = (departmentIds?: readonly string[]) => ({
    name: `Shared ${uuidv7().slice(-6)}`,
    filters: { priority: ['urgent'] },
    visibility:
      departmentIds === undefined ? { kind: 'brand' } : { kind: 'departments', departmentIds },
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
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    ada.token = await signIn(seeded.email, seeded.password);

    support = await addDepartment('Support');
    billing = await addDepartment('Billing');

    sam = await addPerson(runtime.db, 'sam');
    bo = await addPerson(runtime.db, 'bo');
    tess = await addPerson(runtime.db, 'tess');
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: bo.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
        { userId: tess.id, brandId: seeded.brandId, role: 'team_leader', departmentIds: [support] },
      ]),
    );
    sam.token = await signIn(sam.email, STAFF_PASSWORD);
    bo.token = await signIn(bo.email, STAFF_PASSWORD);
    tess.token = await signIn(tess.email, STAFF_PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('the defaults', () => {
    it('are seeded with the brand, one "All open" per department', async () => {
      const names = (await viewsOf(ada)).map((view) => view.name);

      expect(names).toEqual([
        'My open',
        'Unassigned',
        'Overdue',
        'All open · General',
        'All open · Support',
        'All open · Billing',
        'Escalated',
      ]);
    });

    it('show an Agent the brand-wide ones and their own department’s', async () => {
      const names = (await viewsOf(sam)).map((view) => view.name);

      expect(names).toContain('All open · Support');
      expect(names).not.toContain('All open · Billing');
    });

    it('follow a department through rename and delete', async () => {
      const returns = await addDepartment('Returns');
      expect((await viewsOf(ada)).map((view) => view.name)).toContain('All open · Returns');

      await call('PATCH', `${brandPath()}/departments/${returns}`, ada, { name: 'Refunds' });
      expect((await viewsOf(ada)).map((view) => view.name)).toContain('All open · Refunds');

      expect((await call('DELETE', `${brandPath()}/departments/${returns}`, ada)).status).toBe(204);
      expect((await viewsOf(ada)).map((view) => view.name)).not.toContain('All open · Refunds');
    });

    it('may be renamed and hidden but never deleted or refiltered', async () => {
      const unassigned = (await viewsOf(ada)).find((view) => view.builtIn === 'unassigned');
      const path = `${brandPath()}/views/${unassigned?.id}`;

      const refused = await call<Refusal>('DELETE', path, ada);
      expect(refused.status).toBe(409);
      expect(refused.body.error.ticketing?.reason).toBe('view-is-built-in');

      const refiltered = await call<Refusal>('PATCH', path, ada, { filters: {} });
      expect(refiltered.body.error.ticketing?.reason).toBe('view-is-built-in');

      const renamed = await call<TicketView>('PATCH', path, ada, { name: 'Up for grabs' });
      expect(renamed.body.name).toBe('Up for grabs');

      await call('PATCH', path, ada, { hidden: true });
      const counts = await countsOf(sam);
      expect(counts).not.toHaveProperty('Up for grabs');

      await call('PATCH', path, ada, { hidden: false, name: 'Unassigned' });
    });
  });

  describe('a personal view', () => {
    it('is its owner’s alone, to a colleague and to an Admin', async () => {
      const created = await call<TicketView>('POST', `${brandPath()}/views`, sam, {
        name: 'My urgent ones',
        filters: { priority: ['urgent'], assigneeId: ['me'] },
      });
      expect(created.status).toBe(201);
      expect(created.body.visibility).toEqual({ kind: 'personal' });

      expect((await viewsOf(sam)).map((view) => view.id)).toContain(created.body.id);
      expect((await viewsOf(tess)).map((view) => view.id)).not.toContain(created.body.id);
      expect((await viewsOf(ada)).map((view) => view.id)).not.toContain(created.body.id);

      const path = `${brandPath()}/views/${created.body.id}`;
      expect((await call('PATCH', path, ada, { name: 'Taken' })).status).toBe(404);
      expect((await call('DELETE', path, bo)).status).toBe(404);
      expect((await call('DELETE', path, sam)).status).toBe(204);
    });

    it('may be kept by a Viewer', async () => {
      const vera = await addPerson(runtime.db, 'vera');
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .insert(userBrandRoles)
          .values({ userId: vera.id, brandId: seeded.brandId, role: 'viewer' }),
      );
      vera.token = await signIn(vera.email, STAFF_PASSWORD);

      const created = await call<TicketView>('POST', `${brandPath()}/views`, vera, {
        name: 'Escalated urgent',
        filters: { systemState: ['escalated'], priority: ['urgent'] },
      });

      expect(created.status).toBe(201);
    });

    it('is invisible to a colleague in SQL too', async () => {
      const created = await call<TicketView>('POST', `${brandPath()}/views`, bo, {
        name: 'Billing mine',
        filters: {},
      });

      const seen = await withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: 'all',
          principalType: 'staff',
          principalId: ada.id,
        },
        (tx) => tx.select({ id: views.id }).from(views).where(eq(views.id, created.body.id)),
      );

      expect(seen).toEqual([]);
    });
  });

  describe('sharing', () => {
    it('is refused to an Agent', async () => {
      const response = await call<Refusal>('POST', `${brandPath()}/views`, sam, shared([support]));

      expect(response.status).toBe(403);
      expect(response.body.error.ticketing?.reason).toBe('out-of-scope');
    });

    it('lets a Team Leader share with the departments they lead, and no wider', async () => {
      expect((await call('POST', `${brandPath()}/views`, tess, shared([support]))).status).toBe(
        201,
      );
      expect((await call('POST', `${brandPath()}/views`, tess, shared([billing]))).status).toBe(
        403,
      );
      expect((await call('POST', `${brandPath()}/views`, tess, shared())).status).toBe(403);
    });

    it('shows a department view to that department only', async () => {
      const created = await call<TicketView>(
        'POST',
        `${brandPath()}/views`,
        ada,
        shared([billing]),
      );

      expect((await viewsOf(bo)).map((view) => view.id)).toContain(created.body.id);
      expect((await viewsOf(sam)).map((view) => view.id)).not.toContain(created.body.id);
      expect(
        (await call('PATCH', `${brandPath()}/views/${created.body.id}`, sam, { name: 'x' })).status,
      ).toBe(404);
    });

    it('reorders the shared list, audited', async () => {
      const before = (await viewsOf(ada)).filter((view) => view.visibility.kind !== 'personal');
      const [first, second] = before;

      const response = await call<TicketViewList>('POST', `${brandPath()}/views/reorder`, ada, {
        viewIds: [second?.id, first?.id],
      });

      expect(response.body.views.slice(0, 2).map((view) => view.id)).toEqual([
        second?.id,
        first?.id,
      ]);
      await call('POST', `${brandPath()}/views/reorder`, ada, { viewIds: [first?.id, second?.id] });
    });
  });

  describe('counts and the list', () => {
    let overdueId: string;

    beforeAll(async () => {
      await createTicket(support, sam.id);
      await createTicket(support);
      overdueId = await createTicket(support);
      await createTicket(billing);
      await createTicket(billing);
      await createTicket(billing);
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.update(tickets).set({ slaBreached: true }).where(eq(tickets.id, overdueId)),
      );
    });

    it('never widens access: an Agent counts only their own department', async () => {
      const counts = await countsOf(sam);

      expect(counts).toMatchObject({
        'My open': 1,
        Unassigned: 2,
        Overdue: 1,
        'All open · Support': 3,
      });
      expect(await countsOf(ada)).toMatchObject({ Unassigned: 5, 'All open · Billing': 3 });
    });

    it('evaluates `me` for the reader', async () => {
      expect((await countsOf(tess))['My open']).toBe(0);
    });

    it('lists by `assigneeId=me` and `overdue=true` like any other filter', async () => {
      const mine = await call<TicketList>('GET', `${brandPath()}/tickets?assigneeId=me`, sam);
      const overdue = await call<TicketList>('GET', `${brandPath()}/tickets?overdue=true`, ada);

      expect(mine.body.tickets.map((ticket) => ticket.assigneeId)).toEqual([sam.id]);
      expect(overdue.body.tickets.map((ticket) => ticket.id)).toEqual([overdueId]);
    });
  });
});
