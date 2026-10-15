import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as waitForWork } from 'node:timers/promises';
import { createKeyring } from '@helpdock/config';
import {
  accounts,
  attachments,
  brands,
  contactIdentities,
  contacts,
  createDb,
  csatResponses,
  customFieldDefs,
  type DbHandle,
  departments,
  importExternalIds,
  importRecords,
  importRuns,
  outbox,
  runMigrations,
  tags,
  ticketMessages,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { ImportRateLimiter } from '@helpdock/importers';
import {
  FakeZendesk,
  zendeskReferenceDelta,
  zendeskReferenceFixture,
  zendeskReferenceMedia,
} from '@helpdock/importers/testing';
import { createJobProcessor, JOB_DEFINITIONS, mediaProcessJob, silentLogger } from '@helpdock/jobs';
import {
  type ImportMappingsRequest,
  type ImportRunCreate,
  importMappingsRequestSchema,
} from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAttachmentUploadedHandler } from '../media/attachment-events.js';
import { createObjectPurgeHandler } from '../media/object-purge.js';
import { createMediaProcessor } from '../media/process.job.js';
import { FakeStorage, fakeTools } from '../testing/media.js';
import { hasDocker, startPostgres, startRedis } from '../testing/meta-install.js';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { createImportWorkHandler } from './import-events.js';
import { ImportsService } from './imports.service.js';
import {
  createImportConnectorRuntime,
  createZendeskImportConnection,
} from './jobs/connector-runtime.js';
import { createImportProcessor } from './jobs/import-processor.js';

const brandId = uuidv7();
const userId = uuidv7();
const departmentId = uuidv7();
const pendingId = uuidv7();
const closedId = uuidv7();
const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 24).toString('base64') });
const fake = new FakeZendesk(
  {},
  { authorization: 'Bearer synthetic-reference', now: Date.parse('2026-10-15T00:00:00Z') / 1000 },
);

