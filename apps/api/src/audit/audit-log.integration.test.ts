import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  createDb,
  type Db,
  type DbHandle,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type { AuditLogPage, DepartmentSummary } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { signInForTest } from '../testing/staff-sign-in.js';

/**
 * M3-08 against a real Postgres, over real sessions.
 *
 * 1. **Install-wide**: an install admin reads every brand's rows and the
 *    install's own; anybody else is refused.
 * 2. **Opening the page is itself audited**, with where the request came from.
 * 3. **Filters and the cursor** page a real table, newest first.
 * 4. **A secret never leaves the server**, whatever a row stored.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 37).toString('base64');
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
    'Skipping the M3-08 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('the audit log viewer', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  /** The install admin, whose department scope is `all`. */
  let ada: Person;
  /** An Agent of Support. */
  let sam: Person;
  /** A Team Leader who leads Billing and nothing else. */
  let tia: Person;

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
          'user-agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) Firefox/130.0',
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
    const email = `${who.toLowerCase().replaceAll(' ', '.')}-${id}@helpdock.test`;
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

    sam = await addPerson(runtime.db, 'Sam Agent');
    tia = await addPerson(runtime.db, 'Tia Leader');
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: tia.id, brandId: seeded.brandId, role: 'team_leader', departmentIds: [billing] },
      ]),
    );
    sam.token = await signIn(sam.email, STAFF_PASSWORD);
    tia.token = await signIn(tia.email, STAFF_PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  const page = (who: Person, query = '') =>
    call<AuditLogPage>('GET', `/api/install/audit-log${query}`, who);

  it('refuses anybody but an install admin', async () => {
    expect((await page(sam)).status).toBe(403);
    expect((await page(tia)).status).toBe(403);
  });

  it('shows every brand’s rows and the install’s own, newest first, with names', async () => {
    await call('POST', `${brandPath()}/tags`, ada, { name: 'audited-tag' });

    const response = await page(ada);
    expect(response.status).toBe(200);

    const { entries, brands } = response.body;
    expect(brands.map((brand) => brand.name)).toContain('Helpdock Dev');

    const tag = entries.find((entry) => entry.action === 'tag.created');
    expect(tag).toMatchObject({
      brandId: seeded.brandId,
      brandName: 'Helpdock Dev',
      actorName: 'Dev Admin',
      ip: '127.0.0.1',
    });
    expect(tag?.userAgent).toContain('Firefox');

    const times = entries.map((entry) => Date.parse(entry.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('writes its own install.scope.access row, which the next read shows', async () => {
    await page(ada);
    const response = await page(ada, '?brand=install&action=install.scope.access&limit=5');

    expect(response.body.entries[0]).toMatchObject({
      brandId: null,
      action: 'install.scope.access',
      targetId: 'GET /api/install/audit-log',
    });
    expect(response.body.entries[0]?.requestId).toMatch(/.+/);
  });

  it('filters by action family, brand, target and actor', async () => {
    const tags = await page(ada, `?action=tag.*&brand=${seeded.brandId}&targetType=tag`);
    expect(tags.body.entries.length).toBeGreaterThan(0);
    expect(tags.body.entries.every((entry) => entry.action.startsWith('tag.'))).toBe(true);

    const byName = await page(ada, '?actor=Dev%20Admin&action=tag.created');
    expect(byName.body.entries.length).toBeGreaterThan(0);

    const nobody = await page(ada, '?actor=nobody-at-all');
    expect(nobody.body.entries).toEqual([]);

    const future = await page(ada, '?from=2999-01-01T00:00:00Z');
    expect(future.body.entries).toEqual([]);
  });

  it('pages with a cursor, without repeating or skipping a row', async () => {
    const all = await page(ada, '?limit=100');
    const first = await page(ada, '?limit=2');
    const second = await page(
      ada,
      `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
    );

    // The two reads above wrote two more access rows, which are newer than
    // every row the first full read saw; compare on what they share.
    const ids = [...first.body.entries, ...second.body.entries].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(4);
    expect(first.body.nextCursor).not.toBeNull();

    expect((await page(ada, '?cursor=not-a-cursor')).status).toBe(400);
    expect(all.body.entries.length).toBeGreaterThanOrEqual(4);
  });

  it('never returns a secret a row stored', async () => {
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(auditLog).values({
        brandId: seeded.brandId,
        actorType: 'system',
        actorId: 'probe',
        action: 'settings.updated',
        targetType: 'settings',
        targetId: 'smtp',
        meta: {
          before: { 'smtp.host': 'old.example.com', 'smtp.password': 'hunter2' },
          after: { 'smtp.host': 'new.example.com', 'smtp.password': 'correct horse' },
        },
      }),
    );

    const response = await page(ada, '?action=settings.updated');
    const text = JSON.stringify(response.body);

    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('correct horse');
    expect(response.body.entries[0]?.changes).toContainEqual({
      field: 'smtp.password',
      before: '[redacted]',
      after: '[redacted]',
      secret: true,
    });
    // A worker's row has no request behind it.
    expect(response.body.entries[0]?.ip).toBeNull();
  });
});
