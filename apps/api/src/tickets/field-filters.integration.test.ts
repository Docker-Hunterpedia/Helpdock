import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  customFieldDefs,
  type Db,
  type DbHandle,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type {
  CustomFieldDef,
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
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';

/**
 * M14-16 against a real Postgres, over real sessions: the ticket list's
 * custom-field filters, saved in a view, under the department policy and the
 * fields' visibility.
 *
 * 1. **Each operator finds what it should** in the jsonb column, including the
 *    stored shapes the unit suite can only assume (a multi-select's array, a
 *    cleared field's absent key, a checkbox never touched).
 * 2. **A filter only narrows.** An Agent of Support filtering by a value
 *    counts and lists Support's tickets, never Billing's.
 * 3. **A field hidden from Agents is not a filter for them**, and a key that is
 *    not a field fails with a 400 rather than matching nothing.
 * 4. **A view keeps the filters** and counts with them, and refuses the ones
 *    that do not fit the brand's fields when it is saved.
 * 5. **One pinned field per brand**, a select that Agents may see.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M14-16 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('custom-field filters', () => {
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

  const createTicket = async (
    departmentId: string,
    custom: Record<string, unknown> = {},
  ): Promise<string> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, ada, {
      subject: 'Checkout fails',
      bodyHtml: '<p>It fails.</p>',
      departmentId,
      custom,
    });
    expect(response.status).toBe(201);

    return response.body.ticket.id;
  };

  const addField = async (request: Record<string, unknown>): Promise<CustomFieldDef> => {
    const response = await call<CustomFieldDef>('POST', `${brandPath()}/custom-fields`, ada, {
      target: 'ticket',
      ...request,
    });
    expect(response.status).toBe(201);

    return response.body;
  };

  const listBy = async (who: Person, ...filters: unknown[]): Promise<string[]> => {
    const query = filters.map(
      (filter) => `fieldFilter=${encodeURIComponent(JSON.stringify(filter))}`,
    );
    const response = await call<TicketList>(
      'GET',
      `${brandPath()}/tickets?limit=100&${query.join('&')}`,
      who,
    );
    expect(response.status).toBe(200);

    return response.body.tickets.map((ticket) => ticket.id);
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

  let severity: CustomFieldDef;
  let hidden: CustomFieldDef;
  /** Support's tickets, in the order they were filed. */
  let sev1: string;
  let sev2: string;
  let bare: string;
  /** A Sev 1 ticket in Billing, which a Support agent must never see. */
  let billingSev1: string;

  beforeAll(async () => {
    severity = await addField({
      key: 'severity',
      label: 'Severity',
      type: 'select',
      options: ['Sev 1', 'Sev 2', 'Sev 3'],
    });
    await addField({
      key: 'regions',
      label: 'Regions',
      type: 'multi_select',
      options: ['EU', 'US', 'MEA'],
    });
    await addField({ key: 'vip', label: 'VIP', type: 'checkbox' });
    await addField({ key: 'total', label: 'Order total', type: 'number' });
    await addField({ key: 'renewal', label: 'Renewal', type: 'date' });
    await addField({ key: 'note', label: 'Note', type: 'text' });
    hidden = await addField({
      key: 'score',
      label: 'Internal score',
      type: 'number',
      agentVisible: false,
    });

    sev1 = await createTicket(support, {
      severity: 'Sev 1',
      regions: ['EU'],
      vip: true,
      total: 120,
      renewal: '2026-03-01',
      note: 'Stripe webhook, 50% off code',
      score: 9,
    });
    sev2 = await createTicket(support, {
      severity: 'Sev 2',
      regions: ['US', 'EU'],
      vip: false,
      total: 80,
      renewal: '2026-06-01',
      note: 'Refund please',
    });
    bare = await createTicket(support);
    billingSev1 = await createTicket(billing, { severity: 'Sev 1', note: 'Invoice' });
  }, 120_000);

  describe('each operator', () => {
    it('finds a select by any of its options, and only inside the reader’s departments', async () => {
      const filter = { key: 'severity', op: 'any_of', values: ['Sev 1'] };

      expect(new Set(await listBy(ada, filter))).toEqual(new Set([sev1, billingSev1]));
      expect(await listBy(sam, filter)).toEqual([sev1]);
      expect(await listBy(bo, filter)).toEqual([billingSev1]);
      expect(
        new Set(await listBy(sam, { key: 'severity', op: 'any_of', values: ['Sev 1', 'Sev 2'] })),
      ).toEqual(new Set([sev1, sev2]));
    });

    it('finds a multi-select by any member of its stored array', async () => {
      expect(new Set(await listBy(sam, { key: 'regions', op: 'any_of', values: ['EU'] }))).toEqual(
        new Set([sev1, sev2]),
      );
      expect(await listBy(sam, { key: 'regions', op: 'any_of', values: ['US'] })).toEqual([sev2]);
      expect(await listBy(sam, { key: 'regions', op: 'any_of', values: ['MEA'] })).toEqual([]);
    });

    it('finds the tickets with no value, which is how a cleared field is stored', async () => {
      expect(await listBy(sam, { key: 'severity', op: 'not_set' })).toEqual([bare]);
      expect(await listBy(sam, { key: 'total', op: 'not_set' })).toEqual([bare]);
    });

    it('reads a checkbox that was never touched as unticked', async () => {
      expect(await listBy(sam, { key: 'vip', op: 'is', value: true })).toEqual([sev1]);
      expect(new Set(await listBy(sam, { key: 'vip', op: 'is', value: false }))).toEqual(
        new Set([sev2, bare]),
      );
    });

    it('compares numbers as numbers, and leaves out a ticket with none', async () => {
      expect(await listBy(sam, { key: 'total', op: 'before', value: 100 })).toEqual([sev2]);
      expect(await listBy(sam, { key: 'total', op: 'after', value: 100 })).toEqual([sev1]);
      expect(
        new Set(await listBy(sam, { key: 'total', op: 'between', from: 80, to: 120 })),
      ).toEqual(new Set([sev1, sev2]));
      // 9 < 80 as a number, but "9" > "80" as text: the comparison is numeric.
      expect(await listBy(sam, { key: 'total', op: 'before', value: 9.5 })).toEqual([]);
    });

    it('compares days', async () => {
      expect(await listBy(sam, { key: 'renewal', op: 'before', value: '2026-04-01' })).toEqual([
        sev1,
      ]);
      expect(await listBy(sam, { key: 'renewal', op: 'after', value: '2026-04-01' })).toEqual([
        sev2,
      ]);
      expect(
        new Set(
          await listBy(sam, {
            key: 'renewal',
            op: 'between',
            from: '2026-03-01',
            to: '2026-06-01',
          }),
        ),
      ).toEqual(new Set([sev1, sev2]));
    });

    it('finds text by substring, ignoring case, with % and _ meaning themselves', async () => {
      expect(await listBy(sam, { key: 'note', op: 'contains', value: 'STRIPE' })).toEqual([sev1]);
      expect(await listBy(sam, { key: 'note', op: 'contains', value: '50% off' })).toEqual([sev1]);
      expect(await listBy(sam, { key: 'note', op: 'contains', value: '5_%' })).toEqual([]);
      expect(await listBy(sam, { key: 'note', op: 'contains', value: '%' })).toEqual([sev1]);
    });

    it('needs every filter to match', async () => {
      const sev = { key: 'severity', op: 'any_of', values: ['Sev 1'] };

      expect(await listBy(sam, sev, { key: 'vip', op: 'is', value: true })).toEqual([sev1]);
      expect(await listBy(sam, sev, { key: 'vip', op: 'is', value: false })).toEqual([]);
    });

    it('treats a value that looks like SQL or JSON as text', async () => {
      const hostile = `Sev 1"}' OR true --`;

      expect(await listBy(ada, { key: 'severity', op: 'any_of', values: [hostile] })).toEqual([]);
    });
  });

  describe('what is refused', () => {
    const refused = async (who: Person, ...filters: unknown[]): Promise<number> => {
      const query = filters.map(
        (filter) => `fieldFilter=${encodeURIComponent(JSON.stringify(filter))}`,
      );
      return (await call('GET', `${brandPath()}/tickets?${query.join('&')}`, who)).status;
    };

    it('answers 400 to a key that is not a ticket field, instead of matching nothing', async () => {
      expect(await refused(ada, { key: 'severty', op: 'not_set' })).toBe(400);
    });

    it('answers 400 to an operator the type has no use for', async () => {
      expect(await refused(ada, { key: 'severity', op: 'contains', value: 'x' })).toBe(400);
      expect(await refused(ada, { key: 'total', op: 'after', value: '2026-01-01' })).toBe(400);
    });

    it('answers 400 to a filter that is not an object the schema knows', async () => {
      const response = await call(
        'GET',
        `${brandPath()}/tickets?fieldFilter=${encodeURIComponent('not json')}`,
        ada,
      );

      expect(response.status).toBe(400);
      expect(await refused(ada, { key: 'Severity', op: 'not_set' })).toBe(400);
      expect(await refused(ada, { key: 'total', op: 'between', from: 5, to: 1 })).toBe(400);
    });

    it('keeps a field hidden from Agents to the people who can see it', async () => {
      const filter = { key: 'score', op: 'after', value: 5 };

      expect(await refused(sam, filter)).toBe(400);
      expect(await listBy(ada, filter)).toEqual([sev1]);
      // A Team Leader sees hidden fields, inside the departments they lead.
      expect(await listBy(tess, filter)).toEqual([sev1]);
    });
  });

  describe('a saved view', () => {
    const filters = {
      fieldFilter: [
        { key: 'severity', op: 'any_of', values: ['Sev 1'] },
        { key: 'vip', op: 'is', value: true },
      ],
      systemState: ['open'],
    };

    it('keeps the filters, counts with them and lists with them', async () => {
      const created = await call<TicketView>('POST', `${brandPath()}/views`, sam, {
        name: 'Sev 1 VIP',
        filters,
      });
      expect(created.status).toBe(201);
      expect(created.body.filters.fieldFilter).toEqual(filters.fieldFilter);

      const stored = (await viewsOf(sam)).find((view) => view.id === created.body.id);
      expect(stored?.filters.fieldFilter).toEqual(filters.fieldFilter);
      expect((await countsOf(sam))['Sev 1 VIP']).toBe(1);
      // The same view's tickets for a colleague of Billing would be Billing's alone.
      const listed = await call<TicketList>(
        'GET',
        `${brandPath()}/tickets?${filters.fieldFilter
          .map((filter) => `fieldFilter=${encodeURIComponent(JSON.stringify(filter))}`)
          .join('&')}`,
        sam,
      );
      expect(listed.body.tickets.map((ticket) => ticket.id)).toEqual([sev1]);

      const changed = await call<TicketView>(
        'PATCH',
        `${brandPath()}/views/${created.body.id}`,
        sam,
        { filters: { fieldFilter: [{ key: 'severity', op: 'not_set' }] } },
      );
      expect(changed.body.filters.fieldFilter).toEqual([{ key: 'severity', op: 'not_set' }]);
      expect((await countsOf(sam))['Sev 1 VIP']).toBe(1);

      expect((await call('DELETE', `${brandPath()}/views/${created.body.id}`, sam)).status).toBe(
        204,
      );
    });

    it('refuses filters that do not fit the brand’s fields when it is saved', async () => {
      const typo = await call('POST', `${brandPath()}/views`, sam, {
        name: 'Typo',
        filters: { fieldFilter: [{ key: 'severty', op: 'not_set' }] },
      });
      const wrongKind = await call('POST', `${brandPath()}/views`, sam, {
        name: 'Wrong kind',
        filters: { fieldFilter: [{ key: 'vip', op: 'any_of', values: ['yes'] }] },
      });

      expect([typo.status, wrongKind.status]).toEqual([400, 400]);
      expect((await viewsOf(sam)).map((view) => view.name)).not.toContain('Typo');
    });

    it('is checked as an Agent would read it when it is shared', async () => {
      const onHidden = { fieldFilter: [{ key: 'score', op: 'after', value: 5 }] };
      const personal = await call<TicketView>('POST', `${brandPath()}/views`, ada, {
        name: 'Scored',
        filters: onHidden,
      });
      const shared = await call('POST', `${brandPath()}/views`, ada, {
        name: 'Scored for all',
        filters: onHidden,
        visibility: { kind: 'brand' },
      });

      expect(personal.status).toBe(201);
      expect(shared.status).toBe(400);
      expect((await countsOf(ada)).Scored).toBe(1);
      await call('DELETE', `${brandPath()}/views/${personal.body.id}`, ada);
    });

    it('counts nothing, rather than failing the sidebar, once its field is gone', async () => {
      const gone = await addField({ key: 'gone', label: 'Gone', type: 'text' });
      const created = await call<TicketView>('POST', `${brandPath()}/views`, ada, {
        name: 'On a field that goes',
        filters: { fieldFilter: [{ key: 'gone', op: 'not_set' }] },
      });
      expect((await countsOf(ada))['On a field that goes']).toBe(4);

      await call('DELETE', `${brandPath()}/custom-fields/${gone.id}`, ada);

      const counts = await call<TicketViewCountList>('GET', `${brandPath()}/views/counts`, ada);
      expect(counts.status).toBe(200);
      expect((await countsOf(ada))['On a field that goes']).toBe(0);
      expect(
        (
          await call(
            'GET',
            `${brandPath()}/tickets?fieldFilter=${encodeURIComponent(JSON.stringify({ key: 'gone', op: 'not_set' }))}`,
            ada,
          )
        ).status,
      ).toBe(400);
      await call('DELETE', `${brandPath()}/views/${created.body.id}`, ada);
    });
  });

  describe('the pinned field', () => {
    const fieldsOf = async (): Promise<CustomFieldDef[]> =>
      (await call<{ fields: CustomFieldDef[] }>('GET', `${brandPath()}/custom-fields`, ada)).body
        .fields;
    const pin = (field: CustomFieldDef, pinned: boolean, who = ada) =>
      call<CustomFieldDef>('PATCH', `${brandPath()}/custom-fields/${field.id}`, who, { pinned });

    it('is one select field per brand: pinning another lets the first go', async () => {
      const plan = await addField({ key: 'plan', label: 'Plan', type: 'select', options: ['Pro'] });

      expect((await pin(severity, true)).body.pinned).toBe(true);
      expect((await pin(plan, true)).body.pinned).toBe(true);

      const pinned = (await fieldsOf()).filter((field) => field.pinned).map((field) => field.key);
      expect(pinned).toEqual(['plan']);

      expect((await pin(plan, false)).body.pinned).toBe(false);
      await pin(severity, true);
    });

    it('is refused for a field that is not a select, or that Agents cannot see', async () => {
      const note = (await fieldsOf()).find((field) => field.key === 'note') as CustomFieldDef;

      expect((await pin(note, true)).status).toBe(400);
      expect((await pin(hidden, true)).status).toBe(400);
      expect((await pin(severity, true)).status).toBe(200);
    });

    it('cannot be hidden from Agents or retyped while pinned', async () => {
      // `plan` carries no values, so only the pin rule can refuse the retyping.
      const plan = (await fieldsOf()).find((field) => field.key === 'plan') as CustomFieldDef;
      const path = `${brandPath()}/custom-fields/${plan.id}`;
      await pin(plan, true);

      expect((await call('PATCH', path, ada, { agentVisible: false })).status).toBe(400);
      expect((await call('PATCH', path, ada, { type: 'text', options: [] })).status).toBe(400);
      expect((await call('PATCH', path, ada, { agentVisible: false, pinned: false })).status).toBe(
        200,
      );
      await call('PATCH', path, ada, { agentVisible: true });
      await pin(severity, true);
    });

    it('can be asked for when a field is created, and the first one is let go', async () => {
      const queue = await addField({
        key: 'queue',
        label: 'Queue',
        type: 'select',
        options: ['Tier 1'],
        pinned: true,
      });

      expect(queue.pinned).toBe(true);
      expect((await fieldsOf()).filter((field) => field.pinned).map((field) => field.key)).toEqual([
        'queue',
      ]);
      expect(
        (
          await call('POST', `${brandPath()}/custom-fields`, ada, {
            target: 'ticket',
            key: 'bad_pin',
            label: 'Bad pin',
            type: 'text',
            pinned: true,
          })
        ).status,
      ).toBe(400);
      await pin(severity, true);
    });

    it('is held to one by the database as well as by the service', async () => {
      const second = (await fieldsOf()).find((field) => field.key === 'plan') as CustomFieldDef;

      await expect(
        withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.update(customFieldDefs).set({ pinned: true }).where(eq(customFieldDefs.id, second.id)),
        ),
      ).rejects.toThrow();
    });
  });
});
