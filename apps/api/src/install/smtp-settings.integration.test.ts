import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Env } from '@helpdock/config';
import { auditLog, createDb, type DbHandle, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { silentLogger } from '../testing/silent-logger.js';
import { SETUP_SMTP_TEST_IP_RULE } from './setup.service.js';

/**
 * The System page's Outgoing email card over HTTP (#369): the settings round
 * trip with the password encrypted at rest and never in a response, the test
 * email actually reaching Mailpit, and an `HD_SMTP_*` variable winning over
 * the database on both the read and the write.
 *
 * The unit suite proves each rule decides correctly; this proves the routes
 * are wired to the guard, the transaction and a real relay.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const MAILPIT_IMAGE = 'axllent/mailpit';
const MAILPIT_SMTP_PORT = 1025;
const MAILPIT_HTTP_PORT = 8025;

const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 17).toString('base64');
const APP_URL = 'https://support.example.com';

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the outgoing email settings integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const adminDist = mkdtempSync(path.join(tmpdir(), 'helpdock-smtp-admin-'));
mkdirSync(adminDist, { recursive: true });
writeFileSync(
  path.join(adminDist, 'index.html'),
  '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  'utf8',
);

describe.skipIf(!hasDocker)('the outgoing email settings', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let mailpit: StartedTestContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let mailpitApi: string;
  let smtp: { host: string; port: number };

  const envFor = (overrides: Partial<Env> = {}): Env =>
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
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: adminDist,
      OUTBOUND_ALLOW_CIDRS: [],
      ...overrides,
    }) as Env;

  const headersFor = (installAdmin: boolean): Record<string, string> => ({
    'content-type': 'application/json',
    [DEV_PRINCIPAL_HEADER]: JSON.stringify({
      type: 'staff',
      id: seeded.userId,
      brands: {},
      installAdmin,
    }),
  });

  const request = (
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    body?: unknown,
    installAdmin = true,
  ) =>
    app.inject({
      method,
      url,
      headers: headersFor(installAdmin),
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const mailpitMessages = async (): Promise<
    { From: { Address: string }; To: { Address: string }[]; Subject: string }[]
  > => {
    const response = await fetch(`${mailpitApi}/api/v1/messages`);
    return ((await response.json()) as { messages: never[] }).messages;
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

    // The routes are guarded by `install:admin`; the dev principal header is
    // how this suite stands in the session a browser would carry.
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';

    runtime = await createRuntime({ env: envFor(), logger: silentLogger() });
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    owner = createDb({
      url: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
    });
  }, 300_000);

  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop(), mailpit?.stop()]);
  });

  it('answers the settings only to an install admin', async () => {
    expect((await request('GET', '/api/install/settings/smtp', undefined, false)).statusCode).toBe(
      403,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/api/install/settings/smtp' })).statusCode,
    ).toBe(401);
  });

  it('reads an install that skipped the wizard as unconfigured, and round-trips a save', async () => {
    const before = await request('GET', '/api/install/settings/smtp');
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      configured: false,
      host: '',
      port: 587,
      tls: 'starttls',
      user: '',
      passwordConfigured: false,
      fromAddress: '',
      fromName: '',
      locked: {
        host: false,
        port: false,
        tls: false,
        user: false,
        password: false,
        fromAddress: false,
        fromName: false,
      },
    });

    const saved = await request('PUT', '/api/install/settings/smtp', {
      host: smtp.host,
      port: smtp.port,
      tls: 'none',
      user: 'postmaster',
      password: 'relay-secret',
      fromAddress: 'no-reply@helpdock.test',
      fromName: 'Helpdock',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      configured: true,
      host: smtp.host,
      port: smtp.port,
      user: 'postmaster',
      passwordConfigured: true,
      fromAddress: 'no-reply@helpdock.test',
      fromName: 'Helpdock',
    });
    expect(saved.body).not.toContain('relay-secret');

    const stored = await owner.db.execute(
      sql`SELECT value FROM settings WHERE key = 'smtp.password' AND brand_id = ${INSTALL_SCOPE_BRAND_ID}`,
    );
    expect((stored as unknown as { value: string }[])[0]?.value).toMatch(/^v1\./);

    const audit = await owner.db
      .select({ meta: auditLog.meta })
      .from(auditLog)
      .where(sql`${auditLog.action} = 'settings.updated' and ${auditLog.targetId} = 'smtp'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.meta).toMatchObject({ keys: expect.arrayContaining(['smtp.password']) });
    expect(JSON.stringify(audit)).not.toContain('relay-secret');
  }, 60_000);

  it('sends the test email with what is on screen and delivers it to the admin', async () => {
    await fetch(`${mailpitApi}/api/v1/messages`, { method: 'DELETE' });

    const test = await request('POST', '/api/install/settings/smtp/test', {
      host: smtp.host,
      port: smtp.port,
      tls: 'none',
      user: 'postmaster',
      fromAddress: 'no-reply@helpdock.test',
      fromName: 'Helpdock',
    });

    expect(test.statusCode).toBe(201);
    expect(test.json()).toMatchObject({ delivered: true });
    expect(String((test.json() as { response: string }).response)).toMatch(/^2\d\d/);

    const messages = await mailpitMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.From.Address).toBe('no-reply@helpdock.test');
    expect(messages[0]?.To[0]?.Address).toBe(seeded.email);
  }, 60_000);

  it('keeps the stored password when a save provides none', async () => {
    const saved = await request('PUT', '/api/install/settings/smtp', {
      host: smtp.host,
      port: smtp.port,
      tls: 'none',
      user: 'postmaster',
      fromAddress: 'no-reply@helpdock.test',
      fromName: 'Helpdock Support',
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ fromName: 'Helpdock Support', passwordConfigured: true });
    await expect(runtime.settings.get('smtp.password')).resolves.toBe('relay-secret');
  }, 60_000);

  it('refuses to send the stored password to a server it was not saved for', async () => {
    const moved = {
      host: 'relay.elsewhere.test',
      port: smtp.port,
      tls: 'none',
      user: 'postmaster',
      fromAddress: 'no-reply@helpdock.test',
      fromName: 'Helpdock',
    };

    for (const [method, url] of [
      ['PUT', '/api/install/settings/smtp'],
      ['POST', '/api/install/settings/smtp/test'],
    ] as const) {
      const refused = await request(method, url, moved);

      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        error: {
          setup: { reason: 'smtp-password-required' },
          fields: [{ path: 'body.password' }],
        },
      });
    }
    await expect(runtime.settings.get('smtp.host')).resolves.toBe(smtp.host);
  }, 60_000);

  it('refuses the writes and the test to anyone but an install admin', async () => {
    const body = {
      host: smtp.host,
      port: smtp.port,
      tls: 'none',
      user: 'postmaster',
      fromAddress: 'no-reply@helpdock.test',
      fromName: 'Helpdock',
    };

    for (const [method, url] of [
      ['PUT', '/api/install/settings/smtp'],
      ['POST', '/api/install/settings/smtp/test'],
    ] as const) {
      expect((await request(method, url, body, false)).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method,
            url,
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify(body),
          })
        ).statusCode,
      ).toBe(401);
    }
  }, 60_000);

  it('refuses a test that names its own recipient', async () => {
    const test = await request('POST', '/api/install/settings/smtp/test', {
      host: smtp.host,
      port: smtp.port,
      tls: 'none',
      user: 'postmaster',
      fromAddress: 'no-reply@helpdock.test',
      fromName: 'Helpdock',
      to: 'someone-else@example.com',
    });

    expect(test.statusCode).toBe(400);
  }, 60_000);

  it('refuses a relay that is not listening as a connection failure, not a crash', async () => {
    const test = await request('POST', '/api/install/settings/smtp/test', {
      host: '127.0.0.1',
      port: 1,
      tls: 'none',
      user: '',
      password: 'typed-again',
      fromAddress: 'no-reply@helpdock.test',
      fromName: 'Helpdock',
    });

    expect(test.statusCode).toBe(201);
    expect(test.json()).toMatchObject({ delivered: false, error: 'connection-refused' });
  }, 60_000);

  describe('with HD_SMTP_* set', () => {
    let pinnedRuntime: Runtime;
    let pinned: ApiApp;

    const pinnedRequest = (method: 'GET' | 'PUT', body?: unknown) =>
      pinned.inject({
        method,
        url: '/api/install/settings/smtp',
        headers: headersFor(true),
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });

    beforeAll(async () => {
      // Settings read their overrides from the process environment, which is
      // how an operator pins them; a second api process over the same database
      // is exactly how an operator would run one.
      process.env.HD_SMTP_HOST = 'pinned.example.com';
      process.env.HD_SMTP_PORT = '465';
      process.env.HD_SMTP_FROM = 'pinned@helpdock.test';

      pinnedRuntime = await createRuntime({
        env: envFor(),
        logger: silentLogger(),
      });
      pinned = await createApiApp({ runtime: pinnedRuntime });
    }, 120_000);

    afterAll(async () => {
      delete process.env.HD_SMTP_HOST;
      delete process.env.HD_SMTP_PORT;
      delete process.env.HD_SMTP_FROM;
      await pinned?.close();
      await pinnedRuntime?.close();
    });

    it('reports the pinned fields as locked, with the values the environment chose', async () => {
      const read = await pinnedRequest('GET');

      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        configured: true,
        host: 'pinned.example.com',
        port: 465,
        fromAddress: 'pinned@helpdock.test',
        locked: { host: true, port: true, fromAddress: true },
      });
    });

    it('refuses a save that would change a pinned field, and takes the rest', async () => {
      const refused = await pinnedRequest('PUT', {
        host: 'other.example.com',
        port: 587,
        tls: 'starttls',
        user: '',
        fromAddress: 'pinned@helpdock.test',
        fromName: 'Helpdock',
      });

      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        error: { message: expect.stringContaining('HD_SMTP_HOST') },
      });

      // Restating what the environment pinned is not a change; the unpinned
      // keys go through and the reply is the state that really holds.
      const taken = await pinnedRequest('PUT', {
        host: 'pinned.example.com',
        port: 465,
        tls: 'tls',
        user: 'postmaster',
        fromAddress: 'pinned@helpdock.test',
        fromName: 'Helpdock',
      });
      expect(taken.statusCode).toBe(200);
      expect(taken.json()).toMatchObject({
        host: 'pinned.example.com',
        port: 465,
        tls: 'tls',
        fromAddress: 'pinned@helpdock.test',
      });
      await expect(pinnedRuntime.settings.get('smtp.host')).resolves.toBe('pinned.example.com');
    }, 60_000);
  });
  it('answers 429 with Retry-After once the test budget is spent', async () => {
    const attempt = () =>
      request('POST', '/api/install/settings/smtp/test', {
        host: '127.0.0.1',
        port: 1,
        tls: 'none',
        user: '',
        password: 'typed-again',
        fromAddress: 'no-reply@helpdock.test',
        fromName: 'Helpdock',
      });

    let refused = await attempt();
    for (
      let tries = 0;
      tries < SETUP_SMTP_TEST_IP_RULE.limit && refused.statusCode === 201;
      tries += 1
    ) {
      refused = await attempt();
    }

    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.json()).toMatchObject({ error: { code: 'rate_limited' } });
  }, 120_000);
});
