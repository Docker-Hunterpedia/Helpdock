import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as waitForQueue } from 'node:timers/promises';
import { createKeyring, decodeMasterKey, decryptSecret } from '@helpdock/config';
import {
  accounts,
  brands,
  contactIdentities,
  contacts,
  createDb,
  type DbHandle,
  importExternalIds,
  importFiles,
  importLog,
  importMappings,
  importRecords,
  importRuns,
  importTicketInventory,
  outbox,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { hashImportValue, ImportRateLimiter } from '@helpdock/importers';
import {
  FakeFreshdesk,
  FakeZendesk,
  FakeZoho,
  freshdeskCoreFixture,
  zohoCoreFixture,
} from '@helpdock/importers/testing';
import { JOB_DEFINITIONS, silentLogger as silentJobLogger } from '@helpdock/jobs';
import {
  contentPolicySchema,
  freshdeskCredentialsSchema,
  type ImportRunView,
  importRecordSchema,
  zendeskCredentialsSchema,
  zohoCredentialsSchema,
} from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import {
  IMPORT_HEALTH_KEY,
  IMPORT_HEALTH_TTL_SECONDS,
  publishImportHealthSnapshot,
  readImportHealth,
  writeImportHealth,
  writeImportHealthBrand,
} from '../observability/import-health.js';
import { seedDevInstall } from '../seed/dev-seed.js';
import { FakeStorage } from '../testing/media.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { createImportWorkHandler } from './import-events.js';
import { readBrandImportHealth } from './import-health.js';
import {
  createFreshdeskImportConnection,
  createImportConnectorRuntime,
  createZendeskImportConnection,
  createZohoImportConnection,
} from './jobs/connector-runtime.js';
import { importDestinationFingerprint } from './jobs/destination-fingerprint.js';
import { importDryRunCheckpointSchema } from './jobs/dry-run-state.js';
import { createImportProcessor } from './jobs/import-processor.js';
import { importInputFingerprint } from './jobs/input-fingerprint.js';
import { prepareImportSourceFile } from './jobs/prepare-source-file.js';
import { importVendorSourceWarnings } from './jobs/vendor-source-warnings.js';

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
  let installToken: string;
  const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
  const freshdesk = new FakeFreshdesk(freshdeskCoreFixture, {
    authorization: `Basic ${Buffer.from('synthetic-key:X').toString('base64')}`,
    now: 0,
  });
  const zoho = new FakeZoho(structuredClone(zohoCoreFixture));
  let storage: FakeStorage;
  let storageDirectory: string;
  const root = () => `/api/brands/${brandId}/imports`;
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
    await freshdesk.server.start();
    await zoho.start();
    storageDirectory = await mkdtemp(join(tmpdir(), 'helpdock-inventory-http-'));
    storage = new FakeStorage(storageDirectory);
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
        storage,
        connection: (request, source) => {
          const apiRoot =
            source === 'zohodesk'
              ? zoho.root
              : source === 'freshdesk'
                ? freshdesk.server.root
                : fake.server.root;
          const common = {
            ...request,
            allowCidrs: [],
            limiter: new ImportRateLimiter({
              capacity: source === 'zohodesk' ? 20 : 10,
              perMinute: 1000,
            }),
            log: async () => {},
            transport: {
              apiRoot,
              policy: {
                allowedPorts: [Number(new URL(apiRoot).port)],
                allowCidrs: ['127.0.0.1/32'],
              },
            },
          };
          return source === 'zohodesk'
            ? createZohoImportConnection({
                ...common,
                credentials: zohoCredentialsSchema.parse(request.credentials),
              })
            : source === 'freshdesk'
              ? createFreshdeskImportConnection({
                  ...common,
                  credentials: freshdeskCredentialsSchema.parse(request.credentials),
                })
              : createZendeskImportConnection({
                  ...common,
                  credentials: zendeskCredentialsSchema.parse(request.credentials),
                });
        },
      },
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    const seeded = await seedDevInstall({ db: runtime.db, env });
    installToken = await signInForTest(app, { email: seeded.email, password: seeded.password });
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
    await freshdesk.server.close();
    await zoho.close();
    if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true });
    await redisContainer?.stop();
    await postgres?.stop();
  });

  it('starts automatic Zoho extraction without a CSV and refuses an unreviewed inventory opt-in', async () => {
    const created = await call('POST', root(), adminToken, { source: 'zohodesk' });
    expect(created.statusCode).toBe(201);
    const run = created.json<ImportRunView>();
    const path = `${root()}/${run.id}`;
    const credentials = {
      region: 'us',
      orgId: zoho.fixture.orgId,
      clientId: zoho.fixture.clientId,
      clientSecret: zoho.fixture.clientSecret,
      refreshToken: zoho.fixture.refreshToken,
    };
    const connected = await call('PUT', `${path}/connection`, adminToken, { credentials });
    expect(connected.statusCode).toBe(200);
    expect(connected.json().run).toMatchObject({
      sourceAccount: `us:${zoho.fixture.orgId}`,
      hasCredentials: true,
    });
    expect(JSON.stringify(connected.json())).not.toContain(credentials.refreshToken);
    expect(JSON.stringify(connected.json())).not.toContain(credentials.clientSecret);
    expect((await call('GET', `${path}/files`, adminToken)).json().files).toEqual([]);
    const optingIn = await call('PUT', `${path}/scope`, adminToken, {
      entities: ['ticket'],
      useTicketInventory: true,
      inventoryMode: 'complete',
      inventoryConfirmed: false,
    });
    expect(optingIn.statusCode).toBe(200);
    const unreviewed = await call('POST', `${path}/extract`, adminToken);
    expect(unreviewed.statusCode).toBe(409);
    expect(unreviewed.json().error.message).toBe('import.inventory-confirm-required');
    expect(
      (
        await call('PUT', `${path}/scope`, adminToken, {
          entities: ['ticket'],
          useTicketInventory: true,
          inventoryMode: 'complete',
          inventoryConfirmed: true,
        })
      ).statusCode,
    ).toBe(409);
    const automatic = await call('PUT', `${path}/scope`, adminToken, {
      entities: ['ticket', 'message', 'attachment', 'tag'],
      useTicketInventory: false,
    });
    expect(automatic.statusCode).toBe(200);
    expect(automatic.json().scope).toMatchObject({
      useTicketInventory: false,
      inventoryConfirmed: false,
    });
    const extracting = await call('POST', `${path}/extract`, adminToken);
    expect(extracting.statusCode).toBe(200);
    expect(extracting.json().status).toBe('extracting');
    const [stored] = await owner.db.select().from(importRuns).where(eq(importRuns.id, run.id));
    expect(stored?.options.inventoryReviewFingerprint).toBeNull();
    expect(
      await owner.db.select().from(importRecords).where(eq(importRecords.runId, run.id)),
    ).toEqual([]);
    expect((await call('POST', `${path}/cancel`, adminToken)).statusCode).toBe(200);
  });

  it('requires real staff authentication and brand management for every registered route', async () => {
    const id = uuidv7();
    const routes = [
      ['GET', root(), undefined],
      ['POST', root(), { source: 'zendesk' }],
      ['GET', `${root()}/${id}`, undefined],
      ['GET', `${root()}/${id}/preview/ticket?externalId=42`, undefined],
      ['GET', `${root()}/${id}/preview/contact?externalId=42`, undefined],
      ['GET', `${root()}/${id}/preview/samples`, undefined],
      ['GET', `${root()}/${id}/log`, undefined],
      ['GET', `${root()}/${id}/log/export`, undefined],
      ['GET', `${root()}/${id}/sla`, undefined],
      ['POST', `${root()}/${id}/sla/start`, { acknowledge: true }],
      [
        'PUT',
        `${root()}/${id}/connection`,
        { credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' } },
      ],
      ['POST', `${root()}/${id}/extract`, undefined],
      ['POST', `${root()}/${id}/dry-run`, {}],
      ['POST', `${root()}/${id}/start`, { reviewToken: 'a'.repeat(64) }],
      ['GET', `${root()}/${id}/dry-run`, undefined],
      ['PUT', `${root()}/${id}/scope`, { entities: ['ticket'] }],
      ['POST', `${root()}/${id}/pause`, undefined],
      ['POST', `${root()}/${id}/resume`, undefined],
      ['POST', `${root()}/${id}/cancel`, undefined],
      ['GET', `${root()}/${id}/mappings`, undefined],
      ['PUT', `${root()}/${id}/mappings`, { mappings: [] }],
      ['GET', `${root()}/${id}/files`, undefined],
      ['GET', `${root()}/${id}/files/${id}`, undefined],
      ['PUT', `${root()}/${id}/file-source`, { dataset: 'source-export' }],
      [
        'POST',
        `${root()}/${id}/files/presign`,
        { format: 'csv', entity: 'ticket', fileName: 'source.csv', size: 12 },
      ],
      ['POST', `${root()}/${id}/files/${id}/confirm`, undefined],
      [
        'PUT',
        `${root()}/${id}/files/${id}/inventory-mapping`,
        { mapping: { idColumn: 'ID', location: 'auto' } },
      ],
      ['DELETE', `${root()}/${id}/files/${id}`, undefined],
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

  it('reports worker-cached import health only to install admins and expires unknown readings instead of reporting zero', async () => {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', status: 'failed', startedBy: adminId });
    await owner.db
      .insert(importLog)
      .values({ brandId, runId, level: 'error', message: 'import.vendor-unavailable' });
    const health = await withSystem(runtime.db, brandId, (tx) =>
      readBrandImportHealth(tx, brandId),
    );
    expect(health?.lastError).toMatchObject({ runId, code: 'import.vendor-unavailable' });
    if (!health) throw new Error('Missing import health fixture');
    await writeImportHealth(runtime.redis, {
      configured: true,
      observedAt: new Date().toISOString(),
      totalBrands: 1,
      active: health.active,
      paused: health.paused,
      brands: [health],
    });
    expect(await runtime.redis.ttl(IMPORT_HEALTH_KEY)).toBeGreaterThan(0);
    expect(await runtime.redis.ttl(IMPORT_HEALTH_KEY)).toBeLessThanOrEqual(
      IMPORT_HEALTH_TTL_SECONDS,
    );
    expect((await call('GET', '/api/install/system', adminToken)).statusCode).toBe(403);
    const status = await call('GET', '/api/install/system', installToken);
    expect(status.statusCode).toBe(200);
    expect(status.json<{ imports: { brands: unknown[] } }>().imports.brands).toEqual([health]);
    await runtime.redis.del(IMPORT_HEALTH_KEY);
    expect(await readImportHealth(runtime.redis)).toEqual({ configured: false });
  });

  it('pages immutable install snapshots beyond fifty brands and refuses partial or expired readings', async () => {
    const snapshotId = uuidv7();
    const newerId = uuidv7();
    const rows = Array.from({ length: 57 }, (_, index) => ({
      brandId: uuidv7(),
      brandName: `Snapshot brand ${index}`,
      active: 57 - index,
      paused: 0,
      lastError: null,
    }));
    const summary = {
      configured: true as const,
      snapshotId,
      observedAt: new Date().toISOString(),
      totalBrands: rows.length,
      active: rows.reduce((sum, row) => sum + row.active, 0),
      paused: 0,
      brands: rows.slice(0, 50),
    };
    const keys = [
      IMPORT_HEALTH_KEY,
      ...[snapshotId, newerId].flatMap((id) => [
        `${IMPORT_HEALTH_KEY}:${id}:data`,
        `${IMPORT_HEALTH_KEY}:${id}:order`,
      ]),
    ];
    const pageUrl = `/api/install/system/imports?snapshotId=${snapshotId}&page=2`;
    try {
      await writeImportHealthBrand(runtime.redis, snapshotId, rows[0]!);
      await expect(publishImportHealthSnapshot(runtime.redis, summary)).rejects.toThrow(
        'import.health-snapshot-incomplete',
      );
      for (const row of rows.slice(1)) await writeImportHealthBrand(runtime.redis, snapshotId, row);
      await publishImportHealthSnapshot(runtime.redis, summary);
      expect((await call('GET', pageUrl, adminToken)).statusCode).toBe(403);
      expect(
        (await call('GET', '/api/install/system/imports?page=0', installToken)).statusCode,
      ).toBe(400);
      const second = await call('GET', pageUrl, installToken);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        snapshotId,
        page: 2,
        hasNext: false,
        brands: rows.slice(50),
      });
      await publishImportHealthSnapshot(runtime.redis, {
        ...summary,
        snapshotId: newerId,
        totalBrands: 0,
        active: 0,
        brands: [],
      });
      expect((await call('GET', pageUrl, installToken)).json()).toEqual(second.json());
      for (const key of keys.slice(1, 3)) {
        expect(await runtime.redis.ttl(key)).toBeGreaterThan(0);
        expect(await runtime.redis.ttl(key)).toBeLessThanOrEqual(IMPORT_HEALTH_TTL_SECONDS);
      }
      await runtime.redis.hdel(`${IMPORT_HEALTH_KEY}:${snapshotId}:data`, rows[50]!.brandId);
      expect((await call('GET', pageUrl, installToken)).json()).toEqual({ configured: false });
      await runtime.redis.hset(
        `${IMPORT_HEALTH_KEY}:${snapshotId}:data`,
        rows[50]!.brandId,
        JSON.stringify(rows[50]),
      );
      await runtime.redis.del(`${IMPORT_HEALTH_KEY}:${snapshotId}:order`);
      expect((await call('GET', pageUrl, installToken)).json()).toEqual({ configured: false });
      await runtime.redis.del(`${IMPORT_HEALTH_KEY}:${snapshotId}:data`);
      expect((await call('GET', pageUrl, installToken)).json()).toEqual({ configured: false });
    } finally {
      await runtime.redis.del(...keys);
    }
  });

  it('keeps every distinct extraction warning in the review count while bounding samples and respecting run/brand/scope', async () => {
    const runId = uuidv7();
    const otherRunId = uuidv7();
    await owner.db.insert(importRuns).values([
      { id: runId, brandId, source: 'zendesk', startedBy: adminId },
      { id: otherRunId, brandId: otherBrandId, source: 'zendesk', startedBy: adminId },
    ]);
    await owner.db.insert(importLog).values([
      ...Array.from({ length: 105 }, (_, index) => ({
        brandId,
        runId,
        level: 'warning' as const,
        entity: 'message' as const,
        externalId: `m-${String(index).padStart(3, '0')}`,
        message: 'import.message.author-unavailable',
      })),
      {
        brandId,
        runId,
        level: 'warning',
        entity: 'message',
        externalId: 'm-000',
        message: 'import.message.author-unavailable',
      },
      {
        brandId,
        runId,
        level: 'error',
        entity: 'message',
        externalId: 'error',
        message: 'import.message.author-unavailable',
      },
      {
        brandId,
        runId,
        level: 'warning',
        entity: 'article',
        externalId: 'article',
        message: 'import.knowledge.readership-restricted',
      },
      {
        brandId,
        runId,
        level: 'warning',
        entity: 'article',
        externalId: 'article-fr',
        message: 'import.knowledge.locale-unsupported',
      },
      {
        brandId,
        runId,
        level: 'warning',
        entity: 'message',
        externalId: 'retry',
        message: 'import.rate-limited',
      },
      {
        brandId: otherBrandId,
        runId: otherRunId,
        level: 'warning',
        entity: 'message',
        externalId: 'foreign',
        message: 'import.message.author-unavailable',
      },
    ]);
    const report = await withSystem(runtime.db, brandId, (tx) =>
      importVendorSourceWarnings(tx, { brandId, runId, entities: ['message'] }),
    );
    expect(report.sourceWarningCount).toBe(105);
    expect(report.sourceWarnings).toHaveLength(100);
    expect(report.sourceWarnings[0]).toEqual({
      entity: 'message',
      externalId: 'm-000',
      code: 'import.message.author-unavailable',
    });
    expect(report.sourceWarnings.at(-1)?.externalId).toBe('m-099');
    const knowledgeWarnings = await withSystem(runtime.db, brandId, (tx) =>
      importVendorSourceWarnings(tx, { brandId, runId, entities: ['article'] }),
    );
    expect(knowledgeWarnings.sourceWarningCount).toBe(2);
    expect(knowledgeWarnings.sourceWarnings).toEqual(
      expect.arrayContaining([
        {
          entity: 'article',
          externalId: 'article-fr',
          code: 'import.knowledge.locale-unsupported',
        },
      ]),
    );
    expect(
      await withSystem(runtime.db, otherBrandId, (tx) =>
        importVendorSourceWarnings(tx, { brandId: otherBrandId, runId, entities: ['message'] }),
      ),
    ).toEqual({ sourceWarningCount: 0, sourceWarnings: [] });
  });

  it('pages a brand/run log at a fixed boundary and exports every page with spreadsheet-safe IDs', async () => {
    const runId = uuidv7();
    const foreignRun = uuidv7();
    await owner.db.insert(importRuns).values([
      { id: runId, brandId, source: 'zendesk', startedBy: adminId },
      { id: foreignRun, brandId: otherBrandId, source: 'zendesk', startedBy: adminId },
    ]);
    await owner.db.insert(importLog).values(
      Array.from({ length: 520 }, (_, index) => ({
        brandId,
        runId,
        level: index % 2 ? ('warning' as const) : ('info' as const),
        externalId: index === 0 ? '=2+2' : `record-${index}`,
        message: 'import.mapping.unknown-value',
      })),
    );
    const first = await call('GET', `${root()}/${runId}/log?direction=asc&limit=2`, adminToken);
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      through: number;
      nextCursor: number;
      entries: { externalId: string }[];
    }>();
    expect(page.entries.map((entry) => entry.externalId)).toEqual(['=2+2', 'record-1']);
    await owner.db.insert(importLog).values([
      {
        brandId,
        runId,
        level: 'warning',
        externalId: 'later-record',
        message: 'import.record-unavailable',
      },
      {
        brandId: otherBrandId,
        runId: foreignRun,
        level: 'error',
        externalId: 'foreign-record',
        message: 'foreign-only',
      },
    ]);
    const bounded = await call(
      'GET',
      `${root()}/${runId}/log?direction=asc&after=${page.nextCursor}&through=${page.through}&limit=500&level=warning`,
      adminToken,
    );
    expect(bounded.statusCode).toBe(200);
    expect(
      bounded
        .json<{ entries: { level: string; externalId: string }[] }>()
        .entries.every((entry) => entry.level === 'warning' && entry.externalId !== 'later-record'),
    ).toBe(true);
    const exported = await call('GET', `${root()}/${runId}/log/export`, adminToken);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.body).toContain(",'=2+2,");
    expect(exported.body).toContain(',record-519,');
    expect(exported.body).toContain(',later-record,');
    expect(exported.body).not.toContain('foreign-only');
    expect((await call('GET', `${root()}/${foreignRun}/log`, adminToken)).statusCode).toBe(404);
    expect((await call('GET', `${root()}/${foreignRun}/log/export`, adminToken)).statusCode).toBe(
      404,
    );
  });

  it('serves validated paged previews only within the authenticated admin brand without source URLs', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId,
      source: 'zendesk',
      status: 'awaiting_mapping',
      startedBy: adminId,
    });
    const ticket = importRecordSchema.parse({
      entity: 'ticket',
      payload: {
        externalId: '42',
        number: '900',
        subject: 'History preview',
        status: 'open',
        ccEmails: [],
        tags: [],
        custom: {},
        createdAt: '2019-01-01T00:00:00Z',
        updatedAt: '2019-01-03T00:00:00Z',
        sourceUrl: 'https://vendor.example/tickets/42?token=hidden-root',
      },
    });
    const messages = [true, false].map((publicMessage, index) =>
      importRecordSchema.parse({
        entity: 'message',
        payload: {
          externalId: `message-${index}`,
          ticketExternalId: '42',
          authorKind: 'system',
          public: publicMessage,
          bodyHtml: `<p>History ${index}</p><ScRiPt>alert(1)</ScRiPt>`,
          createdAt: `2019-01-0${index + 1}T00:00:00Z`,
          attachments: [
            {
              externalId: `file-${index}`,
              fileName: 'history.pdf',
              url: 'https://vendor.example/file?token=hidden-file',
            },
          ],
        },
      }),
    );
    await owner.db.insert(importRecords).values(
      [ticket, ...messages].map((native) => ({
        brandId,
        runId,
        entity: native.entity,
        externalId: native.payload.externalId,
        parentExternalId: native.entity === 'message' ? '42' : null,
        payload: native.payload,
        payloadHash: hashImportValue(native.payload),
      })),
    );
    const url = `${root()}/${runId}/preview/ticket?externalId=42&limit=1`;
    const first = await call('GET', url, adminToken);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      ticket: { number: '900' },
      messageCount: 2,
      nextOffset: 1,
      messages: [{ public: true, bodyText: 'History 0' }],
    });
    expect(first.body).not.toMatch(/hidden-root|hidden-file|<script\b/i);
    const second = await call('GET', `${url}&offset=1`, adminToken);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      nextOffset: null,
      messages: [{ public: false, bodyText: 'History 1' }],
    });
    expect((await call('GET', `${url}&offset=-1`, adminToken)).statusCode).toBe(400);
    expect(
      (await call('GET', `${root()}/${runId}/preview/ticket?externalId=42&limit=51`, adminToken))
        .statusCode,
    ).toBe(400);
    expect((await call('GET', `${url}&credentials=forbidden`, adminToken)).statusCode).toBe(400);
    expect(
      (await call('GET', `${root()}/${runId}/preview/ticket?externalId=missing`, adminToken))
        .statusCode,
    ).toBe(404);
    const foreignRunId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: foreignRunId,
      brandId: otherBrandId,
      source: 'zendesk',
      status: 'awaiting_mapping',
      startedBy: adminId,
    });
    expect(
      (await call('GET', `${root()}/${foreignRunId}/preview/ticket?externalId=42`, adminToken))
        .statusCode,
    ).toBe(404);
    const csrf = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: '__Secure-hd_refresh=untrusted', origin: 'https://attacker.example' },
    });
    expect(csrf.statusCode).toBe(401);
  });

  it('previews source contact details and proposed companies while preserving local identity and company links', async () => {
    const runId = uuidv7();
    const accountId = uuidv7();
    const contactId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId,
      source: 'zendesk',
      status: 'awaiting_mapping',
      startedBy: adminId,
    });
    await owner.db
      .insert(accounts)
      .values({ id: accountId, brandId, name: 'Local company', domain: 'local.test' });
    await owner.db
      .insert(contacts)
      .values({ id: contactId, brandId, name: 'Local person', accountId });
    await owner.db.insert(contactIdentities).values({
      brandId,
      contactId,
      kind: 'email',
      value: 'local@example.test',
      verified: false,
      source: 'agent',
    });
    const records = [
      {
        entity: 'organization',
        payload: {
          externalId: 'source-company',
          name: 'Source company',
          domains: ['source.test'],
          custom: {},
        },
      },
      {
        entity: 'contact',
        payload: {
          externalId: 'source-person',
          name: 'Source person',
          emails: ['LOCAL@EXAMPLE.TEST'],
          phones: ['invalid'],
          organizationExternalId: 'source-company',
          custom: {},
          notes: 'Original notes',
          description: 'Original description',
          createdAt: '2018-01-01T00:00:00Z',
          updatedAt: '2019-01-01T00:00:00Z',
          locale: 'ar',
          timezone: 'Asia/Damascus',
          sourceIdentities: [
            {
              externalId: 'native-email',
              type: 'email',
              value: 'LOCAL@EXAMPLE.TEST',
              verificationMethod: 'source-verified',
            },
          ],
        },
      },
    ].map((record) => importRecordSchema.parse(record));
    await owner.db.insert(importRecords).values(
      records.map((native) => ({
        brandId,
        runId,
        entity: native.entity,
        externalId: native.payload.externalId,
        payload: native.payload,
        payloadHash: hashImportValue(native.payload),
      })),
    );
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM contacts WHERE id = ${contactId}`,
    );
    const identityBefore = await owner.db.execute(
      sql`SELECT id, verified, xmin::text AS revision FROM contact_identities WHERE contact_id = ${contactId}`,
    );
    const url = `${root()}/${runId}/preview/contact?externalId=source-person`;
    const response = await call('GET', url, adminToken);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: {
        name: 'Source person',
        notes: 'Original notes',
        description: 'Original description',
        createdAt: '2018-01-01T00:00:00Z',
        updatedAt: '2019-01-01T00:00:00Z',
        locale: 'ar',
        timezone: 'Asia/Damascus',
        sourceIdentities: [{ verificationMethod: 'source-verified' }],
      },
      plan: {
        action: 'link',
        contactId,
        accountId,
        sourceAccountId: null,
        name: 'Local person',
        sourceName: 'Source person',
        refusedPhones: 1,
        identifiers: [{ kind: 'email', value: 'local@example.test' }],
        organization: { action: 'create', accountId: null, name: 'Source company' },
      },
    });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM contacts WHERE id = ${contactId}`,
      ),
    ).toEqual(before);
    expect(
      await owner.db.execute(
        sql`SELECT id, verified, xmin::text AS revision FROM contact_identities WHERE contact_id = ${contactId}`,
      ),
    ).toEqual(identityBefore);
    expect(
      (await owner.db.select().from(accounts).where(eq(accounts.brandId, brandId))).filter(
        (account) => account.domain === 'source.test',
      ),
    ).toEqual([]);
    expect((await call('GET', `${url}&defaultCallingCode=invalid`, adminToken)).statusCode).toBe(
      400,
    );
    expect(
      (await call('GET', `${root()}/${runId}/preview/contact?externalId=%00`, adminToken))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('GET', `${root()}/${runId}/preview/ticket?externalId=%00`, adminToken))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('GET', `${root()}/${runId}/preview/contact?externalId=missing`, adminToken))
        .statusCode,
    ).toBe(404);
  });

  it('returns a safe conflict for invalid contact custom values instead of a server error or raw source value', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId,
      source: 'zendesk',
      status: 'awaiting_mapping',
      startedBy: adminId,
    });
    const records = [
      {
        entity: 'field',
        payload: {
          externalId: 'age-field',
          target: 'contact',
          key: 'source_age',
          label: 'Age',
          type: 'number',
        },
      },
      {
        entity: 'contact',
        payload: {
          externalId: 'invalid-contact',
          name: 'Source person',
          emails: [],
          phones: [],
          custom: { source_age: 'private-invalid-number' },
        },
      },
    ].map((record) => importRecordSchema.parse(record));
    await owner.db.insert(importRecords).values(
      records.map((native) => ({
        brandId,
        runId,
        entity: native.entity,
        externalId: native.payload.externalId,
        payload: native.payload,
        payloadHash: hashImportValue(native.payload),
      })),
    );
    await owner.db.insert(importMappings).values({
      brandId,
      runId,
      kind: 'field',
      externalValue: 'age-field',
      target: {
        kind: 'create',
        definition: { target: 'contact', key: 'mapped_age', label: 'Age', type: 'number' },
      },
    });
    const response = await call(
      'GET',
      `${root()}/${runId}/preview/contact?externalId=invalid-contact`,
      adminToken,
    );
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('private-invalid-number');
  });

  it('selects at most three stable sample IDs per entity only from the requested brand and run', async () => {
    const runId = uuidv7();
    const foreignRunId = uuidv7();
    const otherRunId = uuidv7();
    await owner.db.insert(importRuns).values([
      { id: runId, brandId, source: 'zendesk', status: 'awaiting_mapping', startedBy: adminId },
      {
        id: otherRunId,
        brandId,
        source: 'zendesk',
        status: 'awaiting_mapping',
        startedBy: adminId,
      },
      {
        id: foreignRunId,
        brandId: otherBrandId,
        source: 'zendesk',
        status: 'awaiting_mapping',
        startedBy: adminId,
      },
    ]);
    const rows = ['d', 'b', 'c', 'a']
      .flatMap((externalId) => [
        {
          entity: 'contact',
          payload: { externalId, name: 'Source person', emails: [], phones: [], custom: {} },
        },
        {
          entity: 'ticket',
          payload: {
            externalId,
            subject: 'Source ticket',
            status: 'open',
            ccEmails: [],
            tags: [],
            custom: {},
            createdAt: '2019-01-01T00:00:00Z',
            updatedAt: '2019-01-02T00:00:00Z',
          },
        },
      ])
      .map((record) => importRecordSchema.parse(record));
    await owner.db.insert(importRecords).values(
      rows.map((native) => ({
        brandId,
        runId,
        entity: native.entity,
        externalId: native.payload.externalId,
        payload: native.payload,
        payloadHash: hashImportValue(native.payload),
      })),
    );
    const foreign = importRecordSchema.parse({
      entity: 'contact',
      payload: {
        externalId: '000-foreign',
        name: 'Private person',
        emails: [],
        phones: [],
        custom: {},
      },
    });
    await owner.db.insert(importRecords).values({
      brandId: otherBrandId,
      runId: foreignRunId,
      entity: foreign.entity,
      externalId: foreign.payload.externalId,
      payload: foreign.payload,
      payloadHash: hashImportValue(foreign.payload),
    });
    const other = importRecordSchema.parse({
      entity: 'contact',
      payload: {
        externalId: '000-other-run',
        name: 'Other run',
        emails: [],
        phones: [],
        custom: {},
      },
    });
    await owner.db.insert(importRecords).values({
      brandId,
      runId: otherRunId,
      entity: other.entity,
      externalId: other.payload.externalId,
      payload: other.payload,
      payloadHash: hashImportValue(other.payload),
    });
    const url = `${root()}/${runId}/preview/samples`;
    const first = await call('GET', url, adminToken);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ tickets: ['a', 'b', 'c'], contacts: ['a', 'b', 'c'] });
    expect((await call('GET', url, adminToken)).json()).toEqual(first.json());
    expect(
      (await call('GET', `${root()}/${foreignRunId}/preview/samples`, adminToken)).statusCode,
    ).toBe(404);
  });

  it('refuses a customer source identity presented as a staff author without exposing its name', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId,
      source: 'zendesk',
      status: 'awaiting_mapping',
      startedBy: adminId,
    });
    const records = [
      {
        entity: 'ticket',
        payload: {
          externalId: 'bad-author-ticket',
          subject: 'History',
          status: 'open',
          ccEmails: [],
          tags: [],
          custom: {},
          createdAt: '2019-01-01T00:00:00Z',
          updatedAt: '2019-01-02T00:00:00Z',
        },
      },
      {
        entity: 'message',
        payload: {
          externalId: 'bad-author-message',
          ticketExternalId: 'bad-author-ticket',
          authorKind: 'agent',
          authorExternalId: 'bad-agent',
          public: false,
          bodyText: 'Private note',
          createdAt: '2019-01-02T00:00:00Z',
          attachments: [],
        },
      },
      {
        entity: 'user',
        payload: {
          externalId: 'bad-agent',
          kind: 'customer',
          name: 'Private customer name',
          active: true,
        },
      },
    ].map((record) => importRecordSchema.parse(record));
    await owner.db.insert(importRecords).values(
      records.map((native) => ({
        brandId,
        runId,
        entity: native.entity,
        externalId: native.payload.externalId,
        parentExternalId: native.entity === 'message' ? 'bad-author-ticket' : null,
        payload: native.payload,
        payloadHash: hashImportValue(native.payload),
      })),
    );
    const response = await call(
      'GET',
      `${root()}/${runId}/preview/ticket?externalId=bad-author-ticket`,
      adminToken,
    );
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('Private customer name');
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
  it('resumes a paused dry run and publishes its next work atomically', async () => {
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
    expect((await call('POST', `${root()}/${run.id}/resume`, adminToken)).statusCode).toBe(200);
    expect((await call('GET', `${root()}/${run.id}`, adminToken)).json()).toMatchObject({
      status: 'dry_run',
      hasCredentials: true,
    });
    expect(
      await owner.db.select().from(outbox).where(sql`${outbox.payload}->>'runId' = ${run.id}`),
    ).toMatchObject([{ payload: { runId: run.id, step: 'dry_run' } }]);
    expect((await call('POST', `${root()}/${run.id}/cancel`, adminToken)).statusCode).toBe(200);
  });
  it.each([false, true])(
    'runs paged dry-run validation through Redis without creating profiles or approving loading (corrupt source: %s)',
    async (corrupt) => {
      const created = await call('POST', root(), adminToken, { source: 'zendesk' });
      const runId = created.json<ImportRunView>().id;
      expect((await call('GET', `${root()}/${runId}/dry-run`, adminToken)).statusCode).toBe(404);
      expect((await call('POST', `${root()}/${runId}/dry-run`, adminToken, {})).statusCode).toBe(
        409,
      );
      expect(
        (
          await call('PUT', `${root()}/${runId}/connection`, adminToken, {
            credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' },
          })
        ).statusCode,
      ).toBe(200);
      await owner.db
        .update(importRuns)
        .set({ status: 'awaiting_mapping' })
        .where(eq(importRuns.id, runId));
      const records = Array.from({ length: 27 }, (_, index) =>
        importRecordSchema.parse({
          entity: 'organization',
          payload: {
            externalId: `dry-company-${index}`,
            name: `Company ${index}`,
            domains: [],
            custom: {},
          },
        }),
      );
      records.push(
        importRecordSchema.parse({
          entity: 'contact',
          payload: {
            externalId: 'dry-contact',
            name: 'Source person',
            emails: [],
            phones: ['invalid-one', 'invalid-two', '0944556677'],
            custom: {},
          },
        }),
      );
      await owner.db.insert(importRecords).values(
        records.map((native) => ({
          brandId,
          runId,
          entity: native.entity,
          externalId: native.payload.externalId,
          payload: native.payload,
          payloadHash:
            corrupt && native.payload.externalId === 'dry-company-0'
              ? '0'.repeat(64)
              : hashImportValue(native.payload),
        })),
      );
      const profilesBefore = await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM accounts WHERE brand_id = ${brandId} ORDER BY id`,
      );
      expect(
        (
          await call('POST', `${root()}/${runId}/dry-run`, adminToken, {
            defaultCallingCode: 'bad',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call('POST', `${root()}/${runId}/dry-run`, adminToken, {
            defaultCallingCode: '963',
          })
        ).statusCode,
      ).toBe(200);
      expect((await call('POST', `${root()}/${runId}/dry-run`, adminToken, {})).statusCode).toBe(
        409,
      );
      expect((await call('GET', `${root()}/${runId}/dry-run`, adminToken)).json()).toMatchObject({
        phase: 'records',
        complete: false,
        defaultCallingCode: '963',
      });
      const producer = runtime.redis.duplicate({ maxRetriesPerRequest: null });
      const consumer = runtime.redis.duplicate({ maxRetriesPerRequest: null });
      const queueName = `m11-http-dry-run-${uuidv7()}`;
      const queue = new Queue(queueName, { connection: producer });
      const worker = new Worker(
        queueName,
        createImportProcessor({
          db: runtime.db,
          storage: {} as never,
          resolve: createImportConnectorRuntime({
            db: runtime.db,
            keyring: createKeyring({ APP_MASTER_KEY: masterKey }),
            allowCidrs: [],
          }),
        }),
        { connection: consumer, concurrency: 1 },
      );
      const failures: string[] = [];
      worker.on('failed', (_job, error) => failures.push(error.message));
      const delivered = new Set<string>();
      const bridge = createImportWorkHandler({
        add: async (step, payload, jobId, delay) => {
          const definition = JOB_DEFINITIONS[`import.${step}`];
          await queue.add(definition.name, payload, { ...definition.options, jobId, delay });
        },
      });
      const pump = async (running: readonly string[]) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const events = await owner.db
            .select()
            .from(outbox)
            .where(sql`${outbox.payload}->>'runId' = ${runId}`);
          for (const event of events)
            if (!delivered.has(event.id)) {
              await withSystem(runtime.db, brandId, (tx) =>
                bridge({
                  tx,
                  brandId,
                  event: event.event,
                  payload: event.payload,
                  outboxId: event.id,
                  log: silentJobLogger,
                }),
              );
              delivered.add(event.id);
            }
          const selected = (
            await owner.db.select().from(importRuns).where(eq(importRuns.id, runId))
          )[0];
          if (!selected || !running.includes(selected.status)) return;
          await waitForQueue(20);
        }
      };
      try {
        await pump(['dry_run']);
        expect(failures).toEqual([]);
        const reportResponse = await call('GET', `${root()}/${runId}/dry-run`, adminToken);
        expect(reportResponse.statusCode).toBe(200);
        expect(reportResponse.json()).toMatchObject({
          complete: true,
          phase: 'media_checked',
          recordsChecked: 28,
          errors: corrupt ? 1 : 0,
          warnings: 1,
          refusedPhones: 2,
          defaultCallingCode: '963',
        });
        expect(reportResponse.body).not.toMatch(
          /synthetic-token|claimToken|mediaAfter|retryAt|destinationFingerprint|approvedReviewToken|loadApprovalChecked/,
        );
        expect((await call('GET', `${root()}/${runId}`, adminToken)).json()).toMatchObject({
          status: 'awaiting_mapping',
          hasCredentials: true,
        });
        expect(
          await owner.db.execute(
            sql`SELECT id, xmin::text AS revision FROM accounts WHERE brand_id = ${brandId} ORDER BY id`,
          ),
        ).toEqual(profilesBefore);
        expect(
          (
            await owner.db.select().from(outbox).where(sql`${outbox.payload}->>'runId' = ${runId}`)
          ).every((event) => event.event === 'import.work_requested'),
        ).toBe(true);
        const report = reportResponse.json<{ reviewToken: string }>();
        expect(
          (
            await call('POST', `${root()}/${runId}/start`, adminToken, {
              reviewToken: '0'.repeat(64),
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (
            await call('POST', `${root()}/${runId}/start`, adminToken, {
              reviewToken: report.reviewToken,
            })
          ).statusCode,
        ).toBe(409);
        if (corrupt) {
          const blocked = await call('POST', `${root()}/${runId}/start`, adminToken, {
            reviewToken: report.reviewToken,
            acknowledgeWarnings: true,
          });
          expect(blocked.statusCode).toBe(409);
          expect(blocked.json()).toMatchObject({ error: { message: 'import.dry-run-errors' } });
        } else {
          const approved = await call('POST', `${root()}/${runId}/start`, adminToken, {
            reviewToken: report.reviewToken,
            acknowledgeWarnings: true,
          });
          expect(approved.statusCode).toBe(200);
          expect(approved.json()).toMatchObject({ status: 'loading' });
          expect(
            (
              await call('POST', `${root()}/${runId}/start`, adminToken, {
                reviewToken: report.reviewToken,
                acknowledgeWarnings: true,
              })
            ).statusCode,
          ).toBe(409);
          await pump(['loading', 'finishing']);
          expect((await call('GET', `${root()}/${runId}`, adminToken)).json()).toMatchObject({
            status: 'completed',
            hasCredentials: false,
          });
          expect(
            await owner.db
              .select()
              .from(contactIdentities)
              .where(
                and(
                  eq(contactIdentities.brandId, brandId),
                  eq(contactIdentities.value, '+963944556677'),
                ),
              ),
          ).toMatchObject([{ source: 'import', verified: false }]);
          expect(failures).toEqual([]);
        }
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
        await producer.quit();
        await consumer.quit();
      }
    },
    30000,
  );
  async function seedCompletedValidation() {
    const created = await call('POST', root(), adminToken, { source: 'zendesk' });
    const runId = created.json<ImportRunView>().id;
    expect(
      (
        await call('PUT', `${root()}/${runId}/connection`, adminToken, {
          credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' },
        })
      ).statusCode,
    ).toBe(200);
    await owner.db
      .update(importRuns)
      .set({ status: 'awaiting_mapping' })
      .where(eq(importRuns.id, runId));
    const native = importRecordSchema.parse({
      entity: 'contact',
      payload: {
        externalId: `stale-${runId}`,
        name: 'Must not load stale contact',
        emails: [],
        phones: [],
        custom: {},
      },
    });
    await owner.db.insert(importRecords).values({
      brandId,
      runId,
      entity: native.entity,
      externalId: native.payload.externalId,
      payload: native.payload,
      payloadHash: hashImportValue(native.payload),
    });
    const checkpoint = await withSystem(runtime.db, brandId, async (tx) =>
      importDryRunCheckpointSchema.parse({
        version: 2,
        phase: 'media_checked',
        fingerprint: await importInputFingerprint(tx, { brandId, runId }),
        destinationFingerprint: await importDestinationFingerprint(tx, { brandId, runId }),
        defaultCallingCode: '',
        after: null,
        checked: 1,
        issueCount: 0,
        issues: [],
      }),
    );
    await owner.db
      .update(importRuns)
      .set({ dryRunReport: checkpoint })
      .where(eq(importRuns.id, runId));
    const report = (await call('GET', `${root()}/${runId}/dry-run`, adminToken)).json<{
      reviewToken: string;
    }>();
    return { runId, reviewToken: report.reviewToken };
  }
  it.each(['source', 'contact', 'staff', 'policy', 'ledger'] as const)(
    'rejects a reviewed report after a %s change without publishing load work',
    async (changed) => {
      const { runId, reviewToken } = await seedCompletedValidation();
      if (changed === 'source')
        await owner.db
          .update(importRuns)
          .set({ options: { entities: ['contact'] } })
          .where(eq(importRuns.id, runId));
      if (changed === 'contact')
        await owner.db.insert(contacts).values({ brandId, name: 'Created after review' });
      if (changed === 'staff')
        await owner.db.insert(users).values({
          email: `after-review-${runId}@example.test`,
          name: 'Possible invite collision',
        });
      const [originalBrand] = await owner.db.select().from(brands).where(eq(brands.id, brandId));
      if (!originalBrand) throw new Error('Missing brand');
      if (changed === 'policy') {
        const policy = contentPolicySchema.parse({});
        policy.file.enabled = false;
        await owner.db
          .update(brands)
          .set({ settings: { ...originalBrand.settings, contentPolicy: policy } })
          .where(eq(brands.id, brandId));
      }
      if (changed === 'ledger') {
        const [stored] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
        if (!stored) throw new Error('Missing run');
        await owner.db.insert(importExternalIds).values({
          brandId,
          source: 'zendesk',
          sourceAccountKey: stored.sourceAccountKey,
          entity: 'contact',
          externalId: `after-review-${runId}`,
          helpdockId: uuidv7(),
          payloadHash: 'a'.repeat(64),
        });
      }
      try {
        const refused = await call('POST', `${root()}/${runId}/start`, adminToken, {
          reviewToken,
          acknowledgeWarnings: true,
        });
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({ error: { message: 'import.dry-run-stale' } });
        expect(
          await owner.db.select().from(outbox).where(sql`${outbox.payload}->>'runId' = ${runId}`),
        ).toEqual([]);
        expect((await call('GET', `${root()}/${runId}`, adminToken)).json()).toMatchObject({
          status: 'awaiting_mapping',
          hasCredentials: true,
        });
      } finally {
        if (changed === 'policy')
          await owner.db
            .update(brands)
            .set({ settings: originalBrand.settings })
            .where(eq(brands.id, brandId));
      }
    },
  );
  it('returns a queued approval to review when destinations change before its first domain write', async () => {
    const { runId, reviewToken } = await seedCompletedValidation();
    const started = await call('POST', `${root()}/${runId}/start`, adminToken, { reviewToken });
    expect(started.statusCode).toBe(200);
    const contactId = uuidv7();
    await owner.db
      .insert(contacts)
      .values({ id: contactId, brandId, name: 'Changed while the job waited' });
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM contacts WHERE brand_id = ${brandId} ORDER BY id`,
    );
    const processor = createImportProcessor({
      db: runtime.db,
      storage: {} as never,
      resolve: async () => {
        throw new Error('Stale approval must stop before vendor I/O');
      },
    });
    await processor({ name: 'import.load', id: 'stale-queued-approval', data: { brandId, runId } });
    expect((await call('GET', `${root()}/${runId}`, adminToken)).json()).toMatchObject({
      status: 'awaiting_mapping',
      hasCredentials: true,
    });
    const report = await call('GET', `${root()}/${runId}/dry-run`, adminToken);
    expect(report.json()).toMatchObject({
      phase: 'invalidated',
      complete: false,
      reviewToken: null,
    });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM contacts WHERE brand_id = ${brandId} ORDER BY id`,
      ),
    ).toEqual(before);
    expect(
      await owner.db.select().from(outbox).where(sql`${outbox.payload}->>'runId' = ${runId}`),
    ).toHaveLength(1);
    const [stored] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(stored).toMatchObject({ claimToken: null, claimedAt: null });
    expect(
      await owner.db.select().from(importRecords).where(eq(importRecords.runId, runId)),
    ).toMatchObject([{ status: 'staged' }]);
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(
          and(
            eq(importExternalIds.brandId, brandId),
            eq(importExternalIds.externalId, `stale-${runId}`),
          ),
        ),
    ).toEqual([]);
  });
  it('confirms mappings atomically, returns their input fingerprint and clears obsolete dry-run approval', async () => {
    const created = await call('POST', root(), adminToken, { source: 'zendesk' });
    expect(created.statusCode).toBe(201);
    const run = created.json<ImportRunView>();
    expect(
      (await call('PUT', `${root()}/${run.id}/mappings`, adminToken, { mappings: [] })).statusCode,
    ).toBe(409);
    await owner.db
      .update(importRuns)
      .set({ status: 'ready', dryRunReport: { approved: true } })
      .where(eq(importRuns.id, run.id));
    const mappings = [
      { kind: 'priority', externalValue: 'urgent', target: { priority: 'urgent' } },
    ];
    const confirmed = await call('PUT', `${root()}/${run.id}/mappings`, adminToken, { mappings });
    expect(confirmed.statusCode).toBe(200);
    const result = confirmed.json<{ mappings: unknown[]; fingerprint: string }>();
    expect(result.mappings).toEqual(mappings);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const read = await call('GET', `${root()}/${run.id}/mappings`, adminToken);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(result);
    const [stored] = await owner.db.select().from(importRuns).where(eq(importRuns.id, run.id));
    expect(stored).toMatchObject({ status: 'awaiting_mapping', dryRunReport: null });
    expect(
      (
        await call('PUT', `${root()}/${run.id}/mappings`, adminToken, {
          mappings: [...mappings, ...mappings],
        })
      ).statusCode,
    ).toBe(400);
    expect((await call('GET', `${root()}/${run.id}/mappings`, adminToken)).json()).toEqual(result);
  });

  it('seals a Freshdesk inventory, validates the entire selected ID column and binds extraction approval to its revision', async () => {
    const created = await call('POST', root(), adminToken, { source: 'freshdesk' });
    expect(created.statusCode).toBe(201);
    const run = created.json<ImportRunView>();
    const path = `${root()}/${run.id}`;
    const connected = await call('PUT', `${path}/connection`, adminToken, {
      credentials: { domain: 'demo', apiKey: 'synthetic-key', csatApi: 'modern' },
    });
    expect(connected.statusCode).toBe(200);
    expect(JSON.stringify(connected.json())).not.toContain('synthetic-key');
    const body = Buffer.from(
      'Ticket ID,Subject\n9001,Archived question\n9001,Duplicate question\n',
    );
    const allocated = await call('POST', `${path}/files/presign`, adminToken, {
      format: 'csv',
      entity: 'ticket',
      fileName: 'archive.csv',
      size: body.length,
      inventoryMapping: { idColumn: null, location: 'archived' },
    });
    expect(allocated.statusCode).toBe(201);
    const fileId = allocated.json<{ file: { id: string } }>().file.id;
    const storedFile = async () => {
      const [file] = await owner.db.select().from(importFiles).where(eq(importFiles.id, fileId));
      if (!file) throw new Error('Missing inventory file');
      return file;
    };
    await storage.put((await storedFile()).uploadKey, body);
    expect((await call('POST', `${path}/files/${fileId}/confirm`, adminToken)).statusCode).toBe(
      200,
    );
    const prepare = async () =>
      prepareImportSourceFile(
        { db: runtime.db, storage },
        { brandId, runId: run.id, fileId, revision: (await storedFile()).revision },
      );
    await prepare();
    expect(await storedFile()).toMatchObject({
      status: 'ready',
      inventoryValidation: null,
      headers: ['Ticket ID', 'Subject'],
    });
    const visible = await call('GET', `${path}/files`, adminToken);
    expect(visible.statusCode).toBe(200);
    expect(visible.json().files[0]).toMatchObject({
      id: fileId,
      hasHeaders: true,
      readyForExtraction: false,
      validationPending: false,
    });
    for (const field of ['headers', 'sampleRows', 'mapping', 'validation'])
      expect(visible.json().files[0]).not.toHaveProperty(field);
    expect(JSON.stringify(visible.json())).not.toContain('sourceKey');
    expect(JSON.stringify(visible.json())).not.toContain('sha256');
    const detail = await call('GET', `${path}/files/${fileId}`, adminToken);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      headers: ['Ticket ID', 'Subject'],
      sampleRows: [
        { line: 2, cells: ['9001', 'Archived question'] },
        { line: 3, cells: ['9001', 'Duplicate question'] },
      ],
    });
    expect(detail.json()).not.toHaveProperty('sourceKey');
    expect(detail.json()).not.toHaveProperty('uploadKey');
    expect(
      (await call('GET', `${root()}/${uuidv7()}/files/${fileId}`, adminToken)).statusCode,
    ).toBe(404);
    await storage.put(
      (await storedFile()).uploadKey,
      Buffer.from(body.toString().replaceAll('9001', '9002')),
    );
    const map = (idColumn: string, location = 'archived') =>
      call('PUT', `${path}/files/${fileId}/inventory-mapping`, adminToken, {
        mapping: { idColumn, location },
      });
    expect((await map('Missing')).statusCode).toBe(400);
    expect((await map('Subject')).statusCode).toBe(200);
    await prepare();
    expect(await storedFile()).toMatchObject({
      status: 'invalid',
      error: 'invalid-record:2',
      inventoryValidation: null,
    });
    expect((await map('Ticket ID')).statusCode).toBe(200);
    await prepare();
    expect(await storedFile()).toMatchObject({
      status: 'ready',
      inventoryValidation: { kind: 'ticket-inventory', records: 1, sourceRows: 2, duplicates: 1 },
    });
    expect((await call('GET', `${path}/files`, adminToken)).json().files[0]).toMatchObject({
      readyForExtraction: true,
      validationPending: false,
    });
    const active = await storedFile();
    expect(
      await owner.db
        .select({ externalId: importTicketInventory.externalId })
        .from(importTicketInventory)
        .where(
          and(
            eq(importTicketInventory.fileId, fileId),
            eq(importTicketInventory.revision, active.revision),
          ),
        ),
    ).toEqual([{ externalId: '9001' }]);
    const scope = { entities: ['ticket'], inventoryMode: 'complete', inventoryConfirmed: true };
    expect((await call('PUT', `${path}/scope`, adminToken, scope)).statusCode).toBe(200);
    expect((await map('Ticket ID', 'auto')).statusCode).toBe(200);
    await prepare();
    const stale = await call('POST', `${path}/extract`, adminToken);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toBe('import.inventory-stale');
    expect((await call('PUT', `${path}/scope`, adminToken, scope)).statusCode).toBe(200);
    const extracting = await call('POST', `${path}/extract`, adminToken);
    expect(extracting.statusCode).toBe(200);
    expect(extracting.json()).toMatchObject({ status: 'extracting' });
    expect((await map('Ticket ID')).statusCode).toBe(409);
    expect(
      await owner.db
        .select({ id: importRecords.id })
        .from(importRecords)
        .where(eq(importRecords.runId, run.id)),
    ).toEqual([]);
  });
});