describe.skipIf(!hasDocker)('M11 Zendesk reference migration', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let owner: DbHandle;
  let app: DbHandle;
  let redis: Redis;
  let queue: Queue;
  let worker: Worker;
  let mediaQueue: Queue;
  let mediaWorker: Worker;
  let storage: FakeStorage;
  let directory: string;
  let service: ImportsService;
  let fixture: ReturnType<typeof zendeskReferenceFixture>;
  let vendorStarted = false;
  const failures: string[] = [];
  const tagIds = new Map<string, string>();
  const inBrand = <T>(work: (context: TicketingContext) => Promise<T>) =>
    withSystem(app.db, brandId, (tx) =>
      work({ tx, brandId, actor: { userId, role: 'admin', departmentIds: 'all' } }),
    );

  beforeAll(async () => {
    postgres = await startPostgres();
    redisContainer = await startRedis();
    await runMigrations({
      migrationUrl: postgres.getConnectionUri(),
      appRolePassword: 'reference-tests',
      log: () => {},
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    const runtimeUrl = new URL(postgres.getConnectionUri());
    runtimeUrl.username = 'helpdock_app';
    runtimeUrl.password = 'reference-tests';
    app = createDb({ url: runtimeUrl.toString(), max: 2 });
    redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: null });
    await owner.db.insert(users).values({
      id: userId,
      email: 'reference-importer@example.test',
      name: 'Local importer',
      status: 'active',
    });
    await owner.db.insert(brands).values({ id: brandId, name: 'Reference import', prefix: 'REF' });
    await owner.db.insert(departments).values({ id: departmentId, brandId, name: 'Support' });
    await owner.db
      .insert(userBrandRoles)
      .values({ userId, brandId, role: 'admin', departmentIds: null });
    await owner.db.insert(ticketStatuses).values([
      {
        id: pendingId,
        brandId,
        name: 'Awaiting customer',
        systemState: 'open',
        awaitingCustomer: true,
        isDefault: true,
        color: 'info',
      },
      { id: closedId, brandId, name: 'Closed', systemState: 'closed', color: 'success' },
    ]);
    for (const name of ['migration', ...Array.from({ length: 5 }, (_, index) => `team-${index}`)]) {
      const id = uuidv7();
      tagIds.set(name, id);
      await owner.db.insert(tags).values({ id, brandId, name });
    }
    await fake.server.start();
    vendorStarted = true;
    fixture = zendeskReferenceFixture(fake.server.root);
    for (const ticket of fixture.tickets ?? [])
      fake.addAttachment(String(ticket.id * 100 + 3), zendeskReferenceMedia, {
        contentType: 'application/pdf',
        fileName: `reference-${ticket.id}.pdf`,
      });
    fake.replaceFixture(fixture);
    const limiter = new ImportRateLimiter({ capacity: 100000, perMinute: 10000000 });
    const transport = {
      apiRoot: fake.server.root,
      policy: {
        allowedPorts: [Number(new URL(fake.server.root).port)],
        allowCidrs: ['127.0.0.1/32'],
        lookup: async () => [{ address: '127.0.0.1', family: 4 as const }],
      },
      limiter,
    };
    service = new ImportsService(keyring, (request) =>
      createZendeskImportConnection({
        ...request,
        allowCidrs: [],
        limiter,
        transport,
        log: async () => {},
      }),
    );
    directory = await mkdtemp(path.join(tmpdir(), 'helpdock-zendesk-reference-'));
    storage = new FakeStorage(directory);
    const queueName = `m11-reference-${uuidv7()}`;
    queue = new Queue(queueName, { connection: redis });
    worker = new Worker(
      queueName,
      createImportProcessor({
        db: app.db,
        storage,
        resolve: createImportConnectorRuntime({ db: app.db, keyring, allowCidrs: [] }, transport),
      }),
      { connection: redis, concurrency: 1 },
    );
    worker.on('failed', (_job, error) => failures.push(error.message));
    const mediaQueueName = `m11-reference-media-${uuidv7()}`;
    mediaQueue = new Queue(mediaQueueName, { connection: redis });
    mediaWorker = new Worker(
      mediaQueueName,
      createJobProcessor(
        mediaProcessJob,
        createMediaProcessor({ storage, tools: fakeTools(), scanner: undefined }),
        { db: app.db },
      ),
      { connection: redis, concurrency: 1 },
    );
    mediaWorker.on('failed', (_job, error) => failures.push(error.message));
  }, 300000);
  afterAll(async () => {
    await worker?.close();
    await mediaWorker?.close();
    await mediaQueue?.obliterate({ force: true });
    await mediaQueue?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
    await redis?.quit();
    if (vendorStarted) await fake.server.close();
    await app?.close();
    await owner?.close();
    await redisContainer?.stop();
    await postgres?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function pump(runId: string, running: readonly string[]) {
    const bridge = createImportWorkHandler({
      add: async (step, payload, jobId, delay) => {
        const definition = JOB_DEFINITIONS[`import.${step}`];
        await queue.add(definition.name, payload, { ...definition.options, jobId, delay });
      },
    });
    const upload = createAttachmentUploadedHandler({
      add: async ({ jobId, payload }) => {
        await mediaQueue.add(mediaProcessJob.name, payload, { ...mediaProcessJob.options, jobId });
      },
    });
    const purge = createObjectPurgeHandler(storage);
    const deadline = Date.now() + 1200000;
    while (Date.now() < deadline) {
      if (failures.length) throw new Error(`Reference queue job failed: ${failures[0]}`);
      const events = await owner.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.brandId, brandId),
            isNull(outbox.publishedAt),
            sql`(
            (${outbox.event} = 'import.work_requested' AND ${outbox.payload}->>'runId' = ${runId})
            OR ${outbox.event} = 'attachment.uploaded'
            OR ${outbox.event} = 'media.objects.purge'
          )`,
          ),
        )
        .orderBy(outbox.id)
        .limit(100);
      for (const event of events) {
        const handler =
          event.event === 'attachment.uploaded'
            ? upload
            : event.event === 'media.objects.purge'
              ? purge
              : bridge;
        await withSystem(app.db, brandId, async (tx) => {
          await handler({
            tx,
            brandId,
            event: event.event,
            payload: event.payload,
            outboxId: event.id,
            log: silentLogger,
          });
          await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, event.id));
        });
      }
      const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      if (!run) throw new Error('Missing reference run');
      if (!running.includes(run.status)) return run;
      await waitForWork(50);
    }
    throw new Error('Reference worker exceeded its deadline');
  }

  async function mappings(): Promise<ImportMappingsRequest> {
    const proposed = importMappingsRequestSchema.parse({
      mappings: [
        { kind: 'status', externalValue: 'pending:701', target: { statusId: pendingId } },
        { kind: 'status', externalValue: 'closed', target: { statusId: closedId } },
        { kind: 'status', externalValue: 'solved', target: { statusId: closedId } },
        ...(['low', 'normal', 'high', 'urgent'] as const).map((priority) => ({
          kind: 'priority' as const,
          externalValue: priority,
          target: { priority: priority === 'normal' ? ('medium' as const) : priority },
        })),
        { kind: 'channel', externalValue: 'email', target: { channel: 'email' } },
        ...Array.from({ length: 5 }, (_, index) => ({
          kind: 'group' as const,
          externalValue: String(501 + index),
          target: { departmentId, teamId: null },
        })),
        { kind: 'agent', externalValue: '301', target: { kind: 'existing', userId } },
        ...[...tagIds].map(([externalValue, tagId]) => ({
          kind: 'tag' as const,
          externalValue,
          target: { tagId },
        })),
        {
          kind: 'field',
          externalValue: 'ticket:801',
          target: {
            kind: 'create',
            definition: {
              target: 'ticket',
              key: 'region',
              label: 'Region',
              type: 'select',
              options: ['north'],
            },
          },
        },
        {
          kind: 'field',
          externalValue: 'contact:801',
          target: {
            kind: 'create',
            definition: { target: 'contact', key: 'plan', label: 'Plan', type: 'text' },
          },
        },
        {
          kind: 'field',
          externalValue: 'organization:801',
          target: {
            kind: 'create',
            definition: { target: 'account', key: 'region', label: 'Region', type: 'text' },
          },
        },
      ],
    });
    const existing = await owner.db
      .select()
      .from(customFieldDefs)
      .where(eq(customFieldDefs.brandId, brandId));
    return {
      mappings: proposed.mappings.map((mapping) => {
        if (mapping.kind !== 'field' || mapping.target.kind !== 'create') return mapping;
        const { definition } = mapping.target;
        const field = existing.find(
          (candidate) => candidate.target === definition.target && candidate.key === definition.key,
        );
        return field
          ? { ...mapping, target: { kind: 'existing' as const, fieldId: field.id } }
          : mapping;
      }),
    };
  }

  async function businessSnapshot() {
    const snapshots: Record<string, unknown> = {};
    for (const table of [
      'tickets',
      'ticket_messages',
      'ticket_activity',
      'ticket_participants',
      'ticket_tags',
      'attachments',
      'contacts',
      'contact_identities',
      'accounts',
      'custom_field_defs',
      'user_brand_roles',
      'csat_responses',
      'report_daily',
      'report_agent_daily',
    ]) {
      const [snapshot] = await owner.db.execute(sql`
        SELECT count(*)::int AS total,
          md5(coalesce(string_agg(row_to_json(t)::text || ':' || t.xmin::text, '' ORDER BY row_to_json(t)::text), '')) AS revision
        FROM ${sql.identifier(table)} t WHERE brand_id = ${brandId}
      `);
      snapshots[table] = snapshot;
    }
    return snapshots;
  }

  async function migrate(input: ImportRunCreate) {
    const created = await inBrand((context) => service.create(context, input));
    await inBrand((context) =>
      service.connect(context, created.id, {
        credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-reference' },
        downloadHosts: ['cdn.zendesk.test'],
      }),
    );
    await inBrand((context) =>
      service.scope(context, created.id, {
        entities: [
          'ticket',
          'user',
          'organization',
          'group',
          'contact',
          'message',
          'attachment',
          'field',
          'tag',
          'activity',
          'csat',
        ],
        rebuildAllReports: true,
      }),
    );
    await inBrand((context) => service.extract(context, created.id));
    const extracted = await pump(created.id, ['extracting']);
    expect(extracted.status).toBe('awaiting_mapping');
    const confirmed = await mappings();
    await inBrand((context) => service.confirmMappings(context, created.id, confirmed));
    await inBrand((context) => service.dryRun(context, created.id, { defaultCallingCode: '' }));
    const checked = await pump(created.id, ['dry_run']);
    expect(checked.status).toBe('awaiting_mapping');
    const report = await inBrand((context) => service.dryRunReport(context, created.id));
    expect(report).toMatchObject({ complete: true, errors: 0 });
    const reviewToken = report.reviewToken;
    if (!reviewToken) throw new Error('Missing reference approval token');
    await inBrand((context) =>
      service.start(context, created.id, {
        reviewToken,
        acknowledgeWarnings: true,
      }),
    );
    const completed = await pump(created.id, ['loading', 'finishing']);
    expect(completed).toMatchObject({ status: 'completed', credentialsEncrypted: null });
    expect(failures).toEqual([]);
    return completed.id;
  }

  it('preserves the 500-ticket graph, writes no business rows on repeat and reconciles changed history quietly', async () => {
    const runId = await migrate({ source: 'zendesk', mode: 'full' });
    const loaded = await owner.db.select().from(tickets).where(eq(tickets.brandId, brandId));
    expect(loaded).toHaveLength(500);
    expect(new Set(loaded.map((ticket) => ticket.number)).size).toBe(500);
    for (const ticket of loaded)
      expect(ticket).toMatchObject({
        importSource: 'zendesk',
        assigneeId: userId,
        departmentId,
        custom: { region: 'north' },
      });
    const messages = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.brandId, brandId));
    expect(messages).toHaveLength(1000);
    expect(messages.filter((message) => message.kind === 'note')).toHaveLength(500);
    expect(
      messages.filter((message) => message.authorType === 'staff' && message.authorId === userId),
    ).toHaveLength(500);
    const files = await owner.db.select().from(attachments).where(eq(attachments.brandId, brandId));
    expect(files).toHaveLength(500);
    for (const file of files) {
      expect(file).toMatchObject({
        origin: 'import',
        status: 'ready',
        mime: 'application/pdf',
        size: zendeskReferenceMedia.length,
      });
      expect(await storage.head(file.s3Key)).toMatchObject({ size: zendeskReferenceMedia.length });
    }
    const profiles = await owner.db.select().from(contacts).where(eq(contacts.brandId, brandId));
    expect(profiles).toHaveLength(503);
    const identities = await owner.db
      .select()
      .from(contactIdentities)
      .where(eq(contactIdentities.brandId, brandId));
    expect(identities.every((identity) => !identity.verified)).toBe(true);
    expect(
      await owner.db
        .select()
        .from(importRecords)
        .where(and(eq(importRecords.runId, runId), eq(importRecords.status, 'staged'))),
    ).toEqual([]);
    for (const table of [
      'workflow_runs',
      'ticket_sla_clocks',
      'notifications',
      'ai_calls',
      'webhook_deliveries',
    ]) {
      const count = await owner.db.execute(
        sql`SELECT count(*)::int AS total FROM ${sql.identifier(table)} WHERE brand_id = ${brandId}`,
      );
      expect(count[0]?.total, table).toBe(0);
    }
    const events = await owner.db.select().from(outbox).where(eq(outbox.brandId, brandId));
    expect(
      events
        .filter(
          (event) =>
            !['import.work_requested', 'attachment.uploaded', 'media.objects.purge'].includes(
              event.event,
            ),
        )
        .map((event) => event.event),
    ).toEqual([]);
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(and(eq(importExternalIds.brandId, brandId), eq(importExternalIds.entity, 'ticket'))),
    ).toHaveLength(500);
    const beforeRepeat = await businessSnapshot();
    const beforeRepeatMedia = fake.server.calls.filter((call) =>
      call.path.startsWith('/attachments/token/'),
    ).length;
    const repeatId = await migrate({ source: 'zendesk', mode: 'full' });
    expect(await businessSnapshot()).toEqual(beforeRepeat);
    // Dry-run still verifies each source file; a repeated load must not download it again.
    expect(
      fake.server.calls.filter((call) => call.path.startsWith('/attachments/token/')).length -
        beforeRepeatMedia,
    ).toBe(500);
    fake.advanceTime(120);
    fake.replaceFixture(zendeskReferenceDelta(fixture));
    await migrate({ source: 'zendesk', mode: 'delta', parentRunId: repeatId });
    const [identity] = await owner.db
      .select()
      .from(importExternalIds)
      .where(
        and(
          eq(importExternalIds.brandId, brandId),
          eq(importExternalIds.entity, 'ticket'),
          eq(importExternalIds.externalId, '101'),
        ),
      );
    if (!identity) throw new Error('Missing delta ticket identity');
    const [changed] = await owner.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, identity.helpdockId));
    expect(changed).toMatchObject({
      subject: 'Delta subject',
      statusId: closedId,
      createdAt: new Date('2018-01-01T10:00:00Z'),
    });
    const thread = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, identity.helpdockId));
    expect(thread).toHaveLength(3);
    expect(thread.find((message) => message.bodyText === 'Delta internal note')).toMatchObject({
      kind: 'note',
      authorType: 'staff',
      authorId: userId,
      createdAt: new Date('2026-10-15T00:00:10Z'),
    });
    const [feedback] = await owner.db
      .select()
      .from(csatResponses)
      .where(eq(csatResponses.ticketId, identity.helpdockId));
    expect(feedback).toMatchObject({
      comment: 'Corrected old feedback',
      ratedAt: new Date('2018-01-03T10:00:00Z'),
    });
    const changedProfiles = await owner.db
      .select()
      .from(contacts)
      .where(eq(contacts.brandId, brandId));
    expect(changedProfiles).toHaveLength(503);
    expect(
      changedProfiles.find((profile) => profile.importedDetails?.notes === 'Delta contact note'),
    ).toBeDefined();
    const changedCompanies = await owner.db
      .select()
      .from(accounts)
      .where(eq(accounts.brandId, brandId));
    expect(changedCompanies).toHaveLength(10);
    expect(
      changedCompanies.find((company) => company.importedDetails?.notes === 'Delta company note'),
    ).toBeDefined();
    const afterDelta = await businessSnapshot();
    expect(afterDelta.tickets).toMatchObject({ total: 500 });
    expect(afterDelta.ticket_messages).toMatchObject({ total: 1001 });
    expect(afterDelta.attachments).toEqual(beforeRepeat.attachments);
    for (const table of [
      'workflow_runs',
      'ticket_sla_clocks',
      'notifications',
      'ai_calls',
      'webhook_deliveries',
    ]) {
      const [count] = await owner.db.execute(
        sql`SELECT count(*)::int AS total FROM ${sql.identifier(table)} WHERE brand_id = ${brandId}`,
      );
      expect(count?.total, table).toBe(0);
    }
  }, 2100000);
});
