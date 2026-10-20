import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  brands,
  createDb,
  type Db,
  type DbHandle,
  departments,
  seedBrandStatuses,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type { QuickSearch, Ticket, TicketDetail } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';

/**
 * M14-05's quick search against a real Postgres and Redis, over real sessions:
 * the palette finds what the person's own screens would show and nothing
 * else. Department scope and brand isolation are the database's; the sections
 * answer per permission; the rate limit is real.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M14-05 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('quick search', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  let ada: Person;
  let sam: Person;
  let bo: Person;
  let vera: Person;
  /** For the rate-limit test, so the others' budgets stay untouched. */
  let rita: Person;
  let ola: Person;
  let otherBrand: string;
  let supportTicket: Ticket;
  let billingTicket: Ticket;
  let otherBrandTicket: string;

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
    method: 'GET' | 'POST',
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

  const brandPath = (brandId: string) => `/api/brands/${brandId}`;
  const find = (who: Person, q: string, brandId = seeded.brandId) =>
    call<QuickSearch>(
      'GET',
      `${brandPath(brandId)}/quick-search?q=${encodeURIComponent(q)}&limit=5`,
      who,
    );

  const addPerson = async (db: Db, name: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
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
      passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
    });
    return { id, email, token: '' };
  };

  const createTicket = async (
    who: Person,
    brandId: string,
    body: Record<string, unknown>,
  ): Promise<Ticket> => {
    const response = await call<TicketDetail>('POST', `${brandPath(brandId)}/tickets`, who, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body.ticket;
  };

  const createContact = async (who: Person, name: string, email: string): Promise<string> => {
    const response = await call<{ id: string }>(
      'POST',
      `${brandPath(seeded.brandId)}/contacts`,
      who,
      { name, identities: [{ kind: 'email', value: email }] },
    );
    expect(response.status).toBe(201);
    return response.body.id;
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

    const db = runtime.db;
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    [sam, bo, vera, rita, ola] = await Promise.all(
      ['sam', 'bo', 'vera', 'rita', 'ola'].map((name) => addPerson(db, name)),
    ) as [Person, Person, Person, Person, Person];

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
        { userId: vera.id, brandId: seeded.brandId, role: 'viewer', departmentIds: null },
        { userId: rita.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
      ]);
    });
    await withSystem(db, otherBrand, async (tx) => {
      await seedBrandStatuses(tx, otherBrand);
      const [created] = await tx
        .insert(departments)
        .values({ brandId: otherBrand, name: 'General' })
        .returning({ id: departments.id });
      await tx
        .insert(userBrandRoles)
        .values({ userId: ola.id, brandId: otherBrand, role: 'admin', departmentIds: null });
      otherBrandTicket = created?.id ?? '';
    });

    ada.token = await signInForTest(app, { email: seeded.email, password: seeded.password });
    for (const person of [sam, bo, vera, rita, ola]) {
      person.token = await signInForTest(app, { email: person.email, password: PASSWORD });
    }

    const zelda = await createContact(ada, 'Zelda Quill', 'zelda@example.com');
    supportTicket = await createTicket(ada, seeded.brandId, {
      subject: 'Parcel never arrived',
      departmentId: support,
    });
    billingTicket = await createTicket(ada, seeded.brandId, {
      subject: 'Invoice mismatch for Zelda',
      departmentId: billing,
      contactId: zelda,
    });
    const otherTicket = await createTicket(ola, otherBrand, {
      subject: 'Parcel never arrived at Globex',
      departmentId: otherBrandTicket,
    });
    otherBrandTicket = otherTicket.id;

    // A draft article, created through the api as an editor would.
    const category = await call<{ id: string }>(
      'POST',
      `${brandPath(seeded.brandId)}/help-center/categories`,
      ada,
      { names: { en: 'Orders', ar: 'الطلبات' } },
    );
    const section = await call<{ id: string }>(
      'POST',
      `${brandPath(seeded.brandId)}/help-center/sections`,
      ada,
      { categoryId: category.body.id, names: { en: 'Refunds', ar: 'الاسترداد' } },
    );
    const article = await call(
      'POST',
      `${brandPath(seeded.brandId)}/help-center/articles`,
      ada,
      { sectionId: section.body.id, locale: 'en', title: 'Refund policy draft' },
    );
    expect(article.status).toBe(201);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  it('finds a ticket by its reference first and by its number', async () => {
    const byReference = await find(sam, `${supportTicket.prefix}-${supportTicket.number}`);
    const byNumber = await find(sam, String(supportTicket.number));

    expect(byReference.status).toBe(200);
    for (const found of [byReference.body, byNumber.body]) {
      expect(found.tickets).toMatchObject({ status: 'ok' });
      expect(found.tickets.status === 'ok' && found.tickets.items[0]).toEqual({
        id: supportTicket.id,
        number: supportTicket.number,
        prefix: supportTicket.prefix,
        subject: 'Parcel never arrived',
      });
    }
  });

  it('never offers a ticket in a department the person cannot reach, not by number and not by its contact', async () => {
    const samByNumber = await find(sam, String(billingTicket.number));
    const samByContact = await find(sam, 'Zelda');
    const boByContact = await find(bo, 'Zelda');

    expect(samByNumber.body.tickets).toEqual({ status: 'ok', items: [] });
    expect(samByContact.body.tickets).toEqual({ status: 'ok', items: [] });
    expect(boByContact.body.tickets).toMatchObject({
      status: 'ok',
      items: [{ id: billingTicket.id }],
    });
  });

  it('finds contacts through the contacts search', async () => {
    const { body } = await find(sam, 'zelda@example.com');

    expect(body.contacts).toMatchObject({
      status: 'ok',
      items: [{ name: 'Zelda Quill', identity: 'zelda@example.com' }],
    });
  });

  it('keeps another brand out of the answer and refuses a brand the person does not work in', async () => {
    const own = await find(ada, 'Globex');
    const refused = await find(sam, 'Parcel', otherBrand);

    expect(own.body.tickets).toEqual({ status: 'ok', items: [] });
    expect([401, 403, 404]).toContain(refused.status);
    expect(JSON.stringify(own.body)).not.toContain(otherBrandTicket);
  });

  it('lists a draft title only for who manages the help center', async () => {
    const admin = await find(ada, 'Refund policy');
    const agent = await find(rita, 'Refund policy');

    expect(admin.body.articles).toMatchObject({
      status: 'ok',
      items: [{ title: 'Refund policy draft', status: 'draft' }],
    });
    expect(agent.body.articles).toEqual({ status: 'ok', items: [] });
  });

  it('answers a viewer, who reads but cannot manage', async () => {
    const { status, body } = await find(vera, String(supportTicket.number));

    expect(status).toBe(200);
    expect(body.tickets).toMatchObject({ status: 'ok' });
    expect(body.contacts).toMatchObject({ status: 'ok' });
  });

  it('refuses an empty or over-long query and an out-of-range limit', async () => {
    const empty = await find(bo, ' ');
    const long = await find(bo, 'x'.repeat(201));
    const limit = await call(
      'GET',
      `${brandPath(seeded.brandId)}/quick-search?q=a&limit=50`,
      bo,
    );

    expect([empty.status, long.status, limit.status]).toEqual([400, 400, 400]);
  });

  it('refuses a caller with no session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${brandPath(seeded.brandId)}/quick-search?q=a`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers 429 to the eleventh search in a second, for that person alone', async () => {
    const burst = await Promise.all(Array.from({ length: 14 }, () => find(rita, 'Parcel')));
    const statuses = burst.map(({ status }) => status);

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(10);
    expect((await find(bo, 'Parcel')).status).toBe(200);
  });
});
