import { decodeMasterKey, type Env } from '@helpdock/config';
import { createDb, type DbHandle, userBrandRoles, users, uuidv7, withSystem } from '@helpdock/db';
import type { KeyboardPreferences, Session } from '@helpdock/schemas';
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
 * M14-01's switch against a real Postgres, over real sessions: it starts on,
 * it is saved on the account so a new sign-in finds it, and one person's
 * choice is never another's.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M14-01 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('the single-key shortcuts switch', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let adminToken: string;
  let agentEmail: string;
  let agentToken: string;

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
    method: 'GET' | 'PUT',
    token: string | null,
    payload?: unknown,
    url = '/api/me/keyboard',
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

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
    adminToken = await signInForTest(app, { email: seeded.email, password: seeded.password });

    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const agentId = uuidv7();
    agentEmail = `sam-${agentId}@helpdock.test`;
    await runtime.db.insert(users).values({
      id: agentId,
      email: agentEmail,
      name: 'Sam Agent',
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(STAFF_PASSWORD),
    });
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .insert(userBrandRoles)
        .values({ userId: agentId, brandId: seeded.brandId, role: 'agent', departmentIds: [] }),
    );
    agentToken = await signInForTest(app, { email: agentEmail, password: STAFF_PASSWORD });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  it('starts on for everybody (D-32)', async () => {
    const admin = await call<KeyboardPreferences>('GET', adminToken);
    expect(admin).toEqual({ status: 200, body: { singleKeyShortcuts: true } });

    const agent = await call<KeyboardPreferences>('GET', agentToken);
    expect(agent.body).toEqual({ singleKeyShortcuts: true });
  });

  it('keeps the choice on the account, so a new sign-in finds it in its session', async () => {
    const saved = await call<KeyboardPreferences>('PUT', agentToken, {
      singleKeyShortcuts: false,
    });
    expect(saved).toEqual({ status: 200, body: { singleKeyShortcuts: false } });

    const again = await signInForTest(app, { email: agentEmail, password: STAFF_PASSWORD });
    expect((await call<KeyboardPreferences>('GET', again)).body).toEqual({
      singleKeyShortcuts: false,
    });
    // The shell reads it from the session it already waits for (WCAG 2.1.4).
    const session = await call<Session>('GET', again, undefined, '/api/auth/me');
    expect(session.body.user.singleKeyShortcuts).toBe(false);
  });

  it('changes nobody else’s switch', async () => {
    await call('PUT', agentToken, { singleKeyShortcuts: false });

    expect((await call<KeyboardPreferences>('GET', adminToken)).body).toEqual({
      singleKeyShortcuts: true,
    });
  });

  it('refuses a body that is not a boolean switch, and changes nothing', async () => {
    await call('PUT', adminToken, { singleKeyShortcuts: true });

    expect((await call('PUT', adminToken, { singleKeyShortcuts: 'off' })).status).toBe(400);
    expect((await call<KeyboardPreferences>('GET', adminToken)).body).toEqual({
      singleKeyShortcuts: true,
    });
  });

  it('answers nobody who is not signed in', async () => {
    expect((await call('GET', null)).status).toBe(401);
    expect((await call('PUT', null, { singleKeyShortcuts: false })).status).toBe(401);
  });
});
