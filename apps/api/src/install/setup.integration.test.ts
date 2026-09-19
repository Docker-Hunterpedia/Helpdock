import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Env } from '@helpdock/config';
import {
  auditLog,
  brandDomains,
  brands,
  createDb,
  type DbHandle,
  departments,
  INSTALL_SCOPE_BRAND_ID,
  userBrandRoles,
  users,
  uuidv7,
  withTenant,
} from '@helpdock/db';
import { SETUP_TOKEN_HEADER } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { INSTALL_STATE_META } from '../static/install-meta.js';
import { silentLogger } from '../testing/silent-logger.js';

/**
 * The whole of M0-08 over HTTP, against a real Postgres, a real Redis and a
 * real SMTP server: the advisory lock two browsers race on, the row-level
 * security every write runs under, the settings the third step encrypts, and
 * Nodemailer actually delivering a message to Mailpit.
 *
 * The unit suites prove each piece decides correctly. This proves the pieces
 * are wired to each other, and it is the only place the wizard's SMTP transport
 * speaks to a server.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
/** ARCHITECTURE §15 names Mailpit as the SMTP double; `testcontainers` has no module for it. */
const MAILPIT_IMAGE = 'axllent/mailpit';
const MAILPIT_SMTP_PORT = 1025;
const MAILPIT_HTTP_PORT = 8025;

const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 13).toString('base64');
const APP_URL = 'https://support.example.com';

const ADMIN = {
  name: 'Lina Haddad',
  email: 'lina@example.com',
  password: 'a very long setup passphrase',
  locale: 'en',
} as const;

const BRAND = {
  name: 'Acme Support',
  prefix: 'ACME',
  defaultLocale: 'en',
  timezone: 'Europe/Berlin',
  helpcenterDomain: 'support.acme.test',
} as const;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the first-run wizard integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

/**
 * A stand-in for `apps/admin/dist`, written here rather than built, so the
 * suite proves what the api does with a build and never depends on one.
 */
const adminDist = mkdtempSync(path.join(tmpdir(), 'helpdock-setup-admin-'));
mkdirSync(adminDist, { recursive: true });
writeFileSync(
  path.join(adminDist, 'index.html'),
  '<!doctype html><html><head>' +
    '<meta name="helpdock:primary-domain" content="dev.example" />' +
    '<meta name="helpdock:brand-count" content="3" />' +
    `<meta name="${INSTALL_STATE_META}" content="configured" />` +
    '<meta name="helpdock:version" content="0.0.0" />' +
    '</head><body><div id="root"></div></body></html>',
  'utf8',
);

