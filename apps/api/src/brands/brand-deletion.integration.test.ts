import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Env } from '@helpdock/config';
import {
  auditLog,
  brandDomains,
  brands,
  createDb,
  type Db,
  type DbHandle,
  departments,
  hcMedia,
  INSTALL_SCOPE_BRAND_ID,
  seedBrandStatuses,
  systemContext,
  ticketMessages,
  ticketStatuses,
  tickets,
  users,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import type { BrandDeletion, Principal } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { S3BrandObjects } from '../media/brand-objects.js';
import { createS3Client } from '../media/storage.js';
import { StorageUsageStore } from '../observability/storage-usage.js';
import { BRAND_DELETION_REQUESTED } from './brand-deletion.service.js';
import { BRAND_PURGED, runBrandPurge, scheduleBrandPurges } from './brand-purge.job.js';

/**
 * M8-07 against a real Postgres, a real Redis and a real MinIO.
 *
 * 1. **Asking** is an install admin's alone, needs the prefix typed out, and
 *    puts the brand's public surfaces at 410 straight away.
 * 2. **Restoring** works inside the grace and is refused after it.
 * 3. **The purge** takes the brand's rows, every object under its prefix —
 *    attachments and the help center's `hc_media` alike — and every Redis key
 *    that names it, but no queue's key and nothing of another brand; it keeps
 *    the brand row as `deleted`, so the prefix stays taken; and it leaves an
 *    install-scope audit row of counts. That every tenant table is reached is
 *    proved in `packages/db/src/rls.integration.test.ts`.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const MINIO_IMAGE =
  'cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1';
const BUCKET = 'helpdock-purge';
const S3_KEY = 'helpdock';
const S3_SECRET = 'helpdock-secret';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const CONTAINER_STARTUP_MS = 180_000;
const DAY_MS = 86_400_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the brand deletion integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const BRAND_A = uuidv7();
const BRAND_B = uuidv7();
const INSTALL_ADMIN = uuidv7();

const installAdmin: Principal = {
  type: 'staff',
  id: INSTALL_ADMIN,
  brands: {},
  installAdmin: true,
};
const brandAdmin: Principal = {
  type: 'staff',
  id: uuidv7(),
  brands: { [BRAND_A]: { role: 'admin', departmentIds: 'all' } },
  installAdmin: false,
};

describe.skipIf(!hasDocker)('brand deletion', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minio: StartedTestContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let objects: S3BrandObjects;
  let putObject: (key: string, body: string) => Promise<void>;

  const db = (): Db => runtime.db;

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, as?: Principal, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        ...(as === undefined ? {} : { [DEV_PRINCIPAL_HEADER]: JSON.stringify(as) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const deletionPath = (brandId: string) => `/api/install/brands/${brandId}/deletion`;

  const seedBrand = async (id: string, prefix: string): Promise<void> => {
    await db().insert(brands).values({ id, name: prefix, prefix });
    await withSystem(db(), id, async (tx) => {
      await seedBrandStatuses(tx, id);
      const [department] = await tx
        .insert(departments)
        .values({ brandId: id, name: 'Support' })
        .returning({ id: departments.id });
      const [open] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.name, 'Open'));
      const ticketId = uuidv7();
      await tx.insert(tickets).values({
        id: ticketId,
        brandId: id,
        departmentId: department?.id ?? '',
        number: 1,
        prefix,
        subject: 'Where is my order?',
        statusId: open?.id ?? '',
        channel: 'email',
      });
      await tx.insert(ticketMessages).values({
        brandId: id,
        ticketId,
        departmentId: department?.id ?? '',
        seq: 1,
        kind: 'public',
        authorType: 'contact',
        bodyHtml: '<p>Hello</p>',
        bodyText: 'Hello',
        channel: 'email',
      });
      await tx.insert(hcMedia).values({
        brandId: id,
        s3Key: `brands/${id}/help-center/${uuidv7()}/original`,
        originalName: 'logo.png',
        mime: 'image/png',
        size: 4,
      });
      await tx.insert(brandDomains).values({
        brandId: id,
        domain: `help.${prefix.toLowerCase()}.example`,
        kind: 'helpcenter',
        txtToken: 'helpdock-verification=seeded',
      });
    });
    await putObject(`brands/${id}/tickets/${uuidv7()}/${uuidv7()}/original`, 'attachment');
    await putObject(`brands/${id}/help-center/${uuidv7()}/webp`, 'logo');
  };

  const rowsOf = async (table: string, brandId: string): Promise<number> => {
    const [row] = await owner.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ${sql.identifier(table)} WHERE brand_id = ${brandId}`,
    );
    return row?.count ?? 0;
  };

  const installAudit = (action: string) =>
    withTenant(db(), systemContext(INSTALL_SCOPE_BRAND_ID), (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, action), eq(auditLog.targetId, BRAND_A))),
    );

  beforeAll(async () => {
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';
    [postgres, redisContainer, minio] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new GenericContainer(MINIO_IMAGE)
        .withCommand(['server', '/data'])
        .withEnvironment({ MINIO_ROOT_USER: S3_KEY, MINIO_ROOT_PASSWORD: S3_SECRET })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
        .withStartupTimeout(CONTAINER_STARTUP_MS)
        .start(),
    ]);
    const env = {
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
      DATABASE_MIGRATION_URL: postgres.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
      S3_REGION: 'us-east-1',
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY_ID: S3_KEY,
      S3_SECRET_ACCESS_KEY: S3_SECRET,
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: '/nonexistent',
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
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });

    const client = createS3Client(env);
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    objects = new S3BrandObjects(client, BUCKET);
    putObject = async (key, body) => {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
    };

    await seedBrand(BRAND_A, 'ACME');
    await seedBrand(BRAND_B, 'GLOBEX');
    await db()
      .insert(users)
      .values({ id: INSTALL_ADMIN, email: 'lina@example.com', name: 'Lina Haddad' });
  }, 400_000);

  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    vi.useRealTimers();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop(), minio?.stop()]);
  });

  describe('asking for it', () => {
    it('is refused to a brand admin, and without the prefix typed out', async () => {
      expect(
        (await call('POST', deletionPath(BRAND_A), brandAdmin, { confirmPrefix: 'ACME' }))
          .statusCode,
      ).toBe(403);
      expect(
        (await call('POST', deletionPath(BRAND_A), installAdmin, { confirmPrefix: 'acme' }))
          .statusCode,
      ).toBe(400);
    });

    it('starts the grace, audited in install scope', async () => {
      const response = await call('POST', deletionPath(BRAND_A), installAdmin, {
        confirmPrefix: 'ACME',
      });

      expect(response.statusCode).toBe(200);
      const deletion = response.json<BrandDeletion>();
      expect(deletion.status).toBe('deleting');
      expect(Date.parse(deletion.purgeAfter ?? '') - Date.parse(deletion.requestedAt ?? '')).toBe(
        30 * DAY_MS,
      );
      expect(deletion.requestedBy).toEqual({ userId: INSTALL_ADMIN, name: 'Lina Haddad' });
      expect(await installAudit(BRAND_DELETION_REQUESTED)).toHaveLength(1);
      // The read finds the requester in the audit row the request wrote.
      expect(
        (await call('GET', deletionPath(BRAND_A), installAdmin)).json<BrandDeletion>(),
      ).toEqual(deletion);
    });

    it("answers 410 on the brand's public routes at once, and nowhere else", async () => {
      expect((await call('GET', `/api/widget/${BRAND_A}/config`)).statusCode).toBe(410);
      expect((await call('GET', `/contact/${BRAND_A}`)).statusCode).toBe(410);
      expect(
        (await call('GET', `/api/help-center/brands/${BRAND_A}/media/${uuidv7()}`)).statusCode,
      ).toBe(410);
      expect((await call('GET', `/api/widget/${BRAND_B}/config`)).statusCode).not.toBe(410);
    });

    it('cannot be asked twice', async () => {
      expect(
        (await call('POST', deletionPath(BRAND_A), installAdmin, { confirmPrefix: 'ACME' }))
          .statusCode,
      ).toBe(409);
    });
  });

  describe('restoring', () => {
    it('brings the brand back inside the grace, and its public routes with it', async () => {
      const response = await call('DELETE', deletionPath(BRAND_A), installAdmin);

      expect(response.statusCode).toBe(200);
      expect(response.json<BrandDeletion>()).toMatchObject({
        status: 'active',
        purgeAfter: null,
        requestedBy: null,
      });
      // Past the few seconds a replica keeps its answer.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 });
      expect((await call('GET', `/api/widget/${BRAND_A}/config`)).statusCode).not.toBe(410);
      vi.useRealTimers();
    });

    it('is refused once the grace is over', async () => {
      await call('POST', deletionPath(BRAND_A), installAdmin, { confirmPrefix: 'ACME' });
      await db()
        .update(brands)
        .set({ deletedAt: new Date(Date.now() - 31 * DAY_MS) })
        .where(eq(brands.id, BRAND_A));

      expect((await call('DELETE', deletionPath(BRAND_A), installAdmin)).statusCode).toBe(409);
    });
  });

  describe('the purge', () => {
    it('is scheduled for a brand past its grace, and only that one', async () => {
      const added: string[] = [];
      await scheduleBrandPurges({
        db: db(),
        queue: { add: async (_payload, jobId) => void added.push(jobId) },
      });

      expect(added).toEqual([`brand.purge.${BRAND_A}`]);
    });

    it('takes the rows, the objects and the keys of the brand, and nothing of another', async () => {
      const redis = runtime.redis;
      const usage = new StorageUsageStore(redis);
      await usage.write({
        brandId: BRAND_A,
        bytes: 14,
        objects: 2,
        measuredAt: new Date().toISOString(),
      });
      await redis.set(`hd:hc:page:${BRAND_A}:en`, 'cached page');
      await redis.set(`rate:widget:${BRAND_A}:203.0.113.9`, '3');
      await redis.set(`bull:maintenance:brand.purge.${BRAND_A}`, 'a job hash');
      await redis.set(`hd:hc:page:${BRAND_B}:en`, 'cached page');
      const removedPollers: string[] = [];
      const usageOfB = await objects.usage(BRAND_B);

      const result = await runBrandPurge({
        db: db(),
        objects,
        redis,
        storageUsage: usage,
        removePollers: async (ids) => void removedPollers.push(...ids),
        brandId: BRAND_A,
        jobId: `brand.purge.${BRAND_A}`,
      });

      expect(result).toMatchObject({ outcome: 'purged', objects: 2, redisKeys: 2 });
      for (const table of [
        'tickets',
        'ticket_messages',
        'hc_media',
        'brand_domains',
        'departments',
        'ticket_statuses',
      ]) {
        expect(await rowsOf(table, BRAND_A), table).toBe(0);
        expect(await rowsOf(table, BRAND_B), table).toBeGreaterThan(0);
      }
      expect(await objects.usage(BRAND_A)).toEqual({ bytes: 0, objects: 0 });
      expect(await objects.usage(BRAND_B)).toEqual(usageOfB);
      expect(usageOfB.objects).toBe(2);
      expect(
        await redis.exists(`hd:hc:page:${BRAND_A}:en`, `rate:widget:${BRAND_A}:203.0.113.9`),
      ).toBe(0);
      expect(
        await redis.exists(`bull:maintenance:brand.purge.${BRAND_A}`, `hd:hc:page:${BRAND_B}:en`),
      ).toBe(2);
      expect((await usage.all()).map((reading) => reading.brandId)).not.toContain(BRAND_A);
    });

    it('keeps the brand row as deleted, so its prefix stays taken', async () => {
      const [row] = await db()
        .select({ status: brands.status })
        .from(brands)
        .where(eq(brands.id, BRAND_A));
      expect(row?.status).toBe('deleted');

      const reuse = await call('POST', '/api/install/brands', installAdmin, {
        name: 'Acme again',
        prefix: 'ACME',
        defaultLocale: 'en',
        timezone: 'UTC',
      });
      expect(reuse.statusCode).toBe(400);
      expect(reuse.body).toContain('is already in use on this install');
      // Past the answer the restore test left cached, which it read ten seconds ahead.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
      expect((await call('GET', `/api/widget/${BRAND_A}/config`)).statusCode).toBe(410);
      vi.useRealTimers();
    });

    it('leaves an install-scope audit row of counts, and finds nothing to do a second time', async () => {
      const [entry] = await installAudit(BRAND_PURGED);
      expect(entry?.meta).toMatchObject({ objects: 2, redisKeys: 2 });
      expect((entry?.meta as { rows?: number } | undefined)?.rows).toBeGreaterThan(0);

      const again = await runBrandPurge({
        db: db(),
        objects,
        redis: runtime.redis,
        brandId: BRAND_A,
        jobId: `brand.purge.${BRAND_A}`,
      });
      expect(again).toMatchObject({ outcome: 'purged', objects: 0, redisKeys: 0 });
      expect(
        Object.values(again.outcome === 'purged' ? again.rows : {}).every((n) => n === 0),
      ).toBe(true);
    });
  });
});
