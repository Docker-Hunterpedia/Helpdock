import { setTimeout as waitForQueue } from 'node:timers/promises';
import { createKeyring, decodeMasterKey, decryptSecret } from '@helpdock/config';
import {
  accounts,
  brands,
  contactIdentities,
  contacts,
  createDb,
  type DbHandle,
  importMappings,
  importRecords,
  importRuns,
  outbox,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { hashImportValue, ImportRateLimiter } from '@helpdock/importers';
import { FakeZendesk } from '@helpdock/importers/testing';
import { JOB_DEFINITIONS, silentLogger as silentJobLogger } from '@helpdock/jobs';
import { type ImportRunView, importRecordSchema } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { seedDevInstall } from '../seed/dev-seed.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { createImportWorkHandler } from './import-events.js';
import {
  createImportConnectorRuntime,
  createZendeskImportConnection,
} from './jobs/connector-runtime.js';
import { createImportProcessor } from './jobs/import-processor.js';

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
      ['GET', `${root()}/${id}/preview/ticket?externalId=42`, undefined],
      ['GET', `${root()}/${id}/preview/contact?externalId=42`, undefined],
      ['GET', `${root()}/${id}/preview/samples`, undefined],
      [
        'PUT',
        `${root()}/${id}/connection`,
        { credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' } },
      ],
      ['POST', `${root()}/${id}/extract`, undefined],
      ['POST', `${root()}/${id}/dry-run`, {}],
      ['GET', `${root()}/${id}/dry-run`, undefined],
      ['PUT', `${root()}/${id}/scope`, { entities: ['ticket'] }],
      ['POST', `${root()}/${id}/pause`, undefined],
      ['POST', `${root()}/${id}/resume`, undefined],
      ['POST', `${root()}/${id}/cancel`, undefined],
      ['GET', `${root()}/${id}/mappings`, undefined],
      ['PUT', `${root()}/${id}/mappings`, { mappings: [] }],
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
            phones: ['invalid-one', 'invalid-two'],
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
      try {
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
          if (selected?.status !== 'dry_run') break;
          await waitForQueue(20);
        }
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
        expect(reportResponse.body).not.toMatch(/synthetic-token|claimToken|mediaAfter|retryAt/);
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
        const before = reportResponse.json();
        await queue.add('import.dry_run', { brandId, runId }, { jobId: `duplicate-${runId}` });
        await worker.close();
        expect((await call('GET', `${root()}/${runId}/dry-run`, adminToken)).json()).toEqual(
          before,
        );
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
});
