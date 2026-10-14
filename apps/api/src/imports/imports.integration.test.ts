import { createKeyring, decodeMasterKey, decryptSecret } from '@helpdock/config';
import {
  brands,
  createDb,
  type DbHandle,
  importRuns,
  outbox,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { ImportRateLimiter } from '@helpdock/importers';
import { FakeZendesk } from '@helpdock/importers/testing';
import type { ImportRunView } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { seedDevInstall } from '../seed/dev-seed.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { createZendeskImportConnection } from './jobs/connector-runtime.js';

const masterKey = Buffer.alloc(32, 19).toString('base64');
const password = 'import-test-password';

describe.skipIf(!hasDocker)('M11 staff import HTTP boundary', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let brandId: string;
  let otherBrandId: string;
  let adminToken: string;
  const restrictedTokens: string[] = [];
  let adminId: string;
  const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
  const root = () => `/api/brands/${brandId}/imports`;
  const call = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    token?: string,
    payload?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        'user-agent': 'Helpdock import integration',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  beforeAll(async () => {
    postgres = await startPostgres();
    redisContainer = await startRedis();
    await fake.server.start();
    const env = metaEnv({
      masterKey,
      postgres,
      redis: redisContainer,
      graph: { facebookRoot: fake.server.root, instagramRoot: fake.server.root },
    });
    runtime = await createRuntime({
      env,
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
      }),
    });
    app = await createApiApp({
      runtime,
      imports: {
        connection: (request) =>
          createZendeskImportConnection({
            ...request,
            allowCidrs: [],
            limiter: new ImportRateLimiter({ capacity: 10, perMinute: 1000 }),
            log: async () => {},
            transport: {
              apiRoot: fake.server.root,
              policy: {
                allowedPorts: [Number(new URL(fake.server.root).port)],
                allowCidrs: ['127.0.0.1/32'],
              },
            },
          }),
      },
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    const seeded = await seedDevInstall({ db: runtime.db, env });
    brandId = seeded.brandId;
    otherBrandId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: otherBrandId, name: 'Other import brand', prefix: 'OTH' });
    const key = decodeMasterKey(masterKey);
    if (!key) throw new Error('Invalid test master key');
    const hasher = new PasswordHasher(key);
    for (const role of ['admin', 'agent', 'team_leader', 'viewer'] as const) {
      const id = uuidv7();
      const email = `${role}-${id}@helpdock.test`;
      await owner.db.insert(users).values({
        id,
        email,
        name: `Import ${role}`,
        status: 'active',
        passwordHash: await hasher.hash(password),
      });
      await withSystem(runtime.db, brandId, (tx) =>
        tx
          .insert(userBrandRoles)
          .values({ userId: id, brandId, role, departmentIds: role === 'agent' ? [] : null }),
      );
      const token = await signInForTest(app, { email, password });
      if (role === 'admin') {
        adminToken = token;
        adminId = id;
      } else restrictedTokens.push(token);
    }
  }, 300000);
  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await fake.server.close();
    await redisContainer?.stop();
    await postgres?.stop();
  });

  it('requires real staff authentication and brand management for every registered route', async () => {
    const id = uuidv7();
    const routes = [
      ['GET', root(), undefined],
      ['POST', root(), { source: 'zendesk' }],
      ['GET', `${root()}/${id}`, undefined],
      [
        'PUT',
        `${root()}/${id}/connection`,
        { credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' } },
      ],
      ['POST', `${root()}/${id}/extract`, undefined],
      ['PUT', `${root()}/${id}/scope`, { entities: ['ticket'] }],
      ['POST', `${root()}/${id}/pause`, undefined],
      ['POST', `${root()}/${id}/resume`, undefined],
      ['POST', `${root()}/${id}/cancel`, undefined],
    ] as const;
    for (const [method, url, body] of routes) {
      expect((await call(method, url, undefined, body)).statusCode).toBe(401);
      for (const token of restrictedTokens)
        expect((await call(method, url, token, body)).statusCode).toBe(403);
    }
    const foreign = await call('GET', `/api/brands/${otherBrandId}/imports`, adminToken);
    expect(foreign.statusCode).toBe(403);
    const csrf = await app.inject({
      method: 'POST',
      url: root(),
      headers: { origin: 'https://attacker.example', cookie: '__Secure-hd_refresh=untrusted' },
      payload: { source: 'zendesk' },
    });
    expect(csrf.statusCode).toBe(401);
  });

  it('validates input and serializes a successful verified connection without returning secrets', async () => {
    expect(
      (await call('POST', root(), adminToken, { source: 'zendesk', mode: 'delta' })).statusCode,
    ).toBe(400);
    const created = await call('POST', root(), adminToken, { source: 'zendesk' });
    expect(created.statusCode).toBe(201);
    const run = created.json<ImportRunView>();
    expect(
      (
        await call('PUT', `${root()}/${run.id}/connection`, adminToken, {
          credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' },
          downloadHosts: ['*.example.com'],
        })
      ).statusCode,
    ).toBe(400);
    const scoped = await call('PUT', `${root()}/${run.id}/scope`, adminToken, {
      entities: ['ticket', 'contact'],
      rebuildAllReports: true,
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({
      scope: { entities: ['ticket', 'contact'], rebuildAllReports: true },
    });
    expect(
      (
        await call('PUT', `${root()}/${run.id}/scope`, adminToken, {
          entities: ['ticket', 'ticket'],
        })
      ).statusCode,
    ).toBe(400);
    const connected = await call('PUT', `${root()}/${run.id}/connection`, adminToken, {
      credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' },
      downloadHosts: [],
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      account: 'demo',
      run: {
        hasCredentials: true,
        status: 'connecting',
        scope: { entities: ['ticket', 'contact'], rebuildAllReports: true },
      },
    });
    expect(connected.body).not.toContain('synthetic-token');
    const [stored] = await owner.db.select().from(importRuns).where(eq(importRuns.id, run.id));
    if (!stored?.credentialsEncrypted) throw new Error('Missing encrypted credentials');
    expect(
      JSON.parse(
        decryptSecret(stored.credentialsEncrypted, createKeyring({ APP_MASTER_KEY: masterKey })),
      ),
    ).toMatchObject({ accessToken: 'synthetic-token' });
    const extracted = await call('POST', `${root()}/${run.id}/extract`, adminToken);
    expect(extracted.statusCode).toBe(200);
    expect(extracted.json()).toMatchObject({ status: 'extracting' });
    expect((await call('POST', `${root()}/${run.id}/extract`, adminToken)).statusCode).toBe(409);
    const events = await owner.db
      .select()
      .from(outbox)
      .where(sql`${outbox.payload}->>'runId' = ${run.id}`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'import.work_requested',
      payload: { runId: run.id, step: 'extract' },
    });
    expect(
      (await call('PUT', `${root()}/${run.id}/scope`, adminToken, { entities: ['ticket'] }))
        .statusCode,
    ).toBe(409);
    const claim = uuidv7();
    await owner.db
      .update(importRuns)
      .set({ claimToken: claim, claimedAt: new Date() })
      .where(eq(importRuns.id, run.id));
    const paused = await call('POST', `${root()}/${run.id}/pause`, adminToken);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ status: 'paused', hasCredentials: true });
    const [pausedRow] = await owner.db.select().from(importRuns).where(eq(importRuns.id, run.id));
    expect(pausedRow).toMatchObject({
      claimToken: null,
      claimedAt: null,
      pausedFrom: 'extracting',
    });
    expect((await call('POST', `${root()}/${run.id}/resume`, adminToken)).statusCode).toBe(200);
    expect(
      await owner.db.select().from(outbox).where(sql`${outbox.payload}->>'runId' = ${run.id}`),
    ).toHaveLength(2);
    const cancelled = await call('POST', `${root()}/${run.id}/cancel`, adminToken);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', hasCredentials: false });
    expect((await call('POST', `${root()}/${run.id}/resume`, adminToken)).statusCode).toBe(409);
    const [cancelledRow] = await owner.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, run.id));
    expect(cancelledRow).toMatchObject({
      credentialsEncrypted: null,
      claimToken: null,
      pausedFrom: null,
    });
    const listed = await call('GET', root(), adminToken);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain('synthetic-token');
    await owner.db
      .insert(importRuns)
      .values({ id: uuidv7(), brandId: otherBrandId, source: 'zendesk', startedBy: adminId });
    const [foreign] = await owner.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.brandId, otherBrandId));
    if (!foreign) throw new Error('Missing foreign run');
    expect((await call('GET', `${root()}/${foreign.id}`, adminToken)).statusCode).toBe(404);
  });
  it('rolls back an unavailable dry-run resume rather than releasing a paused run with no consumer', async () => {
    const created = await call('POST', root(), adminToken, { source: 'zendesk' });
    expect(created.statusCode).toBe(201);
    const run = created.json<ImportRunView>();
    const connected = await call('PUT', `${root()}/${run.id}/connection`, adminToken, {
      credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' },
    });
    expect(connected.statusCode).toBe(200);
    await owner.db
      .update(importRuns)
      .set({ status: 'paused', pausedFrom: 'dry_run' })
      .where(eq(importRuns.id, run.id));
    expect((await call('POST', `${root()}/${run.id}/resume`, adminToken)).statusCode).toBe(409);
    expect((await call('GET', `${root()}/${run.id}`, adminToken)).json()).toMatchObject({
      status: 'paused',
      hasCredentials: true,
    });
    expect(
      await owner.db.select().from(outbox).where(sql`${outbox.payload}->>'runId' = ${run.id}`),
    ).toEqual([]);
    expect((await call('POST', `${root()}/${run.id}/cancel`, adminToken)).statusCode).toBe(200);
  });
});
