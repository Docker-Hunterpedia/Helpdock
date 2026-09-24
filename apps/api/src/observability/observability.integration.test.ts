import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Env } from '@helpdock/config';
import { auditLog, brands, type Db, userBrandRoles, users, uuidv7 } from '@helpdock/db';
import { createQueueConnection, QUEUE_NAMES, RELAY_STATUS_KEY } from '@helpdock/jobs';
import type { Principal, SystemQueuePage, SystemStatus } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { withSystemJob } from '../tenant/system-job.js';
import { ObservabilityGauges } from './observability.module.js';

/**
 * M0-10 against the real thing: a real Postgres with the real migrations, a
 * real Redis with the real queues, and the app wired exactly as it boots.
 *
 * The unit tests prove each rule; this proves that `/metrics` is actually
 * served and actually guarded, and that `/api/install/system` reads the numbers
 * off a live install rather than off a fixture.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const METRICS_TOKEN = 'a-metrics-token-long-enough';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the observability integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const BRAND = uuidv7();
const installAdminId = uuidv7();
const brandAdminId = uuidv7();

const asPrincipal = (principal: Principal): Record<string, string> => ({
  [DEV_PRINCIPAL_HEADER]: JSON.stringify(principal),
});

const installAdmin: Principal = {
  type: 'staff',
  id: installAdminId,
  brands: {},
  installAdmin: true,
};

const brandAdmin: Principal = {
  type: 'staff',
  id: brandAdminId,
  brands: { [BRAND]: { role: 'admin', departmentIds: 'all' } },
  installAdmin: false,
};

describe.skipIf(!hasDocker)('observability', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;

  const get = (url: string, headers: Record<string, string> = {}, remoteAddress?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
    });

  beforeAll(async () => {
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';

    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);

    const env = {
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      METRICS_TOKEN,
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
      DATABASE_MIGRATION_URL: postgres.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: '/app/admin',
      OUTBOUND_ALLOW_CIDRS: [],
    } as Env;

    runtime = await createRuntime({
      env,
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
      }),
    });
    app = await createApiApp({ runtime });

    await seed(runtime.db);
  });

  /**
   * One real pass of the 15-second sampler. Without this the gauges are only
   * ever *declared* — a scrape would show `# TYPE db_up gauge` whether or not
   * anything ever filled it in.
   */
  const sampleGauges = async (): Promise<void> => {
    await app.get(ObservabilityGauges).sampleOnce();
  };

  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    await app?.close();
    await runtime?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  const seed = async (db: Db): Promise<void> => {
    await db.insert(brands).values([{ id: BRAND, name: 'Acme', prefix: 'ACME' }]);
    await db.insert(users).values([
      {
        id: installAdminId,
        email: 'install@example.com',
        name: 'Install Admin',
        status: 'active',
        installAdmin: true,
      },
      { id: brandAdminId, email: 'admin@example.com', name: 'Brand Admin', status: 'active' },
    ]);
    await withSystemJob(db, BRAND, 'seed', (tx) =>
      tx.insert(userBrandRoles).values([{ userId: brandAdminId, brandId: BRAND, role: 'admin' }]),
    );
  };

  describe('GET /metrics', () => {
    it('serves the Prometheus text format to the private network', async () => {
      const response = await get('/metrics');

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('# TYPE http_request_duration_seconds histogram');
      expect(response.body).toContain('# TYPE queue_jobs gauge');
      expect(response.body).toContain('nodejs_eventloop_lag_seconds');
    });

    it('fills the sampled gauges with real readings, not just their declarations', async () => {
      // A job on a real queue, so the depth and the age are measured rather
      // than asserted against an empty install.
      const connection = createQueueConnection(redis.getConnectionUrl());
      const queue = new Queue(QUEUE_NAMES.outbound, { connection });

      try {
        await queue.add('probe', { brandId: BRAND });
        await sampleGauges();

        const body = (await get('/metrics')).body;

        expect(body).toContain('db_up 1');
        expect(body).toContain('redis_up 1');
        expect(body).toContain('queue_jobs{queue="outbound",state="waiting"} 1');
        expect(body).toContain('queue_jobs{queue="inbound",state="waiting"} 0');
        // No relay runs in this process, so the backlog gauge must say the
        // relay is down rather than let a zero read as health.
        expect(body).toContain('outbox_relay_up 0');
        expect(body).toMatch(/db_pool_connections\{state="[a-z_]+"\} [1-9]/);
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
        await connection.quit();
      }
    });

    it('records the route template of a request that has already been served', async () => {
      await get('/api/brands', asPrincipal(brandAdmin));

      const response = await get('/metrics');

      expect(response.body).toContain(
        'http_requests_total{route="/api/brands",method="GET",status="200"}',
      );
      expect(response.body).toContain('http_request_duration_seconds_bucket{le="0.005"');
    });

    /**
     * The anti-cardinality property, stated without assuming which template
     * caught the path: since M0-09 the admin SPA has a catch-all, so an unknown
     * path is usually *matched* rather than unmatched — and either way it must
     * not mint a series of its own.
     */
    it('gives two paths nobody declared at most one series between them', async () => {
      const labelsIn = (body: string): Set<string> =>
        new Set(
          [...body.matchAll(/http_requests_total\{route="([^"]+)"/g)].map(
            ([, route]) => route ?? '',
          ),
        );

      const before = labelsIn((await get('/metrics')).body);

      await get('/does-not-exist-0192c3f0');
      await get('/also-missing-7f3a9b21');

      const body = (await get('/metrics')).body;

      expect(labelsIn(body).size - before.size).toBeLessThanOrEqual(1);
      // And whatever the label is, it is not the path that was asked for.
      expect(body).not.toContain('0192c3f0');
      expect(body).not.toContain('7f3a9b21');
    });

    it('answers 404 to a public address with no token', async () => {
      const response = await get('/metrics', {}, '203.0.113.5');

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('http_request_duration_seconds');
    });

    it('answers a public address that presents METRICS_TOKEN', async () => {
      const response = await get(
        '/metrics',
        { authorization: `Bearer ${METRICS_TOKEN}` },
        '203.0.113.5',
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('# TYPE db_up gauge');
    });

    it('answers 404 to a public address with the wrong token', async () => {
      const response = await get('/metrics', { authorization: 'Bearer nope' }, '203.0.113.5');

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/install/system', () => {
    it('reports the migrations that were applied and every queue there is', async () => {
      const response = await get('/api/install/system', asPrincipal(installAdmin));

      expect(response.statusCode).toBe(200);
      const status = response.json<SystemStatus>();

      expect(status.database.migrationsApplied).toBeGreaterThan(0);
      expect(status.database.version).toMatch(/^17\./);
      expect(status.database.runtimeRole).toEqual({
        name: 'helpdock_app',
        superuser: false,
        bypassRls: false,
        ownedTables: 0,
      });

      // ARCHITECTURE §13 names twelve queues (M1-07 added `assignment`); the card
      // shows the first five.
      expect(status.queues.total).toBe(12);
      expect(status.queues.queues).toHaveLength(5);
      expect(status.queues.queues[0]).toMatchObject({ name: 'inbound', waiting: 0 });

      expect(status.redis.version).toMatch(/^7\./);
      expect(status.redis.aofRewriteInProgress).toBe(false);
      expect(status.api.status).toBe('ok');
    });

    it('says the relay is not reporting, and repeats it once one does', async () => {
      const before = await get('/api/install/system', asPrincipal(installAdmin));
      expect(before.json<SystemStatus>().relay).toEqual({ reporting: false });

      await runtime.redis.set(
        RELAY_STATUS_KEY,
        JSON.stringify({
          at: new Date().toISOString(),
          durationMs: 400,
          pending: 3,
          published: 1,
          brands: 1,
          skipped: 0,
          failed: 0,
        }),
        'EX',
        300,
      );

      const after = await get('/api/install/system', asPrincipal(installAdmin));
      expect(after.json<SystemStatus>().relay).toMatchObject({ reporting: true, pending: 3 });

      await runtime.redis.del(RELAY_STATUS_KEY);
    });

    it('records its own install-scope access in the audit log it returns', async () => {
      await get('/api/install/system', asPrincipal(installAdmin));

      const status = (
        await get('/api/install/system', asPrincipal(installAdmin))
      ).json<SystemStatus>();

      expect(status.audit[0]).toMatchObject({
        actorType: 'staff',
        actorId: installAdminId,
        action: 'install.scope.access',
        targetId: 'GET /api/install/system',
      });
    });

    it('reports storage and AI spend as not configured rather than as zero', async () => {
      const status = (
        await get('/api/install/system', asPrincipal(installAdmin))
      ).json<SystemStatus>();

      expect(status.storage).toEqual({ configured: false });
      expect(status.aiSpend).toEqual({ configured: false });
      expect(status.channels).toEqual([]);
    });

    it('measures the depth and the age of a queue that has work waiting', async () => {
      const connection = createQueueConnection(redis.getConnectionUrl());
      const queue = new Queue(QUEUE_NAMES.outbound, { connection });

      try {
        await queue.add('probe', { brandId: BRAND });

        const status = (
          await get('/api/install/system/queues?pageSize=50', asPrincipal(installAdmin))
        ).json<SystemQueuePage>();

        const outbound = status.queues.find((each) => each.name === 'outbound');
        expect(outbound).toMatchObject({ waiting: 1 });
        expect(outbound?.oldestWaitingSeconds).toBeGreaterThanOrEqual(0);

        // A queue with nothing waiting has no oldest job, rather than an age of
        // zero that reads like a job that just arrived.
        expect(status.queues.find((each) => each.name === 'inbound')).toMatchObject({
          waiting: 0,
          oldestWaitingSeconds: null,
        });
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
        await connection.quit();
      }
    });

    it("shows install-scope audit rows and never a brand's own", async () => {
      await withSystemJob(runtime.db, BRAND, 'seed-audit', (tx) =>
        tx.insert(auditLog).values({
          brandId: BRAND,
          actorType: 'staff',
          actorId: brandAdminId,
          action: 'brand.only.action',
          targetType: 'ticket',
        }),
      );

      const status = (
        await get('/api/install/system', asPrincipal(installAdmin))
      ).json<SystemStatus>();

      expect(status.audit.length).toBeGreaterThan(0);
      expect(status.audit.map((entry) => entry.action)).not.toContain('brand.only.action');
      expect(status.audit.every((entry) => entry.action === 'install.scope.access')).toBe(true);
    });

    it('refuses a brand admin who is not an install admin', async () => {
      const response = await get('/api/install/system', asPrincipal(brandAdmin));

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('helpdock_app');
    });

    it('refuses a request with no principal at all', async () => {
      expect((await get('/api/install/system')).statusCode).toBe(401);
    });
  });

  describe('GET /api/install/system/queues', () => {
    it('pages the full list', async () => {
      const response = await get(
        '/api/install/system/queues?page=2&pageSize=4',
        asPrincipal(installAdmin),
      );

      expect(response.statusCode).toBe(200);
      const page = response.json<SystemQueuePage>();
      expect(page).toMatchObject({ page: 2, pageSize: 4, total: 12 });
      expect(page.queues).toHaveLength(4);
    });

    it('refuses a page size that would ask for everything', async () => {
      const response = await get(
        '/api/install/system/queues?pageSize=5000',
        asPrincipal(installAdmin),
      );

      expect(response.statusCode).toBe(400);
    });

    it('refuses a brand admin', async () => {
      expect((await get('/api/install/system/queues', asPrincipal(brandAdmin))).statusCode).toBe(
        403,
      );
    });
  });
});