describe.skipIf(!hasDocker)('the first-run wizard', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let mailpit: StartedTestContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let mailpitApi: string;
  let smtp: { host: string; port: number };

  const envFor = (): Env =>
    ({
      APP_URL,
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
      ADMIN_DIST_DIR: adminDist,
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const post = (
    path: string,
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { [SETUP_TOKEN_HEADER]: token }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  /** Back to a fresh install, so a test that needs one is not the first one only. */
  const reset = async (): Promise<void> => {
    await owner.db.execute(
      sql`TRUNCATE ${users}, ${brands}, ${userBrandRoles}, ${brandDomains}, ${departments}, ${auditLog} CASCADE`,
    );
    await owner.db.execute(sql`DELETE FROM settings WHERE key LIKE 'smtp.%'`);
    await runtime.redis.flushdb();
  };

  const credentials = (overrides: Record<string, unknown> = {}) => ({
    host: smtp.host,
    port: smtp.port,
    tls: 'none',
    user: '',
    password: '',
    fromAddress: 'support@acme.test',
    fromName: 'Acme Support',
    ...overrides,
  });

  const mailpitMessages = async (): Promise<{ To: { Address: string }[]; Subject: string }[]> => {
    const response = await fetch(`${mailpitApi}/api/v1/messages`);
    const body = (await response.json()) as {
      messages: { To: { Address: string }[]; Subject: string }[];
    };

    return body.messages;
  };

  beforeAll(async () => {
    [postgres, redisContainer, mailpit] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase('helpdock').start(),
      new RedisContainer(REDIS_IMAGE).start(),
      new GenericContainer(MAILPIT_IMAGE)
        .withExposedPorts(MAILPIT_SMTP_PORT, MAILPIT_HTTP_PORT)
        .start(),
    ]);

    mailpitApi = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(MAILPIT_HTTP_PORT))}`;
    smtp = { host: mailpit.getHost(), port: mailpit.getMappedPort(MAILPIT_SMTP_PORT) };

    runtime = await createRuntime({
      env: envFor(),
      logger: silentLogger(),
    });
    // No `install` override: the wizard uses the real `SmtpEmailSender`, which
    // is the point of running a mail server in this suite at all.
    app = await createApiApp({ runtime });

    owner = createDb({
      url: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop(), mailpit?.stop()]);
  });

  beforeEach(async () => {
    await reset();
  });

  it('takes a fresh install through all four steps and then closes', async () => {
    const admin = await post('/api/install/setup/admin', ADMIN);
    expect(admin.statusCode).toBe(201);
    const { setupToken, admin: created } = admin.json() as {
      setupToken: string;
      admin: { id: string; email: string };
    };
    expect(created.email).toBe(ADMIN.email);
    // The token is what authorises the rest; nothing about it is a session.
    expect(admin.headers['set-cookie']).toBeUndefined();

    const brand = await post('/api/install/setup/brand', BRAND, setupToken);
    expect(brand.statusCode).toBe(201);
    expect(brand.json()).toMatchObject({
      brand: { name: BRAND.name, prefix: 'ACME', timezone: 'Europe/Berlin' },
      helpcenterDomain: 'support.acme.test',
      departmentCreated: true,
    });
    // The admin is signed in from here on: the brand exists, so a session has
    // somewhere to land.
    expect(String(brand.headers['set-cookie'])).toContain('hd_refresh=');

    const test = await post('/api/install/setup/smtp/test', credentials(), setupToken);
    expect(test.statusCode).toBe(201);
    expect(test.json()).toMatchObject({ delivered: true });
    expect(String((test.json() as { response: string }).response)).toMatch(/^2\d\d/);

    const delivered = await mailpitMessages();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.To[0]?.Address).toBe(ADMIN.email);

    const save = await post(
      '/api/install/setup/smtp',
      { ...credentials(), password: 'relay-secret', skip: false },
      setupToken,
    );
    expect(save.statusCode).toBe(201);
    expect(save.json()).toEqual({ configured: true });

    const done = await post('/api/install/setup/complete', undefined, setupToken);
    expect(done.statusCode).toBe(201);
    expect(done.json()).toEqual({ require2fa: false });

    // Every endpoint is closed from here on: the install is configured and the
    // token has been spent.
    for (const [route, body] of [
      ['/api/install/setup/admin', ADMIN],
      ['/api/install/setup/brand', BRAND],
      ['/api/install/setup/smtp', { skip: true }],
      ['/api/install/setup/smtp/test', credentials()],
      ['/api/install/setup/complete', undefined],
    ] as const) {
      const closed = await post(route, body, setupToken);
      expect(closed.statusCode, route).toBe(409);
      expect((closed.json() as { error: { code: string } }).error.code).toBe('conflict');
    }
  }, 120_000);

  it('stores the SMTP password encrypted and never answers with it', async () => {
    const { setupToken } = await createAdmin();
    await post('/api/install/setup/brand', BRAND, setupToken);

    const save = await post(
      '/api/install/setup/smtp',
      { ...credentials(), user: 'postmaster', password: 'relay-secret', skip: false },
      setupToken,
    );

    expect(save.body).not.toContain('relay-secret');
    await expect(runtime.settings.get('smtp.password')).resolves.toBe('relay-secret');

    const stored = await owner.db.execute(
      sql`SELECT value FROM settings WHERE key = 'smtp.password' AND brand_id = ${INSTALL_SCOPE_BRAND_ID}`,
    );
    const row = (stored as unknown as { value: string }[])[0];
    expect(row?.value).toMatch(/^v1\./);
    expect(row?.value).not.toContain('relay-secret');
  }, 120_000);

  it('reports a relay that is not listening as a connection failure, not a crash', async () => {
    const { setupToken } = await createAdmin();

    // Port 1 on loopback: nothing listens there, and the answer is immediate.
    const test = await post(
      '/api/install/setup/smtp/test',
      credentials({ host: '127.0.0.1', port: 1 }),
      setupToken,
    );

    expect(test.statusCode).toBe(201);
    expect(test.json()).toEqual({ delivered: false, error: 'connection-refused' });
  }, 120_000);

  it('records a skipped email step, so the System page can say it is not configured', async () => {
    const { setupToken } = await createAdmin();

    await expect(
      post('/api/install/setup/smtp', { skip: true }, setupToken),
    ).resolves.toMatchObject({ statusCode: 201 });

    await expect(runtime.settings.get('smtp.host')).resolves.toBe('');
    const rows = await owner.db.execute(
      sql`SELECT meta FROM audit_log WHERE action = 'install.setup.smtp'`,
    );
    expect((rows as unknown as { meta: { skipped: boolean } }[])[0]?.meta.skipped).toBe(true);
  }, 120_000);

  it('produces one admin when two browsers submit step 1 at the same instant', async () => {
    const [first, second] = await Promise.all([
      post('/api/install/setup/admin', ADMIN),
      post('/api/install/setup/admin', { ...ADMIN, email: 'mo@example.com' }),
    ]);

    // The advisory lock serialises them and the re-check inside the
    // transaction is what the second one loses on.
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);

    const rows = await owner.db.select({ id: users.id }).from(users);
    expect(rows).toHaveLength(1);
  }, 120_000);

  it('audits each step in install scope, with no credential in the trail', async () => {
    const { setupToken } = await createAdmin();
    await post('/api/install/setup/brand', BRAND, setupToken);
    await post(
      '/api/install/setup/smtp',
      { ...credentials(), user: 'postmaster', password: 'relay-secret', skip: false },
      setupToken,
    );

    const rows = await owner.db.select().from(auditLog).orderBy(auditLog.createdAt);

    expect(rows.map((row) => row.action)).toEqual([
      'install.setup.admin',
      'install.setup.brand',
      'install.setup.smtp',
    ]);
    for (const row of rows) {
      expect(row.brandId).toBe(INSTALL_SCOPE_BRAND_ID);
      expect(row.actorType).toBe('system');
      expect(row.actorId).toBe('install.setup');
    }
    expect(JSON.stringify(rows)).not.toContain('relay-secret');
    expect(JSON.stringify(rows)).not.toContain(ADMIN.password);
  }, 120_000);

  it('leaves the brand it created behind row-level security like any other', async () => {
    const { setupToken } = await createAdmin();
    const brand = await post('/api/install/setup/brand', BRAND, setupToken);
    const { brand: created } = brand.json() as { brand: { id: string } };

    const mine = await withTenant(
      runtime.db,
      {
        brandIds: [created.id],
        departmentIds: 'all',
        principalType: 'system',
        principalId: 'test',
      },
      (tx) => tx.select().from(userBrandRoles),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.role).toBe('admin');

    // A transaction scoped to some other brand sees nothing of it, which is the
    // negative case of DOMAIN-RULES §1.6 applied to what the wizard wrote.
    const theirs = await withTenant(
      runtime.db,
      {
        brandIds: [uuidv7()],
        departmentIds: 'all',
        principalType: 'system',
        principalId: 'test',
      },
      async (tx) => ({
        roles: await tx.select().from(userBrandRoles),
        domains: await tx.select().from(brandDomains),
        departments: await tx.select().from(departments),
        audit: await tx.select().from(auditLog),
      }),
    );
    expect(theirs).toEqual({ roles: [], domains: [], departments: [], audit: [] });
  }, 120_000);

  it('gives the brand a department to file tickets under', async () => {
    const { setupToken } = await createAdmin();
    const brand = await post('/api/install/setup/brand', BRAND, setupToken);
    const { brand: created } = brand.json() as { brand: { id: string } };

    const rows = await owner.db
      .select({ name: departments.name, brandId: departments.brandId })
      .from(departments);

    // A brand with no departments is supported (M0-06), but an operator who
    // was just told a brand is "one support desk" should not meet an empty
    // picker on the first screen that asks for one.
    expect(rows).toEqual([{ name: 'General', brandId: created.id }]);
  }, 120_000);

  it('stores the help center domain unverified, so Caddy issues it no certificate', async () => {
    const { setupToken } = await createAdmin();
    await post('/api/install/setup/brand', BRAND, setupToken);

    const [domain] = await owner.db
      .select()
      .from(brandDomains)
      .where(eq(brandDomains.domain, 'support.acme.test'));

    expect(domain?.kind).toBe('helpcenter');
    expect(domain?.verifiedAt).toBeNull();
    expect(domain?.txtToken).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);

  it('refuses a prefix another brand already has, naming the field', async () => {
    const { setupToken } = await createAdmin();
    await post('/api/install/setup/brand', BRAND, setupToken);

    const again = await post(
      '/api/install/setup/brand',
      { ...BRAND, helpcenterDomain: undefined },
      setupToken,
    );

    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({
      error: { code: 'validation_failed', fields: [{ path: 'prefix' }] },
    });
  }, 120_000);

  it('serves `fresh` to the admin app until somebody owns the install', async () => {
    const before = await app.inject({ method: 'GET', url: '/' });
    expect(before.body).toContain(`<meta name="${INSTALL_STATE_META}" content="fresh" />`);

    await createAdmin();

    const after = await app.inject({ method: 'GET', url: '/' });
    expect(after.body).toContain(`<meta name="${INSTALL_STATE_META}" content="configured" />`);
    expect(after.body).not.toContain('content="fresh"');
  }, 120_000);

  it('refuses a browser that came from another site, before it writes anything', async () => {
    // A credential-free write is the one kind a `SameSite=Lax` cookie cannot
    // protect: a page elsewhere could post step 1 blind and choose the
    // password. `Sec-Fetch-Site` is what closes it.
    const refused = await post('/api/install/setup/admin', ADMIN, undefined, {
      'sec-fetch-site': 'cross-site',
    });

    expect(refused.statusCode).toBe(403);
    await expect(owner.db.select({ id: users.id }).from(users)).resolves.toEqual([]);

    const allowed = await post('/api/install/setup/admin', ADMIN, undefined, {
      'sec-fetch-site': 'same-origin',
    });
    expect(allowed.statusCode).toBe(201);
  }, 120_000);

  it('refuses a password under the twelve-character floor', async () => {
    const weak = await post('/api/install/setup/admin', { ...ADMIN, password: 'eleven char' });

    expect(weak.statusCode).toBe(400);
    expect((weak.json() as { error: { code: string } }).error.code).toBe('validation_failed');
    await expect(owner.db.select({ id: users.id }).from(users)).resolves.toEqual([]);
  }, 120_000);

  async function createAdmin(): Promise<{ setupToken: string }> {
    const response = await post('/api/install/setup/admin', ADMIN);
    expect(response.statusCode).toBe(201);

    return response.json() as { setupToken: string };
  }
});
