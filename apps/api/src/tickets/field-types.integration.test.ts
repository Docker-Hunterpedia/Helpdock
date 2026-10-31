import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  type Db,
  type DbHandle,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type {
  CustomFieldDef,
  CustomFieldPeople,
  DepartmentSummary,
  Ticket,
  TicketDetail,
  TicketList,
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
 * M14-27 against a real Postgres, over real sessions: the long text, link,
 * email and person field types.
 *
 * 1. **Each type stores its normal form** on a ticket, a contact and an account.
 * 2. **Each refuses what it should**: a link that is not `https`, an address
 *    that is not one, a long text over its limit, and a person who is not staff
 *    of this brand (a user with no role here, or somebody whose role was removed).
 * 3. **The list filters answer the new types**, with the operators the type
 *    has and a 400 for the rest.
 * 4. **The people read** offers the brand's staff by name and nobody else.
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
    'Skipping the M14-27 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('custom field types (M14-27)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  /** An Agent of Support. */
  let sam: Person;
  /** The install admin, whose department scope is `all`. */
  let ada: Person;
  /** A user with no role in this brand. */
  let outsider: Person;
  /** Staff whose role the last test removes. */
  let leaver: Person;

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

    sam = await addPerson(runtime.db, 'sam');
    outsider = await addPerson(runtime.db, 'outsider');
    leaver = await addPerson(runtime.db, 'leaver');
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: leaver.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
      ]),
    );
    sam.token = await signIn(sam.email, STAFF_PASSWORD);

    for (const request of [
      { key: 'notes', label: 'Notes', type: 'long_text' },
      { key: 'status_page', label: 'Status page', type: 'link' },
      { key: 'billing_email', label: 'Billing email', type: 'email' },
      { key: 'owner', label: 'Owner', type: 'person' },
    ]) {
      for (const target of ['ticket', 'contact', 'account']) {
        await addField({ ...request, target });
      }
    }
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  const patchTicket = (ticketId: string, custom: Record<string, unknown>) =>
    call<Ticket>('PATCH', `${brandPath()}/tickets/${ticketId}`, ada, { custom });

  const newContact = async (): Promise<string> => {
    const response = await call<{ id: string }>('POST', `${brandPath()}/contacts`, ada, {
      name: 'Dana',
      identities: [{ kind: 'email', value: `dana-${uuidv7()}@example.com` }],
    });
    expect(response.status).toBe(201);

    return response.body.id;
  };

  describe('storing', () => {
    it('keeps the normal form of each type on a ticket', async () => {
      const id = await createTicket(support, {
        notes: '  three shops, Jeddah and Dubai  ',
        status_page: ' https://status.stripe.com/incidents/42 ',
        billing_email: ' Finance@Globex.COM ',
        owner: sam.id,
      });

      const detail = await call<TicketDetail>('GET', `${brandPath()}/tickets/${id}`, ada);

      expect(detail.body.ticket.custom).toEqual({
        notes: 'three shops, Jeddah and Dubai',
        status_page: 'https://status.stripe.com/incidents/42',
        billing_email: 'finance@globex.com',
        owner: sam.id,
      });
    });

    it('does the same on a contact and an account', async () => {
      const custom = {
        status_page: 'https://example.com/a',
        billing_email: 'Ops@Example.com',
        owner: sam.id,
      };

      const contact = await call<{ custom: Record<string, unknown> }>(
        'PATCH',
        `${brandPath()}/contacts/${await newContact()}`,
        ada,
        { custom },
      );
      expect(contact.status).toBe(200);
      expect(contact.body.custom).toEqual({ ...custom, billing_email: 'ops@example.com' });

      const account = await call<{ id: string }>('POST', `${brandPath()}/accounts`, ada, {
        name: 'Globex',
      });
      const patched = await call<{ custom: Record<string, unknown> }>(
        'PATCH',
        `${brandPath()}/accounts/${account.body.id}`,
        ada,
        { custom: { notes: 'Strategic', owner: sam.id } },
      );
      expect(patched.status).toBe(200);
      expect(patched.body.custom).toEqual({ notes: 'Strategic', owner: sam.id });
    });
  });

  describe('refusing', () => {
    it.each([
      ['an http link', { status_page: 'http://example.com' }],
      ['a javascript link', { status_page: 'javascript:alert(1)' }],
      ['a data link', { status_page: 'data:text/html,hi' }],
      ['a link with credentials', { status_page: 'https://user:pass@example.com' }],
      ['an address that is not one', { billing_email: 'not-an-address' }],
      ['a long text over 5,000 characters', { notes: 'x'.repeat(5001) }],
      ['a person that is not an id', { owner: 'Sam' }],
    ])('answers 400 for %s on a ticket', async (_name, custom) => {
      const id = await createTicket(support);

      expect((await patchTicket(id, custom)).status).toBe(400);
    });

    it('accepts a long text of 5,000 characters', async () => {
      const id = await createTicket(support);

      expect((await patchTicket(id, { notes: 'x'.repeat(5000) })).status).toBe(200);
    });

    it('refuses a person with no role in this brand', async () => {
      const id = await createTicket(support);

      const response = await patchTicket(id, { owner: outsider.id });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('not staff of this brand');
    });

    it('refuses a person on a contact too', async () => {
      const response = await call('PATCH', `${brandPath()}/contacts/${await newContact()}`, ada, {
        custom: { owner: outsider.id },
      });

      expect(response.status).toBe(400);
    });

    it('lets null clear a value', async () => {
      const id = await createTicket(support, { owner: sam.id });

      const cleared = await patchTicket(id, { owner: null });

      expect(cleared.status).toBe(200);
      expect(cleared.body.custom).toEqual({});
    });
  });

  describe('filters', () => {
    let withAll: string;
    let other: string;
    let none: string;

    beforeAll(async () => {
      withAll = await createTicket(support, {
        notes: 'Needs Stripe webhook help',
        status_page: 'https://status.stripe.com/incidents/42',
        billing_email: 'finance@globex.com',
        owner: sam.id,
      });
      other = await createTicket(support, {
        notes: 'Refund',
        status_page: 'https://example.org/x',
        billing_email: 'ops@initech.io',
      });
      none = await createTicket(support);
    });

    it.each([
      ['notes', 'stripe', 'withAll'],
      ['status_page', 'status.stripe', 'withAll'],
      ['billing_email', 'INITECH', 'other'],
    ])('finds %s by what it contains', async (key, value, which) => {
      const found = await listBy(ada, { key, op: 'contains', value });

      expect(found.filter((id) => [withAll, other, none].includes(id))).toEqual([
        which === 'withAll' ? withAll : other,
      ]);
    });

    it('finds a person by id, and not set finds the tickets without one', async () => {
      const chosen = await listBy(ada, { key: 'owner', op: 'any_of', values: [sam.id] });
      expect(chosen).toContain(withAll);
      expect(chosen).not.toContain(other);

      const unset = await listBy(ada, { key: 'owner', op: 'not_set' });
      expect(unset).toContain(other);
      expect(unset).not.toContain(withAll);
    });

    it.each([
      { key: 'owner', op: 'contains', value: 'x' },
      { key: 'notes', op: 'any_of', values: ['x'] },
      { key: 'billing_email', op: 'between', from: 1, to: 2 },
      { key: 'status_page', op: 'is', value: true },
    ])('answers 400 for an operator the type has no use for: %o', async (filter) => {
      const response = await call(
        'GET',
        `${brandPath()}/tickets?fieldFilter=${encodeURIComponent(JSON.stringify(filter))}`,
        ada,
      );

      expect(response.status).toBe(400);
    });
  });

  describe('the web form', () => {
    it('lists the other three types and never a person field, which a visitor cannot choose', async () => {
      const response = await call<{ fields: { field: string; type: string }[] }>(
        'GET',
        `${brandPath()}/web-form`,
        ada,
      );

      expect(response.status).toBe(200);
      const custom = response.body.fields.filter((field) => field.field.startsWith('custom:'));
      expect(custom.map((field) => field.type)).toEqual(
        expect.arrayContaining(['long_text', 'link', 'email']),
      );
      expect(custom.map((field) => field.type)).not.toContain('person');
    });
  });

  describe('the people read', () => {
    it('offers the staff of the brand by name, to an Agent too, and nothing else about them', async () => {
      const response = await call<CustomFieldPeople>(
        'GET',
        `${brandPath()}/custom-fields/people`,
        sam,
      );

      expect(response.status).toBe(200);
      const ids = response.body.people.map((person) => person.userId);
      expect(ids).toEqual(expect.arrayContaining([sam.id, ada.id, leaver.id]));
      expect(ids).not.toContain(outsider.id);
      expect(Object.keys(response.body.people[0] ?? {}).sort()).toEqual(['name', 'userId']);
    });

    it('drops somebody whose role was removed, keeps their stored id, and refuses new writes naming them', async () => {
      const id = await createTicket(support, { owner: leaver.id });
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.delete(userBrandRoles).where(eq(userBrandRoles.userId, leaver.id)),
      );

      const people = await call<CustomFieldPeople>(
        'GET',
        `${brandPath()}/custom-fields/people`,
        ada,
      );
      expect(people.body.people.map((person) => person.userId)).not.toContain(leaver.id);

      const detail = await call<TicketDetail>('GET', `${brandPath()}/tickets/${id}`, ada);
      expect(detail.body.ticket.custom).toEqual({ owner: leaver.id });
      expect((await patchTicket(id, { owner: leaver.id })).status).toBe(400);
    });
  });
});
