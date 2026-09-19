import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  type Db,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  UnsafeRuntimeRoleError,
  userBrandRoles,
  users,
  uuidv7,
} from '@helpdock/db';
import type { Principal } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from './auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from './bootstrap.js';
import { REQUEST_ID_HEADER } from './context/request-id.js';
import { createLogger } from './logging/logger.js';
import { INSTALL_SCOPE_ACTION } from './tenant/install-scope.js';
import { withSystemJob } from './tenant/system-job.js';
import { ProbeController, type SessionSettings } from './testing/probe.controller.js';

/**
 * The negative suite of DOMAIN-RULES §1.6, run at the HTTP layer: a real
 * Postgres with the real policies, a real Redis, the real guards and the real
 * interceptor. The unit tests prove each piece decides correctly; this proves
 * the pieces are wired to each other and to the database.
 */

// The images ARCHITECTURE §17 runs in production.
const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';

const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  // Written straight to stderr: Vitest drops console output from a file whose
  // suites are all skipped, and an operator who runs the integration project
  // without Docker deserves to be told why nothing ran.
  process.stderr.write(
    'Skipping the api integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const BRAND_A = uuidv7();
const BRAND_B = uuidv7();
const DEPARTMENT_1 = uuidv7();
const DEPARTMENT_2 = uuidv7();

/**
 * A stand-in for `apps/admin/dist`, written here rather than built, so the suite
 * proves what the api does with a build and never depends on one existing.
 */
const HASHED_ASSET = 'assets/index-Abc12345.js';
/** Stands in for the `lang`/`dir` bootstrap the real index.html runs inline. */
const INLINE_BOOTSTRAP = "document.documentElement.lang = 'en';";
const VERIFIED_DOMAIN = 'support.acme.example';
const UNVERIFIED_DOMAIN = 'pending.globex.example';
const WIDGET_ORIGIN = 'shop.globex.example';
const adminDist = mkdtempSync(path.join(tmpdir(), 'helpdock-admin-'));
mkdirSync(path.join(adminDist, 'assets'), { recursive: true });
writeFileSync(
  path.join(adminDist, 'index.html'),
  '<!doctype html><html><head>' +
    '<meta name="helpdock:primary-domain" content="support.helpdock.com" />' +
    '<meta name="helpdock:brand-count" content="3" />' +
    `<script>${INLINE_BOOTSTRAP}</script>` +
    `</head><body><script type="module" src="/${HASHED_ASSET}"></script></body></html>`,
);
writeFileSync(path.join(adminDist, HASHED_ASSET), 'console.log("admin");\n');
writeFileSync(path.join(adminDist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" />');

const staffPrincipal = (
  id: string,
  brandRoles: Record<
    string,
    { role: 'admin' | 'team_leader' | 'agent' | 'viewer'; departmentIds: string[] | 'all' }
  >,
  installAdmin = false,
): Principal => ({ type: 'staff', id, brands: brandRoles, installAdmin });

const asPrincipal = (principal: Principal): Record<string, string> => ({
  [DEV_PRINCIPAL_HEADER]: JSON.stringify(principal),
});

describe.skipIf(!hasDocker)('the api', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;

  const adminA = uuidv7();
  const agentA = uuidv7();
  const adminB = uuidv7();
  const installAdmin = uuidv7();

  const ownerUrlFor = (database: string): string =>
    `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/${database}`;

  const appUrlFor = (database: string): string =>
    `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${database}`;

  const envFor = (overrides: Partial<Env> = {}): Env =>
    ({
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: appUrlFor('helpdock'),
      DATABASE_MIGRATION_URL: ownerUrlFor('helpdock'),
      REDIS_URL: redis.getConnectionUrl(),
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      ADMIN_DIST_DIR: adminDist,
      OUTBOUND_ALLOW_CIDRS: [],
      ...overrides,
    }) as Env;

  const silentLogger = () =>
    createLogger({
      env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'info' },
      level: 'silent',
    });

  const createDatabase = async (name: string): Promise<void> => {
    await owner.db.execute(sql.raw(`CREATE DATABASE ${name}`));
  };

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: path, headers });

  beforeAll(async () => {
    // The dev principal resolver is the only way to authenticate before M0-05.
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';

    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await createDatabase('helpdock');

    runtime = await createRuntime({ env: envFor(), logger: silentLogger() });
    app = await createApiApp({ runtime, extraControllers: [ProbeController] });

    await seed(runtime.db);
  });

  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  /** Two brands, four staff rows, and a role row per membership to read back through RLS. */
  const seed = async (db: Db): Promise<void> => {
    await db.insert(brands).values([
      { id: BRAND_A, name: 'Acme', prefix: 'ACME' },
      { id: BRAND_B, name: 'Globex', prefix: 'GLOBEX' },
    ]);

    await db.insert(users).values([
      { id: adminA, email: 'admin-a@example.com', name: 'Admin A', status: 'active' },
      { id: agentA, email: 'agent-a@example.com', name: 'Agent A', status: 'active' },
      { id: adminB, email: 'admin-b@example.com', name: 'Admin B', status: 'active' },
      {
        id: installAdmin,
        email: 'install@example.com',
        name: 'Install Admin',
        status: 'active',
        installAdmin: true,
      },
    ]);

    // Written as the system principal for each brand, which is the only context
    // that may write rows for a brand outside a request (DOMAIN-RULES §1.4).
    await withSystemJob(db, BRAND_A, 'seed', (tx) =>
      tx.insert(userBrandRoles).values([
        { userId: adminA, brandId: BRAND_A, role: 'admin' },
        { userId: agentA, brandId: BRAND_A, role: 'agent', departmentIds: [DEPARTMENT_1] },
      ]),
    );
    await withSystemJob(db, BRAND_B, 'seed', (tx) =>
      tx.insert(userBrandRoles).values([{ userId: adminB, brandId: BRAND_B, role: 'admin' }]),
    );
  };

  describe('the probes', () => {
    it('answers /health without a principal', async () => {
      const response = await get('/health');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', uptimeSeconds: expect.any(Number) });
    });

    it('answers /ready with every dependency up', async () => {
      const response = await get('/ready');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'ready',
        checks: [
          { name: 'database', status: 'up' },
          { name: 'redis', status: 'up' },
          { name: 'settings', status: 'up' },
        ],
      });
    });
  });

  describe('the admin SPA', () => {
    it('serves index.html with the install meta tags rewritten, and never caches it', async () => {
      const response = await get('/');

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toBe('no-store');
      // Two seeded brands, neither with a verified help-center domain yet, so
      // the caption falls back to the host APP_URL names.
      expect(response.body).toContain('<meta name="helpdock:brand-count" content="2" />');
      expect(response.body).toContain(
        '<meta name="helpdock:primary-domain" content="support.example.com" />',
      );
    });

    it('replaces the JSON deny-all policy with one the SPA can load under', async () => {
      const policy = (await get('/')).headers['content-security-policy'] ?? '';

      // A browser refuses the inline bootstrap without its hash, and the whole
      // bundle without `script-src 'self'`.
      expect(policy).toContain(
        `script-src 'self' 'sha256-${createHash('sha256').update(INLINE_BOOTSTRAP, 'utf8').digest('base64')}'`,
      );
      expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(policy).toContain("frame-ancestors 'none'");
    });

    it('leaves the deny-all policy on an api response', async () => {
      expect((await get('/health')).headers['content-security-policy']).toBe(
        "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
      );
    });

    it('serves a hashed asset as immutable', async () => {
      const response = await get(`/${HASHED_ASSET}`);

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(response.body).toContain('console.log');
    });

    it('serves an unhashed file for an hour', async () => {
      expect((await get('/favicon.svg')).headers['cache-control']).toBe('public, max-age=3600');
    });

    it('falls back to index.html for a client-side route', async () => {
      const response = await get('/tickets/42');

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });

    it('answers a missing endpoint under /api as JSON, not as the SPA', async () => {
      const response = await get('/api/not-a-route');

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    });

    it('refuses to walk out of the build directory', async () => {
      const response = await get('/assets/..%2f..%2f..%2fetc%2fpasswd');

      // The SPA fallback is the safe answer: never a file from outside the root.
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });
  });

  describe('the on-demand TLS check Caddy calls', () => {
    const seedDomain = (
      brandId: string,
      domain: string,
      kind: 'helpcenter' | 'widget_origin',
      verified: boolean,
    ) =>
      withSystemJob(runtime.db, brandId, 'seed-domain', (tx) =>
        tx.insert(brandDomains).values({
          brandId,
          domain,
          kind,
          txtToken: 'helpdock-verification=seeded',
          ...(verified ? { verifiedAt: new Date() } : {}),
        }),
      );

    it('refuses a domain nobody added', async () => {
      expect((await get('/internal/domain-check?domain=nope.example')).statusCode).toBe(403);
    });

    it('refuses a domain that is not verified yet', async () => {
      await seedDomain(BRAND_B, UNVERIFIED_DOMAIN, 'helpcenter', false);

      expect((await get(`/internal/domain-check?domain=${UNVERIFIED_DOMAIN}`)).statusCode).toBe(
        403,
      );
    });

    it('refuses a widget origin, which is an allow-list entry and not a host we serve', async () => {
      await seedDomain(BRAND_B, WIDGET_ORIGIN, 'widget_origin', true);

      expect((await get(`/internal/domain-check?domain=${WIDGET_ORIGIN}`)).statusCode).toBe(403);
    });

    it('refuses a malformed domain before it reaches the database', async () => {
      expect((await get('/internal/domain-check?domain=not a domain')).statusCode).toBe(400);
      expect((await get('/internal/domain-check')).statusCode).toBe(400);
    });

    it('allows a verified help center domain, whatever case Caddy passes through', async () => {
      await seedDomain(BRAND_A, VERIFIED_DOMAIN, 'helpcenter', true);

      const response = await get(`/internal/domain-check?domain=${VERIFIED_DOMAIN}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ domain: VERIFIED_DOMAIN });

      // A trailing dot and upper case are both legal in a ServerName.
      expect(
        (await get(`/internal/domain-check?domain=${VERIFIED_DOMAIN.toUpperCase()}.`)).statusCode,
      ).toBe(200);
    });

    it('names that brand domain as the install primary domain once it is verified', async () => {
      // Runs after the case above, which is what verifies BRAND_A's domain.
      expect((await get('/')).body).toContain(
        `<meta name="helpdock:primary-domain" content="${VERIFIED_DOMAIN}" />`,
      );
    });
  });

  describe('security headers and the request id', () => {
    it('sends the headers REQUIREMENTS §5.1 asks for', async () => {
      const response = await get('/health');

      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
      );
      expect(response.headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });

    it('echoes a request id, and does not take one from an untrusted client', async () => {
      const response = await get('/health', { [REQUEST_ID_HEADER]: 'client-chosen' });

      expect(response.headers[REQUEST_ID_HEADER]).toBeDefined();
      expect(response.headers[REQUEST_ID_HEADER]).not.toBe('client-chosen');
    });
  });

  describe('authentication', () => {
    it('refuses a route that needs a principal', async () => {
      const response = await get('/api/me');

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'unauthenticated', requestId: expect.any(String) },
      });
    });

    it('answers /api/me with the principal the resolver produced', async () => {
      const principal = staffPrincipal(adminA, {
        [BRAND_A]: { role: 'admin', departmentIds: 'all' },
      });

      const response = await get('/api/me', asPrincipal(principal));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ principal });
    });

    it('refuses a dev header that is not a principal', async () => {
      const response = await get('/api/me', { [DEV_PRINCIPAL_HEADER]: '{"type":"root"}' });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('the tenant transaction', () => {
    it("carries an agent's departments into the session settings", async () => {
      const response = await get(
        '/probe/session',
        asPrincipal(
          staffPrincipal(agentA, {
            [BRAND_A]: { role: 'agent', departmentIds: [DEPARTMENT_1, DEPARTMENT_2] },
          }),
        ),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json<SessionSettings>()).toEqual({
        brandIds: `{${BRAND_A}}`,
        departmentIds: `{${DEPARTMENT_1},${DEPARTMENT_2}}`,
        allDepartments: 'false',
        principalType: 'staff',
        principalId: agentA,
      });
    });

    it('names one brand even when the principal holds two', async () => {
      const response = await get(
        `/probe/session?brandId=ignored`,
        asPrincipal(
          staffPrincipal(adminA, {
            [BRAND_A]: { role: 'admin', departmentIds: 'all' },
            [BRAND_B]: { role: 'admin', departmentIds: 'all' },
          }),
        ),
      );

      // Two brands and no `:brandId`: the route acts on one brand and the
      // request does not name one.
      expect(response.statusCode).toBe(400);
    });

    it('lets a brand-scoped read see only that brand through the policies', async () => {
      // `select().from(user_brand_roles)` with no `where`: everything the query
      // leaves out, the policies have to leave out. Brand B has a role row too.
      const response = await get(
        '/probe/roles',
        asPrincipal(staffPrincipal(adminA, { [BRAND_A]: { role: 'admin', departmentIds: 'all' } })),
      );

      expect(response.statusCode).toBe(200);
      const { brandIds } = response.json<{ brandIds: string[] }>();
      expect(brandIds.length).toBeGreaterThan(0);
      expect([...new Set(brandIds)]).toEqual([BRAND_A]);
    });

    it('lets brand B see its own role rows and no others', async () => {
      const response = await get(
        '/probe/roles',
        asPrincipal(staffPrincipal(adminB, { [BRAND_B]: { role: 'admin', departmentIds: 'all' } })),
      );

      expect([...new Set(response.json<{ brandIds: string[] }>().brandIds)]).toEqual([BRAND_B]);
    });

    it('rolls the whole request back when the handler throws', async () => {
      const response = await get(
        '/probe/rollback',
        asPrincipal(staffPrincipal(adminA, { [BRAND_A]: { role: 'admin', departmentIds: 'all' } })),
      );

      expect(response.statusCode).toBe(500);
      const requestId = response.headers[REQUEST_ID_HEADER];
      expect(response.json()).toEqual({
        error: {
          code: 'internal_error',
          message: 'The request could not be completed',
          requestId,
        },
      });

      const rows = await withSystemJob(runtime.db, BRAND_A, 'assert', (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, 'probe.rollback')),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('cross-brand access (DOMAIN-RULES §1.6)', () => {
    const brandAAdmin = () =>
      asPrincipal(staffPrincipal(adminA, { [BRAND_A]: { role: 'admin', departmentIds: 'all' } }));

    it('lets a brand admin read their own brand', async () => {
      const response = await get(`/api/brands/${BRAND_A}`, brandAAdmin());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: BRAND_A,
        name: 'Acme',
        prefix: 'ACME',
        defaultLocale: 'en',
        timezone: 'UTC',
        status: 'active',
      });
    });

    it("refuses brand A's staff on brand B", async () => {
      const response = await get(`/api/brands/${BRAND_B}`, brandAAdmin());

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
    });

    it('lists only the brands the principal holds a role in', async () => {
      const response = await get(
        '/api/brands',
        asPrincipal(staffPrincipal(adminA, { [BRAND_A]: { role: 'admin', departmentIds: 'all' } })),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json<{ brands: { id: string }[] }>().brands.map((brand) => brand.id)).toEqual(
        [BRAND_A],
      );
    });

    it('lists nothing, and opens no transaction, for a principal with no role yet', async () => {
      // The install admin the wizard creates before the first brand exists.
      const response = await get(
        '/api/brands',
        asPrincipal(staffPrincipal(installAdmin, {}, true)),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ brands: [] });
    });

    it('answers 404 for a brand the principal claims a role in but that does not exist', async () => {
      const missing = uuidv7();

      const response = await get(
        `/api/brands/${missing}`,
        asPrincipal(staffPrincipal(adminA, { [missing]: { role: 'admin', departmentIds: 'all' } })),
      );

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    });

    it('refuses a brand id that is not a uuid', async () => {
      const response = await get('/api/brands/not-a-uuid', brandAAdmin());

      expect(response.statusCode).toBe(400);
    });

    it('refuses a viewer on a route that needs a write permission', async () => {
      const response = await get(
        '/probe/rollback',
        asPrincipal(
          staffPrincipal(agentA, { [BRAND_A]: { role: 'viewer', departmentIds: 'all' } }),
        ),
      );

      expect(response.statusCode).toBe(403);
    });
  });

  describe('install scope', () => {
    const notInstallAdmin = () =>
      asPrincipal(staffPrincipal(adminA, { [BRAND_A]: { role: 'admin', departmentIds: 'all' } }));

    const asInstallAdmin = () => asPrincipal(staffPrincipal(installAdmin, {}, true));

    it('refuses a brand admin who is not an install admin', async () => {
      const response = await get('/api/install/brands', notInstallAdmin());

      expect(response.statusCode).toBe(403);
    });

    it('lets an install admin see every brand', async () => {
      const response = await get('/api/install/brands', asInstallAdmin());

      expect(response.statusCode).toBe(200);
      expect(
        response
          .json<{ brands: { id: string }[] }>()
          .brands.map((brand) => brand.id)
          .sort(),
      ).toEqual([BRAND_A, BRAND_B].sort());
    });

    it('writes an audit row for the access, under the install scope', async () => {
      const response = await get('/api/install/brands', asInstallAdmin());
      const requestId = response.headers[REQUEST_ID_HEADER];

      const rows = await withSystemJob(runtime.db, INSTALL_SCOPE_BRAND_ID, 'assert', (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(
            and(eq(auditLog.action, INSTALL_SCOPE_ACTION), eq(auditLog.actorId, installAdmin)),
          ),
      );

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.at(-1)).toMatchObject({
        brandId: INSTALL_SCOPE_BRAND_ID,
        actorType: 'staff',
        targetType: 'route',
        targetId: 'GET /api/install/brands',
        meta: { requestId },
      });
    });

    it('refuses a brand route that names the install scope, however the principal claims it', async () => {
      // The sentinel is a valid UUID, so a caller who controls the principal
      // could otherwise ask for a brand-scoped transaction over install-wide
      // `settings` and `audit_log` rows without ever passing the install gate.
      const response = await get(
        `/api/brands/${INSTALL_SCOPE_BRAND_ID}`,
        asPrincipal(
          staffPrincipal(adminA, {
            [INSTALL_SCOPE_BRAND_ID]: { role: 'admin', departmentIds: 'all' },
          }),
        ),
      );

      expect(response.statusCode).toBe(400);
    });

    it('writes no audit row when the caller was refused', async () => {
      await get('/api/install/brands', notInstallAdmin());

      const rows = await withSystemJob(runtime.db, INSTALL_SCOPE_BRAND_ID, 'assert', (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.actorId, adminA)),
      );

      expect(rows).toEqual([]);
    });
  });

  describe('boot', () => {
    it('refuses to serve as a role that can bypass row-level security', async () => {
      await expect(
        createRuntime({
          env: envFor({
            // A worker does not migrate, so this reaches the role check rather
            // than failing earlier on `DATABASE_URL must connect as helpdock_app`.
            APP_ROLE: 'worker',
            DATABASE_URL: ownerUrlFor('helpdock'),
            DATABASE_MIGRATION_URL: ownerUrlFor('helpdock'),
          }),
          logger: silentLogger(),
        }),
      ).rejects.toThrow(UnsafeRuntimeRoleError);
    });

    it('logs which database role it verified, without colliding with APP_ROLE', async () => {
      const lines: Record<string, unknown>[] = [];
      const collecting = createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'info' },
        level: 'info',
        destination: {
          write: (line: string) => {
            lines.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      });

      const booted = await createRuntime({ env: envFor(), logger: collecting });
      await booted.close();

      const verified = lines.find((line) => line.msg?.toString().startsWith('Runtime database'));
      expect(verified).toMatchObject({
        role: 'api',
        databaseRole: 'helpdock_app',
        superuser: false,
        bypassRls: false,
        ownedTables: 0,
      });
    });

    it('refuses an api boot whose DATABASE_URL is not the runtime role', async () => {
      await expect(
        createRuntime({
          env: envFor({ DATABASE_URL: ownerUrlFor('helpdock') }),
          logger: silentLogger(),
        }),
      ).rejects.toThrow(/must connect as helpdock_app/);
    });

    it('applies each migration once when two replicas boot at the same time', async () => {
      await createDatabase('two_replicas');
      const env = envFor({
        DATABASE_URL: appUrlFor('two_replicas'),
        DATABASE_MIGRATION_URL: ownerUrlFor('two_replicas'),
      });

      const runtimes = await Promise.all([
        createRuntime({ env, logger: silentLogger() }),
        createRuntime({ env, logger: silentLogger() }),
      ]);

      try {
        const ownerHandle = createDb({ url: ownerUrlFor('two_replicas'), max: 1 });
        try {
          const applied = await ownerHandle.db.execute(
            sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
          );
          const journal = await ownerHandle.db.execute(
            sql`SELECT count(DISTINCT hash)::int AS count FROM drizzle.__drizzle_migrations`,
          );

          expect(applied[0]).toEqual(journal[0]);
        } finally {
          await ownerHandle.close();
        }
      } finally {
        await Promise.all(runtimes.map((each) => each.close()));
      }
    });
  });
});

describe.skipIf(!hasDocker)('/ready when Redis is gone', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);

    runtime = await createRuntime({
      env: {
        APP_URL: 'http://localhost:3000',
        APP_ROLE: 'api',
        APP_MASTER_KEY: MASTER_KEY,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
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
        ADMIN_DIST_DIR: adminDist,
        OUTBOUND_ALLOW_CIDRS: [],
      } as Env,
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'info' },
        level: 'silent',
      }),
    });
    app = await createApiApp({ runtime });
  });

  afterAll(async () => {
    await app?.close();
    // Redis is already gone, so the runtime's own close would hang on `quit`.
    await postgres?.stop();
  });

  it('reports not ready, with the failing dependency named', async () => {
    await redis.stop();

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    const body = response.json<{ status: string; checks: { name: string; status: string }[] }>();
    expect(body.status).toBe('not_ready');
    expect(body.checks).toContainEqual(expect.objectContaining({ name: 'redis', status: 'down' }));
    expect(body.checks).toContainEqual(expect.objectContaining({ name: 'database', status: 'up' }));
  });
});
