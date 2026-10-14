import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as waitForQueue } from 'node:timers/promises';
import {
  accounts,
  attachments,
  auditLog,
  brands,
  contactIdentities,
  contacts,
  createDb,
  csatResponses,
  customFieldDefs,
  type DbHandle,
  departments,
  hcArticles,
  hcArticleVersions,
  hcCategories,
  hcMedia,
  hcSearchDocuments,
  hcSections,
  importExternalIds,
  importLog,
  importMappings,
  importRecords,
  importRuns,
  knowledgeDocuments,
  outbox,
  reportAgentDaily,
  reportDaily,
  runMigrations,
  tags,
  ticketActivity,
  ticketMessages,
  ticketParticipants,
  ticketStatuses,
  tickets,
  ticketTags,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  type Connector,
  type ConnectorContext,
  ConnectorError,
  hashImportValue,
  ImportHttp,
  ImportRateLimiter,
  RateLimited,
  ZendeskConnector,
} from '@helpdock/importers';
import { FakeZendesk, zendeskCoreFixture } from '@helpdock/importers/testing';
import { importLoadJob, JOB_DEFINITIONS } from '@helpdock/jobs';
import { importEntitySchema, importRecordSchema, ticketCcSchema } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContactMergesRepository } from '../../contacts/contact-merges.repository.js';
import { ContactsRepository } from '../../contacts/contacts.repository.js';
import { CsatRepository } from '../../csat/csat.repository.js';
import { forEachImportedArticleBatch } from '../../help-center/imported-articles.js';
import { importedArticlesHandler } from '../../help-center/search/search-events.js';
import { createArticleKnowledgeHandlers } from '../../knowledge/knowledge-events.js';
import { objectKeyBeside } from '../../media/keys.js';
import { MediaRepository } from '../../media/media.repository.js';
import { createObjectPurgeHandler } from '../../media/object-purge.js';
import { createMediaProcessor } from '../../media/process.job.js';
import { RollupRepository } from '../../reports/rollup.repository.js';
import { FakeStorage, fakeTools, silentJobLogger } from '../../testing/media.js';
import { hasDocker, startPostgres, startRedis } from '../../testing/meta-install.js';
import { runTranscription } from '../../transcription/transcribe.job.js';
import { createTranscriptionHandler } from '../../transcription/transcription-events.js';
import { createImportWorkHandler, enqueueImportWork } from '../import-events.js';
import { runImportAttachmentBatch } from '../jobs/attachment-batch.js';
import { claimImportRun, IMPORT_CLAIM_TIMEOUT_MS, renewImportClaim } from '../jobs/claims.js';
import { completeImportRun } from '../jobs/complete-run.js';
import { downloadStagedImportAttachment } from '../jobs/download-attachment.js';
import { storeImportPage } from '../jobs/extract-page.js';
import { runImportExtraction } from '../jobs/extract-run.js';
import { runImportFinishBatch } from '../jobs/finish-batch.js';
import { beginImportFinishing } from '../jobs/finish-readiness.js';
import { createImportProcessor } from '../jobs/import-processor.js';
import { loadAssembledStagedTicket } from '../jobs/load-assembled-ticket.js';
import { runImportLoadBatch } from '../jobs/load-batch.js';
import { loadMappedStagedTicket } from '../jobs/load-mapped-ticket.js';
import { loadNextStagedMetadata } from '../jobs/load-next-metadata.js';
import { loadPreparedStagedRecord } from '../jobs/load-prepared-record.js';
import { loadStagedRecord } from '../jobs/load-record-checkpoint.js';
import { loadStagedReference } from '../jobs/load-reference.js';
import { loadStagedTicket } from '../jobs/load-ticket-checkpoint.js';
import { rebuildImportReportsBatch } from '../jobs/rebuild-reports.js';
import { recoverBrandImports } from '../jobs/recover.js';
import { cancelImportRun, pauseImportRun, resumeImportRun } from '../jobs/run-control.js';
import { saveImportMappings } from '../jobs/save-mappings.js';
import { bindImportSourceAccount } from '../jobs/source-account.js';
import { type TicketLoad, ticketLoadSchema } from './contracts.js';
import { fieldLoadSchema } from './field-contracts.js';
import { ImportWriter } from './import-writer.js';
import { articleLoadSchema, categoryLoadSchema, sectionLoadSchema } from './knowledge-contracts.js';
import { contactLoadSchema, organizationLoadSchema } from './profile-contracts.js';
import { staffLoadSchema } from './staff-contracts.js';

const BRAND = uuidv7();
const OTHER_BRAND = uuidv7();
const USER = uuidv7();
const DEPARTMENT = uuidv7();
const OTHER_DEPARTMENT = uuidv7();
const STATUS = uuidv7();
const CONTACT = uuidv7();
const RUN = uuidv7();

function request(externalId = '42'): TicketLoad {
  return ticketLoadSchema.parse({
    brandId: BRAND,
    runId: RUN,
    source: 'zendesk',
    record: {
      externalId,
      number: '900',
      subject: 'Original ticket',
      status: 'open',
      ccEmails: [],
      tags: [],
      custom: {},
      createdAt: '2019-01-01T00:00:00Z',
      updatedAt: '2019-01-03T00:00:00Z',
    },
    resolved: {
      statusId: STATUS,
      departmentId: DEPARTMENT,
      teamId: null,
      priority: 'high',
      channel: 'email',
      assigneeId: USER,
      contactId: CONTACT,
      custom: {},
    },
    authors: {
      customer: { kind: 'contact', id: CONTACT },
      oldagent: { kind: 'name', name: 'Original agent' },
      staff: { kind: 'staff', id: USER },
    },
    messages: [
      {
        externalId: `m-${externalId}-2`,
        ticketExternalId: externalId,
        authorExternalId: 'oldagent',
        authorKind: 'agent',
        public: false,
        bodyHtml: '<p>Private note</p>',
        createdAt: '2019-01-02T00:00:00Z',
        attachments: [],
      },
      {
        externalId: `m-${externalId}-1`,
        ticketExternalId: externalId,
        authorExternalId: 'customer',
        authorKind: 'customer',
        public: true,
        bodyHtml: '<p>Hello</p><script>bad()</script><img src="https://tracker.invalid/a">',
        createdAt: '2019-01-01T00:00:00Z',
        attachments: [],
      },
    ],
  });
}

describe.skipIf(!hasDocker)('M11 direct history writer', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let owner: DbHandle;
  let app: DbHandle;
  let redis: Redis;
  const writer = new ImportWriter();

  async function stagedTicketScenario(
    externalId: string,
    attachmentUrl = 'https://vendor.example/history.pdf',
    attachmentMime = 'application/pdf',
  ) {
    const input = request(externalId);
    input.runId = uuidv7();
    const rating = {
      externalId: `rating-${externalId}`,
      ticketExternalId: externalId,
      rating: 5,
      ratedAt: '2019-01-03T00:00:00Z',
    };
    input.csat = [rating];
    const attachment = {
      externalId: `file-${externalId}`,
      fileName: 'history.pdf',
      contentType: attachmentMime,
      url: attachmentUrl,
    };
    const message = input.messages[0];
    if (!message) throw new Error('Missing checkpoint message fixture');
    message.attachments.push(attachment);
    await owner.db.insert(importRuns).values({
      id: input.runId,
      brandId: BRAND,
      source: input.source,
      status: 'loading',
      startedBy: USER,
    });
    const [record] = await owner.db
      .insert(importRecords)
      .values({
        brandId: BRAND,
        runId: input.runId,
        entity: 'ticket',
        externalId,
        payload: input.record,
        payloadHash: hashImportValue(input.record),
      })
      .returning({ id: importRecords.id });
    await owner.db.insert(importRecords).values(
      input.messages.map((message) => ({
        brandId: BRAND,
        runId: input.runId,
        entity: 'message' as const,
        externalId: message.externalId,
        parentExternalId: externalId,
        payload: message,
        payloadHash: hashImportValue(message),
      })),
    );
    const sourceAttachment = {
      ...attachment,
      ticketExternalId: externalId,
      messageExternalId: message.externalId,
    };
    await owner.db.insert(importRecords).values([
      {
        brandId: BRAND,
        runId: input.runId,
        entity: 'attachment',
        externalId: attachment.externalId,
        parentExternalId: externalId,
        payload: sourceAttachment,
        payloadHash: hashImportValue(sourceAttachment),
      },
      {
        brandId: BRAND,
        runId: input.runId,
        entity: 'csat',
        externalId: rating.externalId,
        parentExternalId: externalId,
        payload: rating,
        payloadHash: hashImportValue(rating),
      },
    ]);
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId: input.runId, phase: 'loading' }),
    );
    if (!record || !claim) throw new Error('Unable to stage checkpoint fixture');
    return { input, claim, recordId: record.id };
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    redisContainer = await startRedis();
    redis = new Redis(redisContainer.getConnectionUrl());
    await runMigrations({
      migrationUrl: postgres.getConnectionUri(),
      appRolePassword: 'import-tests',
      log: () => {},
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    const runtimeUrl = new URL(postgres.getConnectionUri());
    runtimeUrl.username = 'helpdock_app';
    runtimeUrl.password = 'import-tests';
    app = createDb({ url: runtimeUrl.toString(), max: 2 });
    await owner.db
      .insert(users)
      .values({ id: USER, email: 'importer@example.com', name: 'Importer', status: 'active' });
    await owner.db.insert(brands).values([
      { id: BRAND, name: 'Import', prefix: 'IMP' },
      { id: OTHER_BRAND, name: 'Other', prefix: 'OTH' },
    ]);
    await owner.db.insert(departments).values([
      { id: DEPARTMENT, brandId: BRAND, name: 'Support' },
      { id: OTHER_DEPARTMENT, brandId: OTHER_BRAND, name: 'Other' },
    ]);
    await owner.db.insert(ticketStatuses).values({
      id: STATUS,
      brandId: BRAND,
      name: 'Open',
      systemState: 'open',
      isDefault: true,
      color: 'info',
    });
    await owner.db
      .insert(contacts)
      .values({ id: CONTACT, brandId: BRAND, name: 'Original customer' });
    await owner.db
      .insert(userBrandRoles)
      .values({ userId: USER, brandId: BRAND, role: 'agent', departmentIds: [DEPARTMENT] });
    await owner.db.insert(customFieldDefs).values([
      { brandId: BRAND, target: 'account', key: 'region', label: 'Region', type: 'text' },
      {
        brandId: BRAND,
        target: 'contact',
        key: 'tier',
        label: 'Tier',
        type: 'select',
        options: ['gold', 'silver'],
      },
    ]);
    await owner.db
      .insert(importRuns)
      .values({ id: RUN, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
  }, 300000);
  afterEach(async () => {
    // A failed lease assertion must not hold the brand hostage for later scenarios.
    await owner?.db
      .update(importRuns)
      .set({ claimToken: null, claimedAt: null })
      .where(isNotNull(importRuns.claimToken));
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await redis?.quit();
    await redisContainer?.stop();
    await postgres?.stop();
  });

  it('replaces mappings in bounded batches and invalidates the previous dry-run approval', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'ready',
      startedBy: USER,
      dryRunReport: { approved: true },
    });
    await owner.db.insert(importMappings).values({
      brandId: BRAND,
      runId,
      kind: 'status',
      externalValue: 'old',
      target: { statusId: STATUS },
    });
    const proposed = Array.from({ length: 1001 }, (_, index) => ({
      kind: 'status' as const,
      externalValue: `source-${index}`,
      target: { statusId: STATUS },
    }));
    await withSystem(app.db, BRAND, (tx) =>
      saveImportMappings(tx, { brandId: BRAND, runId }, proposed),
    );
    const stored = await owner.db
      .select()
      .from(importMappings)
      .where(eq(importMappings.runId, runId));
    expect(stored).toHaveLength(1001);
    expect(new Set(stored.map((mapping) => mapping.externalValue))).toEqual(
      new Set(proposed.map((mapping) => mapping.externalValue)),
    );
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run).toMatchObject({ status: 'awaiting_mapping', dryRunReport: null });
    await withSystem(app.db, BRAND, (tx) => saveImportMappings(tx, { brandId: BRAND, runId }, []));
    expect(
      await owner.db.select().from(importMappings).where(eq(importMappings.runId, runId)),
    ).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it.each(['dry_run', 'loading', 'paused', 'completed'] as const)(
    'refuses mapping changes while a run is %s',
    async (status) => {
      const runId = uuidv7();
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: BRAND,
        source: 'zendesk',
        status,
        startedBy: USER,
        pausedFrom: status === 'paused' ? 'loading' : null,
      });
      await expect(
        withSystem(app.db, BRAND, (tx) => saveImportMappings(tx, { brandId: BRAND, runId }, [])),
      ).rejects.toMatchObject({ code: 'run-not-editable' });
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.status,
      ).toBe(status);
    },
  );

  it('retains mappings and their approval after rollback, duplicate input or a foreign-brand request', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'ready',
      startedBy: USER,
      dryRunReport: { approved: true },
    });
    const mapping = {
      kind: 'status' as const,
      externalValue: 'open',
      target: { statusId: STATUS },
    };
    await owner.db.insert(importMappings).values({ brandId: BRAND, runId, ...mapping });
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await saveImportMappings(tx, { brandId: BRAND, runId }, []);
        throw new Error('transaction interrupted');
      }),
    ).rejects.toThrow('transaction interrupted');
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        saveImportMappings(tx, { brandId: BRAND, runId }, [mapping, mapping]),
      ),
    ).rejects.toThrow('A source value has more than one mapping');
    await expect(
      withSystem(app.db, OTHER_BRAND, (tx) =>
        saveImportMappings(tx, { brandId: OTHER_BRAND, runId }, []),
      ),
    ).rejects.toMatchObject({ code: 'run-unavailable' });
    expect(
      await owner.db.select().from(importMappings).where(eq(importMappings.runId, runId)),
    ).toMatchObject([mapping]);
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0],
    ).toMatchObject({ status: 'ready', dryRunReport: { approved: true } });
  });

  it('retains source audit dates, actors and changes without executing events, and updates the same event on delta', async () => {
    const input = request('source-audit-history');
    input.activities = [
      {
        externalId: 'source-status-event',
        ticketExternalId: input.record.externalId,
        authorExternalId: 'oldagent',
        authorKind: 'agent',
        action: 'status.changed',
        from: { status: 'open' },
        to: { status: 'pending' },
        details: { auditId: '1001' },
        createdAt: '2019-01-02T00:00:00+03:00',
      },
      {
        externalId: 'source-assignee-event',
        ticketExternalId: input.record.externalId,
        authorExternalId: 'staff',
        authorKind: 'agent',
        action: 'assignee.changed',
        from: { assigneeId: null },
        to: { assigneeId: '301' },
        createdAt: '2019-01-02T00:00:00Z',
      },
    ];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const history = await owner.db
      .select()
      .from(ticketActivity)
      .where(eq(ticketActivity.ticketId, loaded.ticketId));
    const sourceEvents = history.filter((event) => event.action === 'ticket.imported.event');
    expect(sourceEvents).toHaveLength(2);
    expect(sourceEvents.find((event) => event.actorType === 'system')).toMatchObject({
      from: { status: 'open' },
      createdAt: new Date('2019-01-01T21:00:00Z'),
      to: {
        changes: { status: 'pending' },
        sourceEvent: {
          action: 'status.changed',
          authorDisplay: 'Original agent',
          details: { auditId: '1001' },
        },
      },
    });
    expect(sourceEvents.find((event) => event.actorType === 'staff')).toMatchObject({
      actorId: USER,
    });
    const before = [
      ...(await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM ticket_activity WHERE ticket_id = ${loaded.ticketId}`,
      )),
    ];
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'unchanged',
    });
    expect([
      ...(await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM ticket_activity WHERE ticket_id = ${loaded.ticketId}`,
      )),
    ]).toEqual(before);
    const originalId = sourceEvents.find((event) => event.actorType === 'system')?.id;
    const sourceEvent = input.activities[0];
    if (!originalId || !sourceEvent) throw new Error('Expected historical source event');
    input.activities[0] = {
      ...sourceEvent,
      to: { status: '[redacted]' },
      details: { redacted: true },
    };
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      await owner.db.select().from(ticketActivity).where(eq(ticketActivity.id, originalId)),
    ).toMatchObject([
      { to: { changes: { status: '[redacted]' }, sourceEvent: { details: { redacted: true } } } },
    ]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(await redis.keys('bull:import:*')).toEqual([]);
  });

  it.each([
    { author: 'oldagent', failure: { name: 'ZodError' } },
    { author: 'missing-agent', failure: { code: 'author-unmapped' } },
  ])(
    'refuses an invalid audit with $author before domain rows survive',
    async ({ author, failure }) => {
      const input = request(`invalid-source-audit-${author}`);
      input.activities = [
        {
          externalId: `event-${author}`,
          ticketExternalId: author === 'oldagent' ? 'wrong-ticket' : input.record.externalId,
          authorExternalId: author,
          authorKind: 'agent',
          action: 'status.changed',
          createdAt: '2019-01-02T00:00:00Z',
        },
      ];
      await expect(
        withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input)),
      ).rejects.toMatchObject(failure);
      expect(
        await owner.db
          .select()
          .from(importExternalIds)
          .where(eq(importExternalIds.externalId, input.record.externalId)),
      ).toEqual([]);
    },
  );

  it('includes staged audit events in the fenced thread checkpoint and refuses omitted history', async () => {
    const scenario = await stagedTicketScenario('checkpoint-source-audit');
    const event = {
      externalId: 'checkpoint-event',
      ticketExternalId: scenario.input.record.externalId,
      authorKind: 'system' as const,
      action: 'status.changed',
      to: { status: 'pending' },
      createdAt: '2019-01-02T00:00:00Z',
    };
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: scenario.input.runId,
      entity: 'activity',
      externalId: event.externalId,
      parentExternalId: event.ticketExternalId,
      payload: event,
      payloadHash: hashImportValue(event),
    });
    await expect(
      withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario)),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    scenario.input.activities = [event];
    expect(await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario))).toMatchObject({
      state: 'loaded',
    });
    const [run] = await owner.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, scenario.input.runId));
    expect(run?.counts).toMatchObject({ loaded: { activity: 1 } });
    const [record] = await owner.db
      .select()
      .from(importRecords)
      .where(eq(importRecords.externalId, event.externalId));
    expect(record).toMatchObject({ status: 'loaded' });
    expect(record?.helpdockId).not.toBeNull();
  });

  it('commits staged ticket/thread progress atomically and resumes after a rolled-back worker transaction', async () => {
    const scenario = await stagedTicketScenario('checkpoint-crash');
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await loadStagedTicket(tx, scenario);
        throw new Error('simulated worker termination before commit');
      }),
    ).rejects.toThrow('simulated worker termination');
    let rows = await owner.db
      .select()
      .from(importRecords)
      .where(eq(importRecords.runId, scenario.input.runId));
    expect(rows.every((row) => row.status === 'staged' && row.helpdockId === null)).toBe(true);
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.externalId, scenario.input.record.externalId)),
    ).toEqual([]);
    const loaded = await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
    expect(loaded).toMatchObject({ state: 'loaded', outcome: 'created', messages: 2 });
    rows = await owner.db
      .select()
      .from(importRecords)
      .where(eq(importRecords.runId, scenario.input.runId));
    expect(rows.every((row) => row.status === 'loaded' && row.helpdockId !== null)).toBe(true);
    const [run] = await owner.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, scenario.input.runId));
    expect(run?.counts).toEqual({ loaded: { ticket: 1, message: 2, attachment: 1, csat: 1 } });
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${loaded.ticketId}`,
    );
    expect(await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario))).toEqual({
      state: 'already_loaded',
      ticketId: loaded.ticketId,
    });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        loadStagedTicket(tx, {
          ...scenario,
          input: {
            ...scenario.input,
            resolved: { ...scenario.input.resolved, priority: 'urgent' },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect([
      ...(await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${loaded.ticketId}`,
      )),
    ]).toEqual([...before]);
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.input.runId)))[0]
        ?.counts,
    ).toEqual(run?.counts);
    expect(await owner.db.select().from(outbox)).toEqual([]);
    await owner.db
      .update(tickets)
      .set({ deletedAt: new Date() })
      .where(eq(tickets.id, loaded.ticketId));
    await expect(
      withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario)),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
  });

  it.each(['omitted message', 'changed message', 'different source'])(
    'refuses a checkpoint with %s before writing domain records',
    async (scenarioName) => {
      const scenario = await stagedTicketScenario(`checkpoint-${scenarioName}`);
      if (scenarioName === 'omitted message') scenario.input.messages.pop();
      if (scenarioName === 'changed message' && scenario.input.messages[0])
        scenario.input.messages[0].bodyHtml = '<p>Altered history</p>';
      if (scenarioName === 'different source') scenario.input.source = 'freshdesk';
      await expect(
        withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario)),
      ).rejects.toMatchObject({ code: 'mapping-invalid' });
      expect(
        await owner.db
          .select()
          .from(importExternalIds)
          .where(eq(importExternalIds.externalId, scenario.input.record.externalId)),
      ).toEqual([]);
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.input.runId)))[0]
          ?.counts,
      ).toEqual({});
    },
  );

  it('fences a paused or replaced load worker before any ticket writes', async () => {
    const scenario = await stagedTicketScenario('checkpoint-paused');
    const scope = { brandId: BRAND, runId: scenario.input.runId };
    expect(await withSystem(app.db, BRAND, (tx) => pauseImportRun(tx, scope))).toBe(true);
    await expect(
      withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario)),
    ).rejects.toMatchObject({ name: 'ImportClaimLost' });
    expect(await withSystem(app.db, BRAND, (tx) => resumeImportRun(tx, scope))).toBe('loading');
    const replacement = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'loading' }),
    );
    if (!replacement) throw new Error('Unable to reclaim resumed run');
    await expect(
      withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario)),
    ).rejects.toMatchObject({ name: 'ImportClaimLost' });
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        loadStagedTicket(tx, { ...scenario, claim: replacement }),
      ),
    ).toMatchObject({ state: 'loaded', messages: 2 });
  });

  it('refuses a thread over the materialization budget before reading its full payloads into the worker', async () => {
    const scenario = await stagedTicketScenario('checkpoint-oversized');
    await owner.db.execute(sql`INSERT INTO import_records (id, brand_id, run_id, entity, external_id, parent_external_id, payload, payload_hash)
      SELECT gen_random_uuid(), ${BRAND}, ${scenario.input.runId}, 'message', 'oversized-' || n, ${scenario.input.record.externalId},
        jsonb_build_object('externalId', 'oversized-' || n, 'ticketExternalId', ${scenario.input.record.externalId}::text,
          'authorKind', 'customer', 'public', true, 'bodyHtml', repeat('x', 2097152),
          'createdAt', '2019-01-01T00:00:00Z', 'attachments', '[]'::jsonb), repeat('0', 64)
      FROM generate_series(1, 26) AS n`);
    await expect(
      withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario)),
    ).rejects.toMatchObject({ code: 'thread-too-large' });
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.externalId, scenario.input.record.externalId)),
    ).toEqual([]);
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.input.runId)))[0]
        ?.counts,
    ).toEqual({});
  });

  it.each(['soft deleted', 'purged'])(
    'refuses to silently reuse a %s imported ticket on repeat or delta',
    async (mode) => {
      const input = request(`unavailable-target-${mode}`);
      const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
      if (mode === 'purged') await owner.db.delete(tickets).where(eq(tickets.id, loaded.ticketId));
      else
        await owner.db
          .update(tickets)
          .set({ deletedAt: new Date() })
          .where(eq(tickets.id, loaded.ticketId));
      await expect(
        withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input)),
      ).rejects.toMatchObject({ code: 'target-unavailable' });
      input.record.updatedAt = '2020-01-01T00:00:00Z';
      await expect(
        withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input)),
      ).rejects.toMatchObject({ code: 'target-unavailable' });
    },
  );

  it('refuses a purged historical message on both unchanged repeats and changed deltas', async () => {
    const input = request('purged-message-history');
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const [message] = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, loaded.ticketId));
    if (!message) throw new Error('Missing imported message');
    await owner.db.delete(ticketMessages).where(eq(ticketMessages.id, message.id));
    await expect(withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).rejects.toMatchObject(
      { code: 'target-unavailable' },
    );
    input.record.subject = 'Changed after purge';
    await expect(withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).rejects.toMatchObject(
      { code: 'target-unavailable' },
    );
    expect(
      (await owner.db.select().from(tickets).where(eq(tickets.id, loaded.ticketId)))[0]?.subject,
    ).toBe('Original ticket');
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('updates edited and redacted source message bodies in place without sending or appending history', async () => {
    const input = request('edited-message-history');
    const source = input.messages[0];
    if (!source) throw new Error('Missing historical note');
    source.attachments = [
      {
        externalId: 'edited-history-file',
        fileName: 'history.pdf',
        size: 10,
        contentType: 'application/pdf',
        url: 'https://vendor.invalid/old',
      },
    ];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const [before] = await owner.db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, loaded.ticketId), eq(ticketMessages.kind, 'note')));
    if (!before) throw new Error('Missing historical note');
    source.bodyHtml = '<p>Corrected note</p><script>bad()</script>';
    const sourceFile = source.attachments[0];
    if (!sourceFile) throw new Error('Missing historical attachment');
    sourceFile.url = 'https://vendor.invalid/refreshed';
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'updated',
      messages: 0,
    });
    const [edited] = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.id, before.id));
    expect(edited).toMatchObject({
      id: before.id,
      seq: before.seq,
      createdAt: before.createdAt,
      bodyText: 'Corrected note',
      kind: 'note',
      authorDisplay: 'Original agent',
    });
    expect(edited?.bodyHtml).not.toContain('<script');
    input.authors.oldagent = { kind: 'name', name: 'Corrected historical name' };
    source.bodyHtml = '<p>[redacted]</p>';
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      (await owner.db.select().from(ticketMessages).where(eq(ticketMessages.id, before.id)))[0]
        ?.bodyText,
    ).toBe('[redacted]');
    const revisions = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${loaded.ticketId}`,
    );
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'unchanged',
      messages: 0,
    });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${loaded.ticketId}`,
      ),
    ).toEqual(revisions);
    expect(
      await owner.db.select().from(attachments).where(eq(attachments.messageId, before.id)),
    ).toHaveLength(1);
    source.attachments = [];
    source.bodyHtml = '<p>Changed with removed attachment</p>';
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      (await owner.db.select().from(ticketMessages).where(eq(ticketMessages.id, before.id)))[0]
        ?.bodyText,
    ).toBe('Changed with removed attachment');
    expect(
      await owner.db.select().from(attachments).where(eq(attachments.messageId, before.id)),
    ).toEqual([]);
    const cleanup = await owner.db.select().from(outbox);
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]?.event).toBe('media.objects.purge');
    if (!cleanup[0]) throw new Error('Missing durable media cleanup');
    await owner.db.delete(outbox).where(eq(outbox.id, cleanup[0].id));
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(await redis.dbsize()).toBe(0);
  });

  it('updates a source subject on delta while retaining the original creation date', async () => {
    const input = request('subject-delta');
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    input.record.subject = 'Changed source subject';
    input.record.updatedAt = '2020-01-01T00:00:00Z';
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'updated',
      messages: 0,
    });
    const [ticket] = await owner.db.select().from(tickets).where(eq(tickets.id, loaded.ticketId));
    expect(ticket?.subject).toBe(input.record.subject);
    expect(ticket?.createdAt.toISOString()).toBe('2019-01-01T00:00:00.000Z');
  });

  it('retains a source CC identity without inventing an email, refuses missing/foreign mappings and repeats without writes', async () => {
    const ccId = uuidv7();
    const foreignId = uuidv7();
    await owner.db.insert(contacts).values([
      { id: ccId, brandId: BRAND, name: 'Original CC' },
      { id: foreignId, brandId: OTHER_BRAND, name: 'Other brand' },
    ]);
    const input = request('cc-source-id');
    input.record.ccExternalIds = ['vendor-cc'];
    await expect(withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).rejects.toThrow(
      'Every source CC',
    );
    input.resolved.ccContacts = [{ externalId: 'vendor-cc', contactId: foreignId }];
    await expect(withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).rejects.toMatchObject(
      { code: 'target-unavailable' },
    );
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.externalId, input.record.externalId)),
    ).toEqual([]);
    input.resolved.ccContacts = [{ externalId: 'vendor-cc', contactId: ccId }];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const [participant] = await owner.db
      .select()
      .from(ticketParticipants)
      .where(eq(ticketParticipants.ticketId, loaded.ticketId));
    expect(participant).toMatchObject({ contactId: ccId, address: null, source: 'import' });
    expect(ticketCcSchema.parse({ ...participant, name: 'Original CC' })).toMatchObject({
      source: 'import',
      address: null,
    });
    const before = [
      ...(await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM ticket_participants WHERE ticket_id = ${loaded.ticketId}`,
      )),
    ];
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'unchanged',
    });
    expect([
      ...(await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM ticket_participants WHERE ticket_id = ${loaded.ticketId}`,
      )),
    ]).toEqual(before);
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(await redis.dbsize()).toBe(0);
  });

  it('fills an imported CC email when it becomes known and removes source-owned CCs on delta while retaining manual participants', async () => {
    const ccId = uuidv7();
    const manualId = uuidv7();
    await owner.db.insert(contacts).values([
      { id: ccId, brandId: BRAND, name: 'Source CC' },
      { id: manualId, brandId: BRAND, name: 'Manual CC' },
    ]);
    const input = request('cc-reconcile');
    input.record.ccExternalIds = ['cc-user'];
    input.resolved.ccContacts = [{ externalId: 'cc-user', contactId: ccId }];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    await owner.db.insert(contactIdentities).values({
      brandId: BRAND,
      contactId: ccId,
      kind: 'email',
      value: 'known-cc@example.invalid',
      source: 'import',
      verified: false,
    });
    input.record.ccEmails = ['known-cc@example.invalid'];
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      await owner.db
        .select()
        .from(ticketParticipants)
        .where(eq(ticketParticipants.ticketId, loaded.ticketId)),
    ).toMatchObject([{ contactId: ccId, address: 'known-cc@example.invalid', source: 'import' }]);
    await owner.db.insert(ticketParticipants).values({
      brandId: BRAND,
      departmentId: DEPARTMENT,
      ticketId: loaded.ticketId,
      contactId: manualId,
      address: null,
      source: 'agent',
      addedBy: USER,
    });
    input.record.ccEmails = [];
    input.record.ccExternalIds = [];
    input.resolved.ccContacts = [];
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      await owner.db
        .select()
        .from(ticketParticipants)
        .where(eq(ticketParticipants.ticketId, loaded.ticketId)),
    ).toMatchObject([{ contactId: manualId, source: 'agent' }]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('does not create an email-only CC that bypasses required contact fields', async () => {
    const brandId = uuidv7();
    const departmentId = uuidv7();
    const statusId = uuidv7();
    const runId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Required CC fields', prefix: 'REQ' });
    await owner.db.insert(departments).values({ id: departmentId, brandId, name: 'Support' });
    await owner.db.insert(ticketStatuses).values({
      id: statusId,
      brandId,
      name: 'Open',
      systemState: 'open',
      isDefault: true,
      color: 'info',
    });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', status: 'loading', startedBy: USER });
    await owner.db.insert(customFieldDefs).values({
      brandId,
      target: 'contact',
      key: 'account_reference',
      label: 'Account reference',
      type: 'text',
      required: true,
    });
    const input = request('cc-required-field');
    input.brandId = brandId;
    input.runId = runId;
    input.resolved = {
      ...input.resolved,
      departmentId,
      statusId,
      contactId: null,
      assigneeId: null,
    };
    input.messages = [];
    input.authors = {};
    input.record.ccEmails = ['required-cc@example.invalid'];
    await expect(
      withSystem(app.db, brandId, (tx) => writer.ticket(tx, input)),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(await owner.db.select().from(contacts).where(eq(contacts.brandId, brandId))).toEqual([]);
    expect(await owner.db.select().from(tickets).where(eq(tickets.brandId, brandId))).toEqual([]);
  });

  it('preserves mapped tags and CC identities, repeats without writes and replaces source tags on delta', async () => {
    const tagId = uuidv7();
    await owner.db.insert(tags).values({ id: tagId, brandId: BRAND, name: 'Historical' });
    await owner.db.insert(contactIdentities).values({
      brandId: BRAND,
      contactId: CONTACT,
      kind: 'email',
      value: 'requester@example.com',
      verified: true,
      source: 'manual',
    });
    const input = request('labels-and-cc');
    input.record.tags = ['legacy', 'discard'];
    input.resolved.tags = [
      { externalValue: 'legacy', tagId },
      { externalValue: 'discard', tagId: null },
    ];
    input.record.ccEmails = ['CC@example.com', 'cc@example.com', 'requester@example.com'];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const beforeTags = await owner.db
      .select()
      .from(ticketTags)
      .where(eq(ticketTags.ticketId, loaded.ticketId));
    const beforeCc = await owner.db
      .select()
      .from(ticketParticipants)
      .where(eq(ticketParticipants.ticketId, loaded.ticketId));
    expect(beforeTags).toHaveLength(1);
    expect(beforeTags[0]?.tagId).toBe(tagId);
    expect(beforeCc).toHaveLength(1);
    expect(beforeCc[0]?.address).toBe('cc@example.com');
    const [ccIdentity] = await owner.db
      .select()
      .from(contactIdentities)
      .where(eq(contactIdentities.contactId, beforeCc[0]?.contactId ?? 'missing-contact'));
    expect(ccIdentity).toMatchObject({
      value: 'cc@example.com',
      verified: false,
      source: 'import',
    });
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      ticketId: loaded.ticketId,
      outcome: 'unchanged',
    });
    expect(
      await owner.db.select().from(ticketTags).where(eq(ticketTags.ticketId, loaded.ticketId)),
    ).toEqual(beforeTags);
    expect(
      await owner.db
        .select()
        .from(ticketParticipants)
        .where(eq(ticketParticipants.ticketId, loaded.ticketId)),
    ).toEqual(beforeCc);
    input.record.tags = [];
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      await owner.db.select().from(ticketTags).where(eq(ticketTags.ticketId, loaded.ticketId)),
    ).toEqual([]);
    expect(
      await owner.db
        .select()
        .from(ticketParticipants)
        .where(eq(ticketParticipants.ticketId, loaded.ticketId)),
    ).toEqual(beforeCc);
  });

  it('keeps distinct historical ratings without inventing closes or exposing them as live surveys', async () => {
    const input = request('ratings');
    input.csat = [
      {
        externalId: 'rating-a',
        ticketExternalId: 'ratings',
        rating: 5,
        ratedAt: '2019-01-04T10:00:00Z',
        closedAt: '2019-01-03T00:00:00Z',
        comment: 'Original answer',
        sourceDetails: { api: 'legacy', score: 'good', ratedAtBasis: 'source-created-at' },
      },
      {
        externalId: 'rating-b',
        ticketExternalId: 'ratings',
        rating: 2,
        ratedAt: '2019-01-04T10:00:00Z',
      },
    ];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const before = await owner.db
      .select()
      .from(csatResponses)
      .where(eq(csatResponses.ticketId, loaded.ticketId));
    expect(before).toHaveLength(2);
    expect(before.find((row) => row.importedExternalId === 'rating-a')?.importedDetails).toEqual({
      api: 'legacy',
      score: 'good',
      ratedAtBasis: 'source-created-at',
    });
    expect(before.find((row) => row.importedExternalId === 'rating-b')?.closedAt).toBeNull();
    for (const row of before) {
      expect(row.ratedAt?.toISOString()).toBe('2019-01-04T10:00:00.000Z');
      expect(row.createdAt.toISOString()).toBe('2019-01-04T10:00:00.000Z');
      expect(row.expiresAt.getTime()).toBe(0);
      expect(row.ratedVia).toBe('import');
    }
    const repository = new CsatRepository();
    expect(
      await withSystem(app.db, BRAND, (tx) => repository.latestForTicket(tx, loaded.ticketId)),
    ).toBeUndefined();
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      await owner.db
        .select()
        .from(csatResponses)
        .where(eq(csatResponses.ticketId, loaded.ticketId)),
    ).toEqual(before);
    const survey = {
      id: uuidv7(),
      brandId: BRAND,
      ticketId: loaded.ticketId,
      departmentId: DEPARTMENT,
      closedAt: new Date('2019-01-03T00:00:00Z'),
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    };
    expect(
      await withSystem(app.db, BRAND, (tx) => repository.insertSurvey(tx, survey)),
    ).toMatchObject({ id: survey.id });
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        repository.insertSurvey(tx, { ...survey, id: uuidv7() }),
      ),
    ).toBeUndefined();
    expect(
      await withSystem(app.db, BRAND, (tx) => repository.latestForTicket(tx, loaded.ticketId)),
    ).toMatchObject({ id: survey.id });
    const firstRating = input.csat[0];
    if (!firstRating) throw new Error('Missing rating fixture');
    firstRating.rating = 4;
    firstRating.comment = 'Corrected answer';
    firstRating.sourceDetails = {
      api: 'legacy',
      score: 'good',
      reason: 'Corrected source metadata',
    };
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const changed = await owner.db
      .select()
      .from(csatResponses)
      .where(eq(csatResponses.ticketId, loaded.ticketId));
    expect(changed).toHaveLength(3);
    expect(changed.find((row) => row.importedExternalId === 'rating-a')).toMatchObject({
      id: before.find((row) => row.importedExternalId === 'rating-a')?.id,
      rating: 4,
      comment: 'Corrected answer',
      importedDetails: { api: 'legacy', score: 'good', reason: 'Corrected source metadata' },
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(await redis.dbsize()).toBe(0);
  });

  it('refuses missing or cross-brand tag mappings without leaving a ticket behind', async () => {
    const foreignTag = uuidv7();
    await owner.db.insert(tags).values({ id: foreignTag, brandId: OTHER_BRAND, name: 'Foreign' });
    const input = request('invalid-label');
    input.record.tags = ['legacy'];
    await expect(withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).rejects.toThrow();
    input.resolved.tags = [{ externalValue: 'legacy', tagId: foreignTag }];
    await expect(withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).rejects.toMatchObject(
      { code: 'mapping-invalid' },
    );
    const ledger = await owner.db
      .select()
      .from(importExternalIds)
      .where(eq(importExternalIds.externalId, 'invalid-label'));
    expect(ledger).toEqual([]);
  });

  it('rolls imported name-only replies, resolution and ratings onto their original days without inventing agent identities', async () => {
    const departmentId = uuidv7();
    const closedStatus = uuidv7();
    await owner.db
      .insert(departments)
      .values({ id: departmentId, brandId: BRAND, name: 'Historical reports' });
    await owner.db.insert(ticketStatuses).values({
      id: closedStatus,
      brandId: BRAND,
      name: 'Historically closed',
      systemState: 'closed',
      color: 'success',
    });
    const input = request('reported-history');
    input.record.createdAt = '2018-01-01T00:00:00Z';
    input.record.updatedAt = '2018-01-03T00:00:00Z';
    input.record.closedAt = '2018-01-03T00:00:00Z';
    input.resolved.departmentId = departmentId;
    input.resolved.statusId = closedStatus;
    input.resolved.assigneeId = null;
    input.messages = [
      {
        externalId: 'historical-system',
        ticketExternalId: 'reported-history',
        authorKind: 'system',
        public: true,
        bodyText: 'System receipt',
        createdAt: '2018-01-01T12:00:00Z',
        attachments: [],
      },
      {
        externalId: 'historical-answer',
        ticketExternalId: 'reported-history',
        authorExternalId: 'oldagent',
        authorKind: 'agent',
        public: true,
        bodyText: 'Agent answer',
        createdAt: '2018-01-02T00:00:00Z',
        attachments: [],
      },
    ];
    input.csat = [
      {
        externalId: 'historical-rating',
        ticketExternalId: 'reported-history',
        rating: 5,
        ratedAt: '2018-01-04T00:00:00Z',
      },
    ];
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    await withSystem(app.db, BRAND, (tx) =>
      new RollupRepository().rebuild(tx, {
        brandId: BRAND,
        timezone: 'UTC',
        range: { from: '2018-01-01', to: '2018-01-04' },
        countReopens: false,
      }),
    );
    const days = await owner.db
      .select()
      .from(reportDaily)
      .where(eq(reportDaily.departmentId, departmentId));
    expect(days.find((row) => row.day === '2018-01-01')).toMatchObject({
      created: 1,
      firstResponseMs: [],
    });
    expect(days.find((row) => row.day === '2018-01-02')).toMatchObject({
      firstResponseMs: [86400000],
    });
    expect(days.find((row) => row.day === '2018-01-03')).toMatchObject({
      resolved: 1,
      resolutionMs: [172800000],
    });
    expect(days.find((row) => row.day === '2018-01-04')).toMatchObject({ csat5: 1 });
    expect(
      await owner.db
        .select()
        .from(reportAgentDaily)
        .where(eq(reportAgentDaily.departmentId, departmentId)),
    ).toEqual([]);
    expect(
      days.every(
        (row) =>
          row.slaResponseMet === 0 &&
          row.slaResponseBreached === 0 &&
          row.slaResolutionMet === 0 &&
          row.slaResolutionBreached === 0,
      ),
    ).toBe(true);
  });

  it('creates invited agents without mail or tokens, uses them as historical authors and preserves manual roles on repeat', async () => {
    const input = staffLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      record: {
        externalId: 'old-invited-agent',
        kind: 'agent',
        name: 'Old agent',
        email: 'OLD-AGENT@example.com',
        active: true,
      },
      mapping: { kind: 'invited', departmentIds: [DEPARTMENT] },
    });
    const first = await withSystem(app.db, BRAND, (tx) => writer.staff(tx, input));
    expect(first.outcome).toBe('created');
    if (first.author.kind !== 'staff') throw new Error('Expected a staff mapping');
    const userId = first.author.id;
    const [user] = await owner.db.select().from(users).where(eq(users.id, userId));
    const [membership] = await owner.db
      .select()
      .from(userBrandRoles)
      .where(eq(userBrandRoles.userId, userId));
    expect(user).toMatchObject({
      email: 'old-agent@example.com',
      status: 'invited',
      passwordHash: null,
      installAdmin: false,
    });
    expect(membership).toMatchObject({
      role: 'agent',
      source: 'manual',
      departmentIds: [DEPARTMENT],
    });
    expect(
      await owner.db.select().from(auditLog).where(eq(auditLog.targetId, userId)),
    ).toHaveLength(1);
    const nextRun = uuidv7();
    await owner.db.insert(importRuns).values({
      id: nextRun,
      brandId: BRAND,
      source: 'zendesk',
      status: 'loading',
      startedBy: USER,
    });
    expect(
      await withSystem(app.db, BRAND, (tx) => writer.staff(tx, { ...input, runId: nextRun })),
    ).toMatchObject({ author: first.author, outcome: 'unchanged' });
    expect(
      await owner.db.select().from(userBrandRoles).where(eq(userBrandRoles.userId, userId)),
    ).toEqual([membership]);
    const ticket = request('invited-agent-history');
    ticket.resolved.assigneeId = userId;
    ticket.authors.oldagent = first.author;
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, ticket));
    const messages = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, loaded.ticketId));
    expect(messages.find((row) => row.kind === 'note')).toMatchObject({
      authorType: 'staff',
      authorId: userId,
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(await redis.dbsize()).toBe(0);
    expect(
      await owner.db.select().from(auditLog).where(eq(auditLog.targetId, userId)),
    ).toHaveLength(1);
  });

  it('maps existing staff or a name explicitly and refuses email collisions, foreign departments and deactivated targets', async () => {
    const base = staffLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      record: {
        externalId: 'linked-agent',
        kind: 'agent',
        name: 'Vendor name',
        email: 'importer@example.com',
        active: true,
      },
      mapping: { kind: 'existing', userId: USER },
    });
    const before = await owner.db.select().from(users).where(eq(users.id, USER));
    expect(await withSystem(app.db, BRAND, (tx) => writer.staff(tx, base))).toMatchObject({
      author: { kind: 'staff', id: USER },
      outcome: 'linked',
    });
    expect(await owner.db.select().from(users).where(eq(users.id, USER))).toEqual(before);
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        writer.staff(tx, {
          ...base,
          record: { ...base.record, externalId: 'name-only-agent' },
          mapping: { kind: 'name' },
        }),
      ),
    ).toEqual({ author: { kind: 'name', name: 'Vendor name' }, outcome: 'name' });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.staff(tx, {
          ...base,
          record: { ...base.record, externalId: 'colliding-agent' },
          mapping: { kind: 'invited', departmentIds: [DEPARTMENT] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'identity-ambiguous' });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.staff(tx, {
          ...base,
          record: {
            ...base.record,
            externalId: 'foreign-agent',
            email: 'foreign-agent@example.com',
          },
          mapping: { kind: 'invited', departmentIds: [OTHER_DEPARTMENT] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    const deactivatedId = uuidv7();
    await owner.db.insert(users).values({
      id: deactivatedId,
      email: 'inactive-agent@example.com',
      name: 'Inactive',
      status: 'deactivated',
    });
    await owner.db.insert(userBrandRoles).values({
      userId: deactivatedId,
      brandId: BRAND,
      role: 'agent',
      departmentIds: [DEPARTMENT],
    });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.staff(tx, {
          ...base,
          record: { ...base.record, externalId: 'inactive-agent' },
          mapping: { kind: 'existing', userId: deactivatedId },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.externalId, 'colliding-agent')),
    ).toEqual([]);
    expect(
      await owner.db.select().from(users).where(eq(users.email, 'foreign-agent@example.com')),
    ).toEqual([]);
  });

  it('validates ticket fields against brand definitions, coerces values and rolls invalid mappings back', async () => {
    await owner.db.insert(customFieldDefs).values([
      {
        brandId: BRAND,
        target: 'ticket',
        key: 'historical_count',
        label: 'Historical count',
        type: 'number',
      },
      {
        brandId: BRAND,
        target: 'ticket',
        key: 'historical_date',
        label: 'Historical date',
        type: 'date',
      },
      {
        brandId: OTHER_BRAND,
        target: 'ticket',
        key: 'foreign_field',
        label: 'Other brand',
        type: 'text',
      },
    ]);
    const input = request('custom-values');
    input.resolved.custom = { historical_count: '12', historical_date: '2020-05-06T12:00:00Z' };
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const [ticket] = await owner.db.select().from(tickets).where(eq(tickets.id, loaded.ticketId));
    expect(ticket?.custom).toEqual({ historical_count: 12, historical_date: '2020-05-06' });
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'unchanged',
    });
    for (const custom of [{ historical_count: 'not-a-number' }, { foreign_field: 'private' }]) {
      const invalid = request(`invalid-custom-${Object.keys(custom)[0]}`);
      invalid.resolved.custom = custom;
      await expect(withSystem(app.db, BRAND, (tx) => writer.ticket(tx, invalid))).rejects.toThrow();
      expect(
        await owner.db
          .select()
          .from(importExternalIds)
          .where(eq(importExternalIds.externalId, invalid.record.externalId)),
      ).toEqual([]);
    }
  });

  it('refuses invalid contact/company field choices without creating profiles', async () => {
    const contact = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: { tier: 'unknown' },
      record: {
        externalId: 'invalid-profile-custom',
        name: 'Invalid fields',
        emails: ['invalid-fields@example.com'],
        phones: [],
        custom: {},
      },
    });
    await expect(withSystem(app.db, BRAND, (tx) => writer.contact(tx, contact))).rejects.toThrow();
    expect(
      await owner.db
        .select()
        .from(contactIdentities)
        .where(eq(contactIdentities.value, 'invalid-fields@example.com')),
    ).toEqual([]);
    const organization = organizationLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      custom: { undeclared: 'ignored?' },
      record: {
        externalId: 'invalid-company-custom',
        name: 'Invalid company',
        domains: ['invalid-fields.example'],
        custom: {},
      },
    });
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.organization(tx, organization)),
    ).rejects.toThrow();
    expect(
      await owner.db.select().from(accounts).where(eq(accounts.domain, 'invalid-fields.example')),
    ).toEqual([]);
  });

  it('enforces required fields on new profiles without discarding missing source data silently', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: OTHER_BRAND,
      source: 'zendesk',
      status: 'loading',
      startedBy: USER,
    });
    await owner.db.insert(customFieldDefs).values({
      brandId: OTHER_BRAND,
      target: 'account',
      key: 'contract_code',
      label: 'Contract',
      type: 'text',
      required: true,
    });
    const input = organizationLoadSchema.parse({
      brandId: OTHER_BRAND,
      runId,
      source: 'zendesk',
      custom: {},
      record: {
        externalId: 'required-company',
        name: 'Required company',
        domains: ['required-company.example'],
        custom: {},
      },
    });
    await expect(
      withSystem(app.db, OTHER_BRAND, (tx) => writer.organization(tx, input)),
    ).rejects.toThrow();
    expect(
      await owner.db.select().from(accounts).where(eq(accounts.domain, 'required-company.example')),
    ).toEqual([]);
    input.custom = { contract_code: '  Original contract  ' };
    const loaded = await withSystem(app.db, OTHER_BRAND, (tx) => writer.organization(tx, input));
    const [company] = await owner.db.select().from(accounts).where(eq(accounts.id, loaded.id));
    expect(company?.custom).toEqual({ contract_code: 'Original contract' });
  });

  it('creates confirmed field definitions, preserves local edits across repeats/deltas and loads their values', async () => {
    const input = fieldLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      record: {
        externalId: 'vendor-field',
        target: 'ticket',
        key: 'vendor-key',
        label: 'Vendor label',
        type: 'textarea',
      },
      mapping: {
        kind: 'create',
        definition: {
          target: 'ticket',
          key: 'imported_summary',
          label: 'Historical summary',
          type: 'text',
        },
      },
    });
    const created = await withSystem(app.db, BRAND, (tx) => writer.field(tx, input));
    expect(created.outcome).toBe('created');
    if (!created.id) throw new Error('Expected a created field');
    const [definition] = await owner.db
      .select()
      .from(customFieldDefs)
      .where(eq(customFieldDefs.id, created.id));
    expect(definition).toMatchObject({
      brandId: BRAND,
      target: 'ticket',
      key: 'imported_summary',
      type: 'text',
      label: 'Historical summary',
    });
    await owner.db
      .update(customFieldDefs)
      .set({ label: 'Local label', agentVisible: false })
      .where(eq(customFieldDefs.id, created.id));
    const before = await owner.db
      .select()
      .from(customFieldDefs)
      .where(eq(customFieldDefs.id, created.id));
    const nextRun = uuidv7();
    await owner.db.insert(importRuns).values({
      id: nextRun,
      brandId: BRAND,
      source: 'zendesk',
      status: 'loading',
      startedBy: USER,
    });
    expect(
      await withSystem(app.db, BRAND, (tx) => writer.field(tx, { ...input, runId: nextRun })),
    ).toMatchObject({ id: created.id, outcome: 'unchanged' });
    input.record.label = 'Changed vendor label';
    expect(await withSystem(app.db, BRAND, (tx) => writer.field(tx, input))).toMatchObject({
      id: created.id,
      outcome: 'linked',
    });
    expect(
      await owner.db.select().from(customFieldDefs).where(eq(customFieldDefs.id, created.id)),
    ).toEqual(before);
    expect(
      await owner.db.select().from(auditLog).where(eq(auditLog.targetId, created.id)),
    ).toHaveLength(1);
    const ticket = request('new-field-values');
    ticket.resolved.custom = { imported_summary: '  Original summary  ' };
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, ticket));
    const [stored] = await owner.db.select().from(tickets).where(eq(tickets.id, loaded.ticketId));
    expect(stored?.custom).toEqual({ imported_summary: 'Original summary' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(await redis.dbsize()).toBe(0);
  });

  it('requires explicit field reuse or skip and refuses duplicate keys, foreign fields and wrong targets', async () => {
    const [existing] = await owner.db
      .select()
      .from(customFieldDefs)
      .where(eq(customFieldDefs.key, 'tier'));
    if (!existing) throw new Error('Missing contact field fixture');
    const input = fieldLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      record: {
        externalId: 'existing-field',
        target: 'contact',
        key: 'vendor_tier',
        label: 'Tier',
        type: 'select',
        options: [{ value: 'gold', label: 'Gold' }],
      },
      mapping: { kind: 'existing', fieldId: existing.id },
    });
    expect(await withSystem(app.db, BRAND, (tx) => writer.field(tx, input))).toMatchObject({
      id: existing.id,
      outcome: 'linked',
    });
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        writer.field(tx, {
          ...input,
          record: { ...input.record, externalId: 'skipped-field' },
          mapping: { kind: 'skip' },
        }),
      ),
    ).toEqual({ id: null, outcome: 'skipped' });
    const [foreign] = await owner.db
      .select()
      .from(customFieldDefs)
      .where(eq(customFieldDefs.key, 'foreign_field'));
    if (!foreign) throw new Error('Missing foreign field fixture');
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.field(tx, {
          ...input,
          record: { ...input.record, externalId: 'foreign-field', target: 'ticket' },
          mapping: { kind: 'existing', fieldId: foreign.id },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.field(tx, {
          ...input,
          record: { ...input.record, externalId: 'wrong-target-field', target: 'ticket' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.field(tx, {
          ...input,
          record: { ...input.record, externalId: 'duplicate-field' },
          mapping: {
            kind: 'create',
            definition: {
              target: 'contact',
              key: 'tier',
              label: 'Other label',
              type: 'text',
              options: [],
              required: false,
              agentVisible: true,
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.externalId, 'duplicate-field')),
    ).toEqual([]);
  });

  it('fences competing workers per brand and refuses the previous worker after a stale takeover', async () => {
    const firstRun = uuidv7();
    const secondRun = uuidv7();
    const otherRun = uuidv7();
    await owner.db.insert(importRuns).values([
      { id: firstRun, brandId: BRAND, source: 'zendesk', status: 'extracting', startedBy: USER },
      { id: secondRun, brandId: BRAND, source: 'zendesk', status: 'extracting', startedBy: USER },
      {
        id: otherRun,
        brandId: OTHER_BRAND,
        source: 'zendesk',
        status: 'extracting',
        startedBy: USER,
      },
    ]);
    const claims = await Promise.all(
      [firstRun, secondRun].map((runId) =>
        withSystem(app.db, BRAND, (tx) =>
          claimImportRun(tx, { brandId: BRAND, runId, phase: 'extracting' }),
        ),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const original = claims.find((claim) => claim !== null);
    if (!original) throw new Error('Expected a claim');
    const replacementRun = original.runId === firstRun ? secondRun : firstRun;
    const independent = await withSystem(app.db, OTHER_BRAND, (tx) =>
      claimImportRun(tx, { brandId: OTHER_BRAND, runId: otherRun, phase: 'extracting' }),
    );
    expect(independent).not.toBeNull();
    await owner.db
      .update(importRuns)
      .set({ claimedAt: new Date(Date.now() - IMPORT_CLAIM_TIMEOUT_MS - 1000) })
      .where(eq(importRuns.id, original.runId));
    const replacement = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId: replacementRun, phase: 'extracting' }),
    );
    if (!replacement) throw new Error('Expected stale takeover');
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await renewImportClaim(tx, original);
        await tx.insert(importRecords).values({
          brandId: BRAND,
          runId: original.runId,
          entity: 'group',
          externalId: 'stale-write',
          payload: { externalId: 'stale-write', name: 'Uncommitted' },
          payloadHash: hashImportValue({ name: 'Uncommitted' }),
        });
      }),
    ).rejects.toMatchObject({ name: 'ImportClaimLost' });
    expect(
      await owner.db
        .select()
        .from(importRecords)
        .where(eq(importRecords.externalId, 'stale-write')),
    ).toEqual([]);
    await withSystem(app.db, BRAND, (tx) => renewImportClaim(tx, replacement));
    await withSystem(app.db, BRAND, (tx) =>
      cancelImportRun(tx, { brandId: BRAND, runId: replacementRun }),
    );
    await withSystem(app.db, OTHER_BRAND, (tx) =>
      cancelImportRun(tx, { brandId: OTHER_BRAND, runId: otherRun }),
    );
  });

  it.each(['extracting', 'dry_run', 'loading', 'finishing'] as const)(
    'pauses %s, revokes its worker, resumes with a fresh token and purges credentials on cancel',
    async (phase) => {
      const runId = uuidv7();
      const scope = { brandId: BRAND, runId };
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: BRAND,
        source: 'zendesk',
        status: phase,
        startedBy: USER,
        credentialsEncrypted: 'encrypted-fixture',
      });
      const original = await withSystem(app.db, BRAND, (tx) =>
        claimImportRun(tx, { ...scope, phase }),
      );
      if (!original) throw new Error('Expected loading claim');
      expect(await withSystem(app.db, BRAND, (tx) => pauseImportRun(tx, scope))).toBe(true);
      const [paused] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      expect(paused).toMatchObject({
        status: 'paused',
        pausedFrom: phase,
        claimToken: null,
        claimedAt: null,
        credentialsEncrypted: 'encrypted-fixture',
      });
      await expect(
        withSystem(app.db, BRAND, (tx) => renewImportClaim(tx, original)),
      ).rejects.toMatchObject({ name: 'ImportClaimLost' });
      expect(await withSystem(app.db, BRAND, (tx) => resumeImportRun(tx, scope))).toBe(phase);
      const resumed = await withSystem(app.db, BRAND, (tx) =>
        claimImportRun(tx, { ...scope, phase }),
      );
      expect(resumed?.token).not.toBe(original.token);
      expect(
        await withSystem(app.db, OTHER_BRAND, (tx) =>
          cancelImportRun(tx, { brandId: OTHER_BRAND, runId }),
        ),
      ).toBe(false);
      expect(await withSystem(app.db, BRAND, (tx) => cancelImportRun(tx, scope))).toBe(true);
      const [cancelled] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        pausedFrom: null,
        claimToken: null,
        claimedAt: null,
        credentialsEncrypted: null,
      });
      expect(cancelled?.finishedAt).toBeInstanceOf(Date);
      if (!resumed) throw new Error('Expected resumed claim');
      await expect(
        withSystem(app.db, BRAND, (tx) => renewImportClaim(tx, resumed)),
      ).rejects.toMatchObject({ name: 'ImportClaimLost' });
      expect(await withSystem(app.db, BRAND, (tx) => resumeImportRun(tx, scope))).toBeNull();
      expect(await withSystem(app.db, BRAND, (tx) => cancelImportRun(tx, scope))).toBe(false);
    },
  );

  it('commits extracted records, distinct counts and cursors atomically and resumes without duplicates', async () => {
    const runId = uuidv7();
    const scope = { brandId: BRAND, runId };
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
    });
    const original = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'extracting' }),
    );
    if (!original) throw new Error('Expected extraction claim');
    const page = {
      records: [{ entity: 'group', payload: { externalId: 'group-1', name: 'First' } }],
      cursor: { after: 'first-page' },
    };
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await storeImportPage(tx, original, 'group', page);
        throw new Error('Worker stopped before commit');
      }),
    ).rejects.toThrow('Worker stopped before commit');
    expect(
      await owner.db.select().from(importRecords).where(eq(importRecords.runId, runId)),
    ).toEqual([]);
    const [uncommitted] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(uncommitted?.cursors).toEqual({});
    await withSystem(app.db, BRAND, (tx) => storeImportPage(tx, original, 'group', page));
    await withSystem(app.db, BRAND, (tx) => pauseImportRun(tx, scope));
    await withSystem(app.db, BRAND, (tx) => resumeImportRun(tx, scope));
    const resumed = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'extracting' }),
    );
    if (!resumed) throw new Error('Expected resumed extraction');
    await withSystem(app.db, BRAND, (tx) =>
      storeImportPage(tx, resumed, 'group', {
        records: [
          { entity: 'group', payload: { externalId: 'group-1', name: 'Updated first' } },
          { entity: 'group', payload: { externalId: 'group-2', name: 'Second' } },
        ],
        cursor: null,
      }),
    );
    const records = await owner.db
      .select()
      .from(importRecords)
      .where(eq(importRecords.runId, runId));
    expect(records).toHaveLength(2);
    expect(records.find((row) => row.externalId === 'group-1')?.payload).toEqual({
      externalId: 'group-1',
      name: 'Updated first',
    });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run?.counts).toEqual({ extracted: { group: 2 } });
    expect(run?.cursors).toEqual({ group: { cursor: null, done: true } });
    await expect(
      withSystem(app.db, BRAND, (tx) => storeImportPage(tx, original, 'group', page)),
    ).rejects.toMatchObject({ name: 'ImportClaimLost' });
    await withSystem(app.db, BRAND, (tx) => cancelImportRun(tx, scope));
  });

  it('refuses malformed extraction pages and a cursor that makes no progress without losing the checkpoint', async () => {
    const runId = uuidv7();
    const scope = { brandId: BRAND, runId };
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'extracting' }),
    );
    if (!claim) throw new Error('Expected claim');
    const group = { entity: 'group', payload: { externalId: 'group', name: 'Group' } };
    await withSystem(app.db, BRAND, (tx) =>
      storeImportPage(tx, claim, 'group', { records: [group], cursor: { page: 2 } }),
    );
    const [before] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    for (const page of [
      { records: [group], cursor: { page: 2 } },
      { records: [group, group], cursor: { page: 3 } },
      { records: [group], cursor: { page: 3 }, deltaCursor: { after: 'premature' } },
      { records: [{ entity: 'group', payload: { externalId: 'bad' } }], cursor: { page: 3 } },
      {
        records: [{ entity: 'tag', payload: { externalId: 'tag', name: 'Tag' } }],
        cursor: { page: 3 },
      },
    ])
      await expect(
        withSystem(app.db, BRAND, (tx) => storeImportPage(tx, claim, 'group', page)),
      ).rejects.toThrow();
    const [after] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(after?.cursors).toEqual(before?.cursors);
    expect(after?.counts).toEqual(before?.counts);
    expect(
      await owner.db.select().from(importRecords).where(eq(importRecords.runId, runId)),
    ).toHaveLength(1);
    await withSystem(app.db, BRAND, (tx) => cancelImportRun(tx, scope));
  });

  it('stages original ticket and knowledge parent references for later ordered loading', async () => {
    const runId = uuidv7();
    const scope = { brandId: BRAND, runId };
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'extracting' }),
    );
    if (!claim) throw new Error('Expected claim');
    await withSystem(app.db, BRAND, (tx) =>
      storeImportPage(tx, claim, 'message', {
        records: [
          {
            entity: 'message',
            payload: {
              externalId: 'staged-message',
              ticketExternalId: 'staged-ticket',
              authorKind: 'system',
              public: false,
              bodyText: 'Original note',
              createdAt: '2020-01-01T00:00:00Z',
              attachments: [],
            },
          },
        ],
        cursor: null,
      }),
    );
    await withSystem(app.db, BRAND, (tx) =>
      storeImportPage(tx, claim, 'section', {
        records: [
          {
            entity: 'section',
            payload: {
              externalId: 'staged-section',
              parentExternalId: 'staged-category',
              names: { en: 'Original section' },
            },
          },
        ],
        cursor: null,
      }),
    );
    await withSystem(app.db, BRAND, (tx) =>
      storeImportPage(tx, claim, 'article', {
        records: [
          {
            entity: 'article',
            payload: {
              externalId: 'staged-article',
              sectionExternalId: 'staged-section',
              locale: 'en',
              title: 'Original title',
              bodyHtml: '<p>Original body</p>',
              draft: false,
              internal: false,
              createdAt: '2020-01-01T00:00:00Z',
              updatedAt: '2020-01-02T00:00:00Z',
            },
          },
        ],
        cursor: null,
      }),
    );
    const staged = await owner.db
      .select()
      .from(importRecords)
      .where(eq(importRecords.runId, runId));
    expect(staged.map((row) => [row.externalId, row.parentExternalId]).sort()).toEqual([
      ['staged-article', 'staged-section'],
      ['staged-message', 'staged-ticket'],
      ['staged-section', 'staged-category'],
    ]);
    await withSystem(app.db, BRAND, (tx) => cancelImportRun(tx, scope));
  });

  function failingExtraction(failure: Error): Connector<{ token: string }>['extract'] {
    return () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw failure;
        },
      }),
    });
  }

  function extractionHarness(runId: string, extract: Connector<{ token: string }>['extract']) {
    // This models the normalized SDK boundary, not any vendor's HTTP protocol.
    const controller = new AbortController();
    const context: ConnectorContext<{ token: string }> = {
      credentials: { token: 'secret-fixture' },
      signal: controller.signal,
      http: new ImportHttp({
        hosts: ['vendor.invalid'],
        policy: {},
        limiter: new ImportRateLimiter({ capacity: 1, perMinute: 60 }),
      }),
      log: async () => {
        throw new Error('The worker must scope and validate its own logging');
      },
    };
    const connector: Connector<{ token: string }> = {
      source: 'zendesk',
      entities: ['group'],
      credentialsSchema: z.strictObject({ token: z.string().min(1) }),
      extract,
      test: async () => ({ ok: true, account: 'fixture' }),
      defaultMappings: () => [],
      fetchAttachment: async () => {
        throw new Error('Extraction cannot download attachments');
      },
    };
    return {
      deps: {
        db: app.db,
        connector,
        context,
        scope: { brandId: BRAND, runId },
        jobId: `import.extract.${runId}`,
      },
      controller,
    };
  }

  it('stages Zendesk core exports through documented HTTP shapes with real PostgreSQL and Redis', async () => {
    const fake = new FakeZendesk(zendeskCoreFixture, {
      authorization: 'Bearer synthetic-token',
      now: Date.parse('2026-10-14T00:00:00Z') / 1000,
    });
    await fake.server.start();
    try {
      const runId = uuidv7();
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: BRAND,
        source: 'zendesk',
        status: 'extracting',
        startedBy: USER,
      });
      const connector = new ZendeskConnector({ apiRoot: fake.server.root });
      const context = {
        credentials: { auth: 'oauth' as const, subdomain: 'demo', accessToken: 'synthetic-token' },
        signal: new AbortController().signal,
        log: async () => {},
        http: new ImportHttp({
          hosts: ['127.0.0.1'],
          limiter: new ImportRateLimiter({ capacity: 100, perMinute: 1000 }),
          policy: {
            allowedPorts: [Number(new URL(fake.server.root).port)],
            allowCidrs: ['127.0.0.1/32'],
          },
        }),
      };
      expect(
        await runImportExtraction({
          db: app.db,
          connector,
          context,
          scope: { brandId: BRAND, runId },
          jobId: `zendesk.${runId}`,
        }),
      ).toEqual({ state: 'awaiting_mapping' });
      const rows = await owner.db
        .select()
        .from(importRecords)
        .where(eq(importRecords.runId, runId));
      expect(rows.filter((row) => row.entity === 'ticket')).toMatchObject([
        { payload: { externalId: '101', ccExternalIds: ['202'], status: 'pending:701' } },
      ]);
      expect(rows.filter((row) => row.entity === 'contact')).toHaveLength(3);
      expect(
        rows
          .filter((row) => row.entity === 'article')
          .sort((first, second) => first.externalId.localeCompare(second.externalId)),
      ).toMatchObject([
        {
          externalId: 'article:1603',
          payload: {
            locale: 'en',
            bodyHtml: '<p>Original English content</p>',
            draft: false,
            internal: false,
          },
        },
        {
          externalId: 'article:1603:ar',
          payload: {
            locale: 'ar',
            bodyHtml: '<p>المحتوى العربي الأصلي</p>',
            draft: true,
            internal: false,
          },
        },
      ]);
      expect(
        rows
          .filter((row) => row.entity === 'activity')
          .sort((first, second) => first.externalId.localeCompare(second.externalId)),
      ).toMatchObject([
        {
          externalId: '1201:1202',
          payload: { action: 'zendesk.Change', createdAt: '2020-01-02T10:00:00Z' },
        },
        { externalId: '1201:1203', payload: { action: 'zendesk.Notification' } },
      ]);
      expect(
        rows.find((row) => row.entity === 'contact' && row.externalId === '201')?.payload,
      ).toMatchObject({
        emails: ['customer@example.invalid', 'secondary@example.invalid'],
        sourceIdentities: [{ verificationMethod: 'full' }, {}, { type: 'twitter' }],
      });
      const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      expect(run?.counts).toEqual({
        extracted: {
          ticket: 1,
          user: 3,
          organization: 1,
          group: 1,
          contact: 3,
          message: 2,
          attachment: 1,
          field: 3,
          tag: 1,
          activity: 2,
          csat: 3,
          category: 1,
          section: 1,
          article: 2,
        },
      });
      expect(run?.cursors).toMatchObject({
        ticket: { done: true, deltaCursor: { after: expect.any(String) } },
        contact: { done: true },
      });
      expect(
        (await owner.db.select().from(importLog).where(eq(importLog.runId, runId))).sort(
          (first, second) => first.message.localeCompare(second.message),
        ),
      ).toMatchObject([
        { level: 'warning', entity: 'csat', message: 'import.csat.scale-normalized' },
        { level: 'warning', entity: 'csat', message: 'import.csat.timestamp-inferred' },
      ]);
      expect(await owner.db.select().from(outbox)).toEqual([]);
      expect(await redis.dbsize()).toBe(0);
    } finally {
      await fake.server.close();
    }
  });

  it('orchestrates extraction from a persisted cursor after pause and enters mapping only after the final page', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
      credentialsEncrypted: 'encrypted-fixture',
    });
    const harness = extractionHarness(runId, async function* (_context, _entity, cursor) {
      if (!cursor) {
        yield {
          records: [{ entity: 'group', payload: { externalId: 'orchestrated-1', name: 'First' } }],
          cursor: { after: 'first' },
        };
        await withSystem(app.db, BRAND, (tx) => pauseImportRun(tx, { brandId: BRAND, runId }));
      }
      yield {
        records: [{ entity: 'group', payload: { externalId: 'orchestrated-2', name: 'Second' } }],
        cursor: null,
      };
    });
    expect(await runImportExtraction(harness.deps)).toEqual({ state: 'stopped' });
    expect(
      await owner.db.select().from(importRecords).where(eq(importRecords.runId, runId)),
    ).toHaveLength(1);
    await withSystem(app.db, BRAND, (tx) => resumeImportRun(tx, { brandId: BRAND, runId }));
    expect(await runImportExtraction(harness.deps)).toEqual({ state: 'awaiting_mapping' });
    expect(
      await owner.db.select().from(importRecords).where(eq(importRecords.runId, runId)),
    ).toHaveLength(2);
    const [done] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(done).toMatchObject({
      status: 'awaiting_mapping',
      claimToken: null,
      claimedAt: null,
      credentialsEncrypted: 'encrypted-fixture',
    });
    expect(done?.startedAt).toBeInstanceOf(Date);
    expect(done?.counts).toEqual({ extracted: { group: 2 } });
  });

  it('persists rate-limit delay without spending an error attempt and skips finished entities on retry', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
      credentialsEncrypted: 'encrypted-fixture',
    });
    let limited = true;
    const harness = extractionHarness(runId, async function* () {
      if (limited) {
        limited = false;
        throw new RateLimited(60000);
      }
      yield {
        records: [{ entity: 'group', payload: { externalId: 'after-limit', name: 'Resumed' } }],
        cursor: null,
      };
    });
    expect(await runImportExtraction(harness.deps)).toEqual({
      state: 'deferred',
      retryAfterMs: 60000,
    });
    const [waiting] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(waiting?.counts).toMatchObject({ retryFailures: 0 });
    expect(waiting).toMatchObject({
      status: 'extracting',
      claimToken: null,
      credentialsEncrypted: 'encrypted-fixture',
    });
    expect(await runImportExtraction(harness.deps)).toMatchObject({ state: 'deferred' });
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        claimImportRun(tx, { brandId: BRAND, runId, phase: 'extracting' }),
      ),
    ).toBeNull();
    await owner.db
      .update(importRuns)
      .set({ counts: { retryFailures: 0, retryAt: '2000-01-01T00:00:00.000Z' } })
      .where(eq(importRuns.id, runId));
    expect(await runImportExtraction(harness.deps)).toEqual({ state: 'awaiting_mapping' });
    const [resumed] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(resumed?.counts).toEqual({ extracted: { group: 1 } });
    expect(await owner.db.select().from(importLog).where(eq(importLog.runId, runId))).toMatchObject(
      [{ message: 'import.rate-limited', level: 'warning' }],
    );
  });

  it.each([null, { after: 'committed-source-watermark' }])(
    'uses a completed parent watermark %j with date overlap and refuses another brand parent',
    async (watermark) => {
      const parentId = uuidv7();
      const runId = uuidv7();
      await owner.db.insert(importRuns).values({
        id: parentId,
        brandId: BRAND,
        source: 'zendesk',
        status: 'completed',
        startedBy: USER,
        startedAt: new Date('2020-01-02T00:00:00Z'),
        cursors: watermark ? { group: { cursor: null, done: true, deltaCursor: watermark } } : {},
      });
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: BRAND,
        source: 'zendesk',
        mode: 'delta',
        parentRunId: parentId,
        status: 'extracting',
        startedBy: USER,
        credentialsEncrypted: 'encrypted-fixture',
      });
      let observedSince: Date | undefined;
      let observedCursor: unknown;
      const harness = extractionHarness(runId, async function* (_context, _entity, cursor, since) {
        observedSince = since;
        observedCursor = cursor;
        yield { records: [], cursor: null, deltaCursor: { after: 'next-watermark' } };
      });
      expect(await runImportExtraction(harness.deps)).toEqual({ state: 'awaiting_mapping' });
      expect(observedSince?.toISOString()).toBe('2020-01-01T23:00:00.000Z');
      expect(observedCursor).toEqual(watermark);
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.cursors,
      ).toEqual({ group: { cursor: null, done: true, deltaCursor: { after: 'next-watermark' } } });
      expect(
        await runImportExtraction({ ...harness.deps, scope: { brandId: OTHER_BRAND, runId } }),
      ).toEqual({ state: 'stopped' });
    },
  );

  it('extracts every normalized entity including activity without a stale thirteen-entity cap', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
    });
    const harness = extractionHarness(runId, async function* () {
      yield { records: [], cursor: null };
    });
    const connector = { ...harness.deps.connector, entities: [...importEntitySchema.options] };
    expect(await runImportExtraction({ ...harness.deps, connector })).toEqual({
      state: 'awaiting_mapping',
    });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(Object.keys(run?.cursors ?? {}).sort()).toEqual([...importEntitySchema.options].sort());
  });

  it.each([
    ['credentials-refused', new ConnectorError('credentials-refused')],
    ['invalid-response', new ConnectorError('invalid-response')],
    ['invalid-response', new RateLimited(Number.MAX_SAFE_INTEGER)],
    ['execution-failed', new Error('secret-fixture must never be logged')],
  ])(
    'ends extraction with %s and purges credentials using a safe error code',
    async (code, failure) => {
      const runId = uuidv7();
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: BRAND,
        source: 'zendesk',
        status: 'extracting',
        startedBy: USER,
        credentialsEncrypted: 'encrypted-fixture',
      });
      const harness = extractionHarness(runId, failingExtraction(failure));
      expect(await runImportExtraction(harness.deps)).toEqual({ state: 'failed' });
      const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      expect(run).toMatchObject({
        status: 'failed',
        credentialsEncrypted: null,
        claimToken: null,
        error: code,
      });
      const logs = await owner.db.select().from(importLog).where(eq(importLog.runId, runId));
      expect(JSON.stringify(logs)).not.toContain('secret-fixture');
      expect(logs).toMatchObject([{ message: `import.${code}`, level: 'error' }]);
    },
  );

  it('purges credentials after three consecutive vendor outages but retains progress for retry before that', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
      credentialsEncrypted: 'encrypted-fixture',
    });
    const harness = extractionHarness(
      runId,
      failingExtraction(new ConnectorError('vendor-unavailable', 503)),
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await runImportExtraction(harness.deps)).toEqual(
        attempt < 3 ? { state: 'deferred', retryAfterMs: 5000 } : { state: 'failed' },
      );
      const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      expect(run?.counts.retryFailures).toBe(attempt);
      if (attempt < 3)
        await owner.db
          .update(importRuns)
          .set({ counts: { ...run?.counts, retryAt: '2000-01-01T00:00:00.000Z' } })
          .where(eq(importRuns.id, runId));
    }
    const [failed] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(failed).toMatchObject({ status: 'failed', credentialsEncrypted: null });
  });

  it('releases a shutdown claim for retry without treating interruption as failed migration', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
      credentialsEncrypted: 'encrypted-fixture',
    });
    const harness = extractionHarness(runId, async function* () {
      yield { records: [], cursor: null };
    });
    harness.controller.abort();
    expect(await runImportExtraction(harness.deps)).toEqual({
      state: 'deferred',
      retryAfterMs: 1000,
    });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run).toMatchObject({
      status: 'extracting',
      claimToken: null,
      credentialsEncrypted: 'encrypted-fixture',
    });
  });

  it('rejects unapproved connector log text without exposing credentials', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
      credentialsEncrypted: 'encrypted-fixture',
    });
    const harness = extractionHarness(runId, async function* (context) {
      await context.log({ level: 'warning', message: 'import.secret-fixture' });
      yield { records: [], cursor: null };
    });
    expect(await runImportExtraction(harness.deps)).toEqual({ state: 'failed' });
    expect(
      JSON.stringify(await owner.db.select().from(importLog).where(eq(importLog.runId, runId))),
    ).not.toContain('secret-fixture');
  });

  it('fails an extraction stream that ends without its final checkpoint', async () => {
    const incompleteRun = uuidv7();
    await owner.db.insert(importRuns).values({
      id: incompleteRun,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
      credentialsEncrypted: 'encrypted-fixture',
    });
    const incomplete = extractionHarness(incompleteRun, async function* () {
      yield { records: [], cursor: { page: 2 } };
    });
    expect(await runImportExtraction(incomplete.deps)).toEqual({ state: 'failed' });
    const [failed] = await owner.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, incompleteRun));
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'invalid-response',
      credentialsEncrypted: null,
    });
  });

  it('logs only approved warning codes and stops requesting pages at the final cursor', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
      credentialsEncrypted: 'encrypted-fixture',
    });
    let requestedPastEnd = false;
    const harness = extractionHarness(runId, async function* (context) {
      await context.log({
        level: 'warning',
        message: 'import.record-unavailable',
        entity: 'group',
        externalId: 'deleted-group',
      });
      yield { records: [], cursor: null };
      requestedPastEnd = true;
      throw new Error('A vendor should not be queried beyond the final cursor');
    });
    expect(await runImportExtraction(harness.deps)).toEqual({ state: 'awaiting_mapping' });
    expect(requestedPastEnd).toBe(false);
    const logs = await owner.db.select().from(importLog).where(eq(importLog.runId, runId));
    expect(logs).toMatchObject([
      {
        level: 'warning',
        message: 'import.record-unavailable',
        entity: 'group',
        externalId: 'deleted-group',
      },
    ]);
  });

  it('imports bilingual knowledge with source dates, stable slugs, draft/private copies and no publish side effects', async () => {
    const scope = { brandId: BRAND, runId: RUN, source: 'zendesk' as const };
    const categoryInput = categoryLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'kb-category',
        names: { en: 'Knowledge', ar: 'المعرفة' },
        descriptions: { en: 'C'.repeat(600) },
      },
    });
    const category = await withSystem(app.db, BRAND, (tx) => writer.category(tx, categoryInput));
    const sectionInput = sectionLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'kb-section',
        parentExternalId: 'kb-category',
        names: { en: 'Answers', ar: 'الإجابات' },
        descriptions: { ar: 'وصف القسم' },
      },
    });
    const section = await withSystem(app.db, BRAND, (tx) => writer.section(tx, sectionInput));
    const input = articleLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'kb-article-en',
        sectionExternalId: 'kb-section',
        locale: 'en',
        title: 'Original title '.repeat(20),
        description: 'D'.repeat(250),
        bodyHtml: '<p>Answer</p><script>unsafe()</script>',
        draft: false,
        internal: false,
        createdAt: '2019-01-01T00:00:00Z',
        updatedAt: '2020-01-01T00:00:00Z',
      },
      preparedBodyHtml: '<p>Answer</p><script>unsafe()</script>',
    });
    const english = await withSystem(app.db, BRAND, (tx) => writer.article(tx, input));
    const arabic = articleLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'kb-article-ar',
        translationOf: 'kb-article-en',
        sectionExternalId: 'kb-section',
        locale: 'ar',
        title: 'إجابة قديمة',
        bodyHtml: '<p dir="rtl">إجابة</p>',
        draft: true,
        internal: true,
        createdAt: '2018-01-01T00:00:00Z',
        updatedAt: '2021-01-01T00:00:00Z',
      },
      preparedBodyHtml: '<p dir="rtl">إجابة</p>',
    });
    expect(await withSystem(app.db, BRAND, (tx) => writer.article(tx, arabic))).toMatchObject({
      id: english.id,
    });
    const versions = await owner.db
      .select()
      .from(hcArticleVersions)
      .where(eq(hcArticleVersions.articleId, english.id));
    expect(versions).toHaveLength(2);
    expect(versions.find((row) => row.locale === 'en')).toMatchObject({
      title: input.record.title.trim(),
      bodyHtml: '<p>Answer</p>',
      publishedBodyHtml: '<p>Answer</p>',
      publishedBodyText: 'Answer',
      status: 'published',
      visibility: 'public',
      description: 'D'.repeat(160),
      importedDescription: 'D'.repeat(250),
    });
    expect(versions.find((row) => row.locale === 'en')?.publishedAt?.toISOString()).toBe(
      '2020-01-01T00:00:00.000Z',
    );
    expect(versions.find((row) => row.locale === 'ar')).toMatchObject({
      status: 'draft',
      visibility: 'internal',
      publishedBodyHtml: null,
      publishedAt: null,
      bodyHtml: '<p dir="rtl">إجابة</p>',
    });
    const [article] = await owner.db.select().from(hcArticles).where(eq(hcArticles.id, english.id));
    expect(article?.createdAt.toISOString()).toBe('2018-01-01T00:00:00.000Z');
    expect(article?.updatedAt.toISOString()).toBe('2021-01-01T00:00:00.000Z');
    const beforeCategory = await owner.db
      .select()
      .from(hcCategories)
      .where(eq(hcCategories.id, category.id));
    const beforeSection = await owner.db
      .select()
      .from(hcSections)
      .where(eq(hcSections.id, section.id));
    expect(beforeCategory[0]).toMatchObject({
      descriptions: { en: 'C'.repeat(300), ar: '' },
      importedDescriptions: { en: 'C'.repeat(600), ar: '' },
    });
    expect(beforeSection[0]?.importedDescriptions).toEqual({ en: '', ar: 'وصف القسم' });
    expect(
      await withSystem(app.db, BRAND, (tx) => writer.category(tx, categoryInput)),
    ).toMatchObject({ outcome: 'unchanged' });
    expect(await withSystem(app.db, BRAND, (tx) => writer.section(tx, sectionInput))).toMatchObject(
      { outcome: 'unchanged' },
    );
    expect(await withSystem(app.db, BRAND, (tx) => writer.article(tx, input))).toMatchObject({
      outcome: 'unchanged',
    });
    expect(
      await owner.db
        .select()
        .from(hcArticleVersions)
        .where(eq(hcArticleVersions.articleId, english.id)),
    ).toEqual(versions);
    expect(
      await owner.db.select().from(hcCategories).where(eq(hcCategories.id, category.id)),
    ).toEqual(beforeCategory);
    expect(await owner.db.select().from(hcSections).where(eq(hcSections.id, section.id))).toEqual(
      beforeSection,
    );
    input.record.title = 'Updated source title';
    input.record.updatedAt = '2022-01-01T00:00:00Z';
    input.record.internal = true;
    expect(await withSystem(app.db, BRAND, (tx) => writer.article(tx, input))).toMatchObject({
      outcome: 'updated',
    });
    const [changed] = await owner.db.select().from(hcArticles).where(eq(hcArticles.id, english.id));
    expect(changed?.slug).toBe(article?.slug);
    const changedVersions = await owner.db
      .select()
      .from(hcArticleVersions)
      .where(eq(hcArticleVersions.articleId, english.id));
    expect(changedVersions.find((row) => row.locale === 'ar')).toEqual(
      versions.find((row) => row.locale === 'ar'),
    );
    expect(changedVersions.find((row) => row.locale === 'en')).toMatchObject({
      visibility: 'internal',
      publishedTitle: 'Updated source title',
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(await redis.dbsize()).toBe(0);
  });

  it('retains nested category breadcrumbs and rejects cycles without rewriting local names on a repeated source', async () => {
    const scope = { brandId: BRAND, runId: RUN, source: 'zendesk' as const };
    const rootInput = categoryLoadSchema.parse({
      ...scope,
      record: { externalId: 'kb-parent', names: { en: 'Parent', ar: 'الرئيسي' } },
    });
    const root = await withSystem(app.db, BRAND, (tx) => writer.category(tx, rootInput));
    const nested = categoryLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'kb-child',
        parentExternalId: 'kb-parent',
        names: { en: 'Child', ar: 'الفرعي' },
      },
    });
    const child = await withSystem(app.db, BRAND, (tx) => writer.category(tx, nested));
    const [row] = await owner.db.select().from(hcCategories).where(eq(hcCategories.id, child.id));
    expect(row).toMatchObject({
      names: { en: 'Parent / Child', ar: 'الرئيسي / الفرعي' },
      importedParentExternalId: 'kb-parent',
    });
    await owner.db
      .update(hcCategories)
      .set({ names: { en: 'Manual parent', ar: '' } })
      .where(eq(hcCategories.id, root.id));
    expect(await withSystem(app.db, BRAND, (tx) => writer.category(tx, nested))).toMatchObject({
      outcome: 'unchanged',
    });
    expect(await owner.db.select().from(hcCategories).where(eq(hcCategories.id, child.id))).toEqual(
      [row],
    );
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.category(tx, {
          ...rootInput,
          record: { ...rootInput.record, parentExternalId: 'kb-child' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.category(tx, {
          ...rootInput,
          record: { ...rootInput.record, parentExternalId: 'kb-parent' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      await owner.db.select().from(importLog).where(eq(importLog.externalId, 'kb-child')),
    ).toMatchObject([{ message: 'import.category.flattened' }]);
  });

  it('retains nested section ancestry and bilingual breadcrumbs while refusing section cycles', async () => {
    const scope = { brandId: BRAND, runId: RUN, source: 'zendesk' as const };
    await withSystem(app.db, BRAND, (tx) =>
      writer.category(
        tx,
        categoryLoadSchema.parse({
          ...scope,
          record: { externalId: 'nested-category', names: { en: 'Docs', ar: 'التوثيق' } },
        }),
      ),
    );
    const parentInput = sectionLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'parent-section',
        parentExternalId: 'nested-category',
        names: { en: 'Parent', ar: 'الرئيسي' },
      },
    });
    const parent = await withSystem(app.db, BRAND, (tx) => writer.section(tx, parentInput));
    const childInput = sectionLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'child-section',
        parentExternalId: 'nested-category',
        parentSectionExternalId: 'parent-section',
        names: { en: 'Child', ar: 'الفرعي' },
      },
    });
    const child = await withSystem(app.db, BRAND, (tx) => writer.section(tx, childInput));
    const [stored] = await owner.db.select().from(hcSections).where(eq(hcSections.id, child.id));
    expect(stored).toMatchObject({
      names: { en: 'Parent / Child', ar: 'الرئيسي / الفرعي' },
      importedParentSectionExternalId: 'parent-section',
    });
    expect(await withSystem(app.db, BRAND, (tx) => writer.section(tx, childInput))).toMatchObject({
      id: child.id,
      outcome: 'unchanged',
    });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.section(tx, {
          ...parentInput,
          record: { ...parentInput.record, parentSectionExternalId: 'child-section' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      (await owner.db.select().from(hcSections).where(eq(hcSections.id, parent.id)))[0]?.names,
    ).toEqual({ en: 'Parent', ar: 'الرئيسي' });
    await withSystem(app.db, BRAND, (tx) =>
      writer.section(tx, {
        ...parentInput,
        record: { ...parentInput.record, names: { en: 'Renamed', ar: 'الجديد' } },
      }),
    );
    expect(await withSystem(app.db, BRAND, (tx) => writer.section(tx, childInput))).toMatchObject({
      id: child.id,
      outcome: 'updated',
    });
    expect(
      (await owner.db.select().from(hcSections).where(eq(hcSections.id, child.id)))[0]?.names,
    ).toEqual({ en: 'Renamed / Child', ar: 'الجديد / الفرعي' });
    await withSystem(app.db, BRAND, (tx) =>
      writer.category(
        tx,
        categoryLoadSchema.parse({
          ...scope,
          record: { externalId: 'other-category', names: { en: 'Other' } },
        }),
      ),
    );
    await withSystem(app.db, BRAND, (tx) =>
      writer.section(
        tx,
        sectionLoadSchema.parse({
          ...scope,
          record: {
            externalId: 'other-section',
            parentExternalId: 'other-category',
            names: { en: 'Other section' },
          },
        }),
      ),
    );
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.section(tx, {
          ...childInput,
          record: { ...childInput.record, parentSectionExternalId: 'other-section' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('commits staged knowledge, load receipts and counts together and validates the target on resume', async () => {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
    const input = categoryLoadSchema.parse({
      brandId: BRAND,
      runId,
      source: 'zendesk',
      record: {
        externalId: 'checkpoint-category',
        names: { en: 'Checkpoint', ar: 'نقطة الاستئناف' },
      },
    });
    const recordId = uuidv7();
    await owner.db.insert(importRecords).values({
      id: recordId,
      brandId: BRAND,
      runId,
      entity: 'category',
      externalId: input.record.externalId,
      payload: input.record,
      payloadHash: hashImportValue(input.record),
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing loading claim');
    const operation = { entity: 'category' as const, input };
    const categoriesBefore = await owner.db.select().from(hcCategories).orderBy(hcCategories.id);
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await loadStagedRecord(tx, { claim, recordId, operation });
        throw new Error('Simulated transaction loss');
      }),
    ).rejects.toThrow('Simulated transaction loss');
    expect(await owner.db.select().from(hcCategories).orderBy(hcCategories.id)).toEqual(
      categoriesBefore,
    );
    expect(
      (await owner.db.select().from(importRecords).where(eq(importRecords.id, recordId)))[0],
    ).toMatchObject({ status: 'staged', helpdockId: null, loadHash: null });
    const loaded = await withSystem(app.db, BRAND, (tx) =>
      loadStagedRecord(tx, { claim, recordId, operation }),
    );
    expect(loaded).toMatchObject({ state: 'loaded', outcome: 'created' });
    expect(
      await withSystem(app.db, BRAND, (tx) => loadStagedRecord(tx, { claim, recordId, operation })),
    ).toEqual({ state: 'already_done', id: loaded.id });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts,
    ).toEqual({ loaded: { category: 1 } });
    if (!loaded.id) throw new Error('Missing loaded category');
    await owner.db.delete(hcCategories).where(eq(hcCategories.id, loaded.id));
    await expect(
      withSystem(app.db, BRAND, (tx) => loadStagedRecord(tx, { claim, recordId, operation })),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('checkpoints an explicit field skip once and refuses changed mapping receipts on resume', async () => {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
    const input = fieldLoadSchema.parse({
      brandId: BRAND,
      runId,
      source: 'zendesk',
      record: {
        externalId: 'skipped-field',
        target: 'ticket',
        key: 'old',
        label: 'Old',
        type: 'text',
      },
      mapping: { kind: 'skip' },
    });
    const recordId = uuidv7();
    await owner.db.insert(importRecords).values({
      id: recordId,
      brandId: BRAND,
      runId,
      entity: 'field',
      externalId: input.record.externalId,
      payload: input.record,
      payloadHash: hashImportValue(input.record),
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing loading claim');
    const operation = { entity: 'field' as const, input };
    expect(
      await withSystem(app.db, BRAND, (tx) => loadStagedRecord(tx, { claim, recordId, operation })),
    ).toMatchObject({ state: 'skipped', id: null });
    expect(
      await withSystem(app.db, BRAND, (tx) => loadStagedRecord(tx, { claim, recordId, operation })),
    ).toEqual({ state: 'already_done', id: null });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        loadStagedRecord(tx, {
          claim,
          recordId,
          operation: {
            entity: 'field',
            input: { ...input, mapping: { kind: 'existing', fieldId: uuidv7() } },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts,
    ).toEqual({ skipped: { field: 1 } });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('resumes a staged contact through a manual merge while keeping its stable source pointer', async () => {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId,
      source: 'zendesk',
      record: {
        externalId: 'checkpoint-contact',
        name: 'Imported customer',
        emails: ['checkpoint@example.invalid'],
        phones: [],
        custom: {},
      },
      accountId: null,
      custom: {},
    });
    const recordId = uuidv7();
    await owner.db.insert(importRecords).values({
      id: recordId,
      brandId: BRAND,
      runId,
      entity: 'contact',
      externalId: input.record.externalId,
      payload: input.record,
      payloadHash: hashImportValue(input.record),
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing loading claim');
    const operation = { entity: 'contact' as const, input };
    const loaded = await withSystem(app.db, BRAND, (tx) =>
      loadStagedRecord(tx, { claim, recordId, operation }),
    );
    const originalId = loaded.id;
    if (!originalId) throw new Error('Missing imported contact');
    const survivor = uuidv7();
    await owner.db.insert(contacts).values({ id: survivor, brandId: BRAND, name: 'Survivor' });
    await withSystem(app.db, BRAND, async (tx) => {
      const merges = new ContactMergesRepository();
      await merges.moveIdentities(tx, { from: originalId, to: survivor });
      await merges.markMerged(tx, originalId, survivor);
    });
    expect(
      await withSystem(app.db, BRAND, (tx) => loadStagedRecord(tx, { claim, recordId, operation })),
    ).toEqual({ state: 'already_done', id: survivor });
    expect(
      (await owner.db.select().from(importRecords).where(eq(importRecords.id, recordId)))[0]
        ?.helpdockId,
    ).toBe(loaded.id);
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts,
    ).toEqual({ loaded: { contact: 1 } });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('resolves staged field mappings before loading a contact and refuses a different resolved value', async () => {
    const runId = uuidv7();
    const scope = { brandId: BRAND, runId, source: 'zendesk' as const };
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
    const [destination] = await owner.db
      .select()
      .from(customFieldDefs)
      .where(
        and(
          eq(customFieldDefs.brandId, BRAND),
          eq(customFieldDefs.target, 'contact'),
          eq(customFieldDefs.key, 'tier'),
        ),
      );
    if (!destination) throw new Error('Missing destination field');
    const fieldInput = fieldLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'contact:compiler-field',
        target: 'contact',
        key: 'native_tier',
        label: 'Historical tier',
        type: 'select',
        options: [{ value: 'gold', label: 'Gold' }],
      },
      mapping: { kind: 'existing', fieldId: destination.id },
    });
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId,
      entity: 'field',
      externalId: fieldInput.record.externalId,
      payload: fieldInput.record,
      payloadHash: hashImportValue(fieldInput.record),
    });
    await owner.db.insert(importMappings).values({
      brandId: BRAND,
      runId,
      kind: 'field',
      externalValue: fieldInput.record.externalId,
      target: fieldInput.mapping,
    });
    await withSystem(app.db, BRAND, (tx) => writer.field(tx, fieldInput));
    const input = contactLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'compiled-contact',
        name: 'Mapped customer',
        emails: ['compiled@example.invalid'],
        phones: [],
        custom: { native_tier: 'gold' },
      },
      custom: { tier: 'gold' },
      accountId: null,
    });
    const recordId = uuidv7();
    await owner.db.insert(importRecords).values({
      id: recordId,
      brandId: BRAND,
      runId,
      entity: 'contact',
      externalId: input.record.externalId,
      payload: input.record,
      payloadHash: hashImportValue(input.record),
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing loading claim');
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        loadStagedRecord(tx, {
          claim,
          recordId,
          operation: { entity: 'contact', input: { ...input, custom: { tier: 'silver' } } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    await owner.db
      .update(importMappings)
      .set({
        target: {
          kind: 'create',
          definition: {
            target: 'ticket',
            key: 'wrong_target',
            label: 'Wrong target',
            type: 'text',
          },
        },
      })
      .where(
        and(
          eq(importMappings.runId, runId),
          eq(importMappings.externalValue, fieldInput.record.externalId),
        ),
      );
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        loadStagedRecord(tx, { claim, recordId, operation: { entity: 'contact', input } }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    await owner.db
      .update(importMappings)
      .set({ target: fieldInput.mapping })
      .where(
        and(
          eq(importMappings.runId, runId),
          eq(importMappings.externalValue, fieldInput.record.externalId),
        ),
      );
    const loaded = await withSystem(app.db, BRAND, (tx) =>
      loadStagedRecord(tx, { claim, recordId, operation: { entity: 'contact', input } }),
    );
    if (!loaded.id) throw new Error('Missing compiled contact');
    expect(
      (await owner.db.select().from(contacts).where(eq(contacts.id, loaded.id)))[0],
    ).toMatchObject({ custom: { tier: 'gold' } });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('loads a staged ticket from confirmed mappings and rejects a foreign-brand status before writing', async () => {
    const scenario = await stagedTicketScenario('mapped-routing');
    const cc = uuidv7();
    await owner.db.insert(contacts).values({ id: cc, brandId: BRAND, name: 'Mapped CC' });
    await owner.db.insert(importExternalIds).values([
      {
        brandId: BRAND,
        source: 'zendesk',
        entity: 'contact',
        externalId: 'mapped-requester',
        helpdockId: CONTACT,
        payloadHash: 'a'.repeat(64),
      },
      {
        brandId: BRAND,
        source: 'zendesk',
        entity: 'contact',
        externalId: 'mapped-cc',
        helpdockId: cc,
        payloadHash: 'b'.repeat(64),
      },
    ]);
    scenario.input.record.requesterExternalId = 'mapped-requester';
    scenario.input.record.ccExternalIds = ['mapped-cc'];
    await owner.db
      .update(importRecords)
      .set({ payload: scenario.input.record, payloadHash: hashImportValue(scenario.input.record) })
      .where(eq(importRecords.id, scenario.recordId));
    const foreignStatus = uuidv7();
    await owner.db.insert(ticketStatuses).values({
      id: foreignStatus,
      brandId: OTHER_BRAND,
      name: 'Foreign mapped status',
      systemState: 'open',
      color: 'info',
    });
    await owner.db.insert(importMappings).values([
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        kind: 'status',
        externalValue: 'open',
        target: { statusId: foreignStatus },
      },
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        kind: 'group',
        externalValue: '',
        target: { departmentId: DEPARTMENT, teamId: null },
      },
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        kind: 'priority',
        externalValue: '',
        target: { priority: 'medium' },
      },
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        kind: 'channel',
        externalValue: '',
        target: { channel: 'api' },
      },
    ]);
    const { resolved: _resolved, ...input } = scenario.input;
    const checkpoint = { claim: scenario.claim, recordId: scenario.recordId, input };
    await expect(
      withSystem(app.db, BRAND, (tx) => loadMappedStagedTicket(tx, checkpoint)),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      (
        await owner.db.select().from(importRecords).where(eq(importRecords.id, scenario.recordId))
      )[0]?.status,
    ).toBe('staged');
    await owner.db
      .update(importMappings)
      .set({ target: { statusId: STATUS } })
      .where(and(eq(importMappings.runId, input.runId), eq(importMappings.kind, 'status')));
    const loaded = await withSystem(app.db, BRAND, (tx) => loadMappedStagedTicket(tx, checkpoint));
    expect(
      (await owner.db.select().from(tickets).where(eq(tickets.id, loaded.ticketId)))[0],
    ).toMatchObject({
      statusId: STATUS,
      departmentId: DEPARTMENT,
      priority: 'medium',
      channel: 'api',
      assigneeId: null,
      contactId: CONTACT,
    });
    expect(await withSystem(app.db, BRAND, (tx) => loadMappedStagedTicket(tx, checkpoint))).toEqual(
      { state: 'already_loaded', ticketId: loaded.ticketId },
    );
    expect(
      await owner.db
        .select()
        .from(ticketParticipants)
        .where(eq(ticketParticipants.ticketId, loaded.ticketId)),
    ).toMatchObject([{ contactId: cc, source: 'import', address: null }]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  async function mappedHistoryScenario(externalId: string) {
    const scenario = await stagedTicketScenario(externalId);
    const user = { externalId: 'oldagent', kind: 'agent', name: 'Original agent', active: false };
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: scenario.input.runId,
      entity: 'user',
      externalId: 'oldagent',
      payload: user,
      payloadHash: hashImportValue(user),
    });
    await owner.db
      .insert(importExternalIds)
      .values({
        brandId: BRAND,
        source: 'zendesk',
        entity: 'contact',
        externalId: 'customer',
        helpdockId: CONTACT,
        payloadHash: 'a'.repeat(64),
      })
      .onConflictDoNothing();
    await owner.db.insert(importMappings).values([
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        kind: 'status',
        externalValue: 'open',
        target: { statusId: STATUS },
      },
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        kind: 'group',
        externalValue: '',
        target: { departmentId: DEPARTMENT, teamId: null },
      },
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        kind: 'priority',
        externalValue: '',
        target: { priority: 'medium' },
      },
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        kind: 'channel',
        externalValue: '',
        target: { channel: 'api' },
      },
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        kind: 'agent',
        externalValue: 'oldagent',
        target: { kind: 'name' },
      },
    ]);
    return scenario;
  }

  it('assembles staged history and confirmed authors without caller-supplied thread data', async () => {
    const scenario = await mappedHistoryScenario('assembled-history');
    const checkpoint = { claim: scenario.claim, recordId: scenario.recordId };
    const loaded = await withSystem(app.db, BRAND, (tx) =>
      loadAssembledStagedTicket(tx, checkpoint),
    );
    expect(loaded).toMatchObject({ state: 'loaded', messages: 2 });
    const thread = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, loaded.ticketId))
      .orderBy(ticketMessages.seq);
    expect(thread).toMatchObject([
      { kind: 'public', authorType: 'contact', authorId: CONTACT },
      { kind: 'note', authorType: 'system', authorDisplay: 'Original agent' },
    ]);
    expect(
      await withSystem(app.db, BRAND, (tx) => loadAssembledStagedTicket(tx, checkpoint)),
    ).toEqual({ state: 'already_loaded', ticketId: loaded.ticketId });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('drives separate staff and ticket batches from staged history without finishing pending media', async () => {
    const scenario = await mappedHistoryScenario('batched-history');
    const deps = { db: app.db, jobId: 'import.load.batch.fixture' };
    const command = { claim: scenario.claim, batchSize: 1 };
    expect(await runImportLoadBatch(deps, command)).toEqual({ state: 'more', processed: 1 });
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(
          and(
            eq(importExternalIds.entity, 'ticket'),
            eq(importExternalIds.externalId, scenario.input.record.externalId),
          ),
        ),
    ).toEqual([]);
    expect(await runImportLoadBatch(deps, command)).toEqual({ state: 'more', processed: 1 });
    expect(await runImportLoadBatch(deps, command)).toEqual({
      state: 'records_loaded',
      processed: 0,
    });
    const [run] = await owner.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, scenario.input.runId));
    expect(run).toMatchObject({
      status: 'loading',
      counts: { loaded: { user: 1, ticket: 1, message: 2, attachment: 1, csat: 1 } },
    });
    const [pointer] = await owner.db
      .select()
      .from(importExternalIds)
      .where(
        and(
          eq(importExternalIds.brandId, BRAND),
          eq(importExternalIds.entity, 'ticket'),
          eq(importExternalIds.externalId, scenario.input.record.externalId),
        ),
      );
    if (!pointer) throw new Error('Missing batched ticket');
    expect(
      await owner.db.select().from(attachments).where(eq(attachments.ticketId, pointer.helpdockId)),
    ).toMatchObject([{ status: 'pending' }]);
    const revisions = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${pointer.helpdockId}`,
    );
    expect(await runImportLoadBatch(deps, command)).toEqual({
      state: 'records_loaded',
      processed: 0,
    });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${pointer.helpdockId}`,
      ),
    ).toEqual(revisions);
    await withSystem(app.db, BRAND, (tx) =>
      pauseImportRun(tx, { brandId: BRAND, runId: scenario.input.runId }),
    );
    expect(await runImportLoadBatch(deps, command)).toEqual({ state: 'stopped', processed: 0 });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  async function stagedKnowledgeBatch(prefix: string) {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
    const article = {
      externalId: `${prefix}-primary`,
      sectionExternalId: `${prefix}-section`,
      locale: 'en',
      title: 'Original article',
      bodyHtml: '<p>Original knowledge</p>',
      draft: true,
      internal: true,
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-02T00:00:00Z',
    };
    const records = [
      {
        entity: 'article',
        payload: {
          ...article,
          externalId: `${prefix}-translation`,
          translationOf: article.externalId,
          locale: 'ar',
          title: 'المقال الأصلي',
        },
      },
      { entity: 'article', payload: article },
      {
        entity: 'section',
        payload: {
          externalId: `${prefix}-section`,
          parentExternalId: `${prefix}-category`,
          names: { en: 'Section' },
        },
      },
      {
        entity: 'category',
        payload: { externalId: `${prefix}-category`, names: { en: 'Category' } },
      },
    ].map((record) => importRecordSchema.parse(record));
    for (const record of records)
      await owner.db.insert(importRecords).values({
        brandId: BRAND,
        runId,
        entity: record.entity,
        externalId: record.payload.externalId,
        payload: record.payload,
        payloadHash: hashImportValue(record.payload),
      });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing knowledge batch claim');
    return { claim, runId, records };
  }

  it('prepares knowledge outside record transactions and loads a reversed translation after its primary', async () => {
    const scenario = await stagedKnowledgeBatch('batch-knowledge');
    const order: string[] = [];
    const deps = {
      db: app.db,
      jobId: 'import.batch.knowledge',
      prepareArticle: async ({ record }: { record: { externalId: string; bodyHtml: string } }) => {
        order.push(record.externalId);
        return record.bodyHtml;
      },
    };
    expect(await runImportLoadBatch(deps, { claim: scenario.claim })).toEqual({
      state: 'records_loaded',
      processed: 4,
    });
    expect(order).toEqual(['batch-knowledge-primary', 'batch-knowledge-translation']);
    const staged = await owner.db
      .select()
      .from(importRecords)
      .where(eq(importRecords.runId, scenario.runId));
    expect(staged.every((record) => record.status === 'loaded')).toBe(true);
    const articles = staged.filter((record) => record.entity === 'article');
    expect(new Set(articles.map((record) => record.helpdockId)).size).toBe(1);
    expect(await runImportLoadBatch(deps, { claim: scenario.claim })).toEqual({
      state: 'records_loaded',
      processed: 0,
    });
    expect(order).toHaveLength(2);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('stops at article preparation and rechecks the claim before committing externally prepared content', async () => {
    const scenario = await stagedKnowledgeBatch('batch-pause');
    const deps = { db: app.db, jobId: 'import.batch.pause' };
    const awaiting = await runImportLoadBatch(deps, { claim: scenario.claim });
    expect(awaiting).toMatchObject({ state: 'article_required', processed: 2 });
    const result = await runImportLoadBatch(
      {
        ...deps,
        prepareArticle: async ({ record }) => {
          await withSystem(app.db, BRAND, (tx) =>
            pauseImportRun(tx, { brandId: BRAND, runId: scenario.runId }),
          );
          return record.bodyHtml;
        },
      },
      { claim: scenario.claim },
    );
    expect(result).toEqual({ state: 'stopped', processed: 0 });
    const articles = await owner.db
      .select()
      .from(importRecords)
      .where(and(eq(importRecords.runId, scenario.runId), eq(importRecords.entity, 'article')));
    expect(
      articles.every((record) => record.status === 'staged' && record.helpdockId === null),
    ).toBe(true);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  async function boundAccountRun(account: string, brandId = BRAND) {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: brandId,
      source: 'zendesk',
      status: 'connecting',
      startedBy: USER,
    });
    const key = await withSystem(app.db, brandId, (tx) =>
      bindImportSourceAccount(tx, { brandId: brandId, runId, verifiedAccount: account }),
    );
    await owner.db.update(importRuns).set({ status: 'loading' }).where(eq(importRuns.id, runId));
    return { runId, key };
  }

  it('separates identical ticket, message, contact and attachment IDs across accounts and reuses the original namespace on repeats', async () => {
    const results = [];
    for (const account of ['account-one', 'account-two', 'account-one']) {
      const run = await boundAccountRun(account);
      const scope = { brandId: BRAND, runId: run.runId, source: 'zendesk' as const };
      const contact = await withSystem(app.db, BRAND, (tx) =>
        writer.contact(
          tx,
          contactLoadSchema.parse({
            ...scope,
            record: {
              externalId: 'namespace-customer',
              name: account,
              emails: [`${account}@namespace.example`],
              phones: [],
              custom: {},
            },
            accountId: null,
            custom: {},
          }),
        ),
      );
      const input = request('namespace-ticket');
      input.runId = run.runId;
      input.record.subject = `${account} history`;
      input.resolved.contactId = contact.id;
      input.authors.customer = { kind: 'contact', id: contact.id };
      const message = input.messages[0];
      if (!message) throw new Error('Missing namespace message');
      message.email = {
        messageId: 'same-native-message@namespace.example',
        from: 'historical@namespace.example',
      };
      message.attachments = [
        {
          externalId: 'namespace-file',
          fileName: `${account}.pdf`,
          url: `https://vendor.example/${account}.pdf`,
          contentType: 'application/pdf',
        },
      ];
      const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
      results.push({ ...run, ...loaded, contactId: contact.id });
    }
    const [one, two, repeated] = results;
    if (!one || !two || !repeated) throw new Error('Missing account outcomes');
    expect(one.key).not.toBe(two.key);
    expect(one.ticketId).not.toBe(two.ticketId);
    expect(one.contactId).not.toBe(two.contactId);
    expect(repeated).toMatchObject({
      key: one.key,
      ticketId: one.ticketId,
      contactId: one.contactId,
      outcome: 'unchanged',
    });
    expect(
      (await owner.db.select().from(tickets).where(eq(tickets.id, one.ticketId)))[0]?.subject,
    ).toBe('account-one history');
    const pointers = await owner.db
      .select()
      .from(importExternalIds)
      .where(
        and(
          eq(importExternalIds.brandId, BRAND),
          eq(importExternalIds.externalId, 'namespace-file'),
        ),
      );
    expect(pointers).toHaveLength(2);
    expect(new Set(pointers.map((row) => row.sourceAccountKey)).size).toBe(2);
    expect(new Set(pointers.map((row) => row.helpdockId)).size).toBe(2);
    expect(
      await owner.db
        .select()
        .from(ticketMessages)
        .where(inArray(ticketMessages.ticketId, [one.ticketId, two.ticketId])),
    ).toHaveLength(4);
    const historicalHeaders = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.externalMessageId, 'same-native-message@namespace.example'));
    expect(historicalHeaders).toHaveLength(2);
    expect(new Set(historicalHeaders.map((row) => row.importSourceAccountKey)).size).toBe(2);
    const historical = historicalHeaders[0];
    if (!historical) throw new Error('Missing historical header');
    const liveCopy = {
      ...historical,
      id: uuidv7(),
      seq: historical.seq + 100,
      importSourceAccountKey: null,
    };
    await owner.db.insert(ticketMessages).values(liveCopy);
    await expect(
      owner.db
        .insert(ticketMessages)
        .values({ ...liveCopy, id: uuidv7(), seq: historical.seq + 101 }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'ticket_messages_external_key' },
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('refuses rebinding active or staged runs and verifies delta parent account identity', async () => {
    const original = await boundAccountRun('delta-account-one');
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        bindImportSourceAccount(tx, {
          brandId: BRAND,
          runId: original.runId,
          verifiedAccount: 'delta-account-two',
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    await owner.db
      .update(importRuns)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(importRuns.id, original.runId));
    const deltaId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: deltaId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'connecting',
      mode: 'delta',
      parentRunId: original.runId,
      startedBy: USER,
    });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        bindImportSourceAccount(tx, {
          brandId: BRAND,
          runId: deltaId,
          verifiedAccount: 'delta-account-two',
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        bindImportSourceAccount(tx, {
          brandId: BRAND,
          runId: deltaId,
          verifiedAccount: 'delta-account-one',
        }),
      ),
    ).toBe(original.key);
    const stagedId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: stagedId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'connecting',
      startedBy: USER,
    });
    const payload = { externalId: 'already-extracted', name: 'Group' };
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: stagedId,
      entity: 'group',
      externalId: payload.externalId,
      payload,
      payloadHash: hashImportValue(payload),
    });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        bindImportSourceAccount(tx, {
          brandId: BRAND,
          runId: stagedId,
          verifiedAccount: 'another-account',
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, stagedId)))[0]
        ?.sourceAccountKey,
    ).toBe('0'.repeat(64));
  });

  it('does not satisfy article dependencies from another account namespace', async () => {
    const original = await stagedKnowledgeBatch('account-parent');
    await runImportLoadBatch(
      {
        db: app.db,
        jobId: 'import.account.parent',
        prepareArticle: async ({ record }) => record.bodyHtml,
      },
      { claim: original.claim },
    );
    await owner.db
      .update(importRuns)
      .set({ status: 'completed', claimToken: null, claimedAt: null, finishedAt: new Date() })
      .where(eq(importRuns.id, original.runId));
    const bound = await boundAccountRun('different-knowledge-account');
    const record = importRecordSchema.parse({
      entity: 'article',
      payload: {
        externalId: 'cross-account-translation',
        translationOf: 'account-parent-primary',
        sectionExternalId: 'account-parent-section',
        locale: 'ar',
        title: 'مقال',
        bodyHtml: '<p>محتوى</p>',
        draft: true,
        internal: true,
        createdAt: '2020-01-01T00:00:00Z',
        updatedAt: '2020-01-02T00:00:00Z',
      },
    });
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: bound.runId,
      entity: record.entity,
      externalId: record.payload.externalId,
      payload: record.payload,
      payloadHash: hashImportValue(record.payload),
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId: bound.runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing cross-account claim');
    await expect(
      runImportLoadBatch({ db: app.db, jobId: 'import.account.dependency' }, { claim }),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      (await owner.db.select().from(importRecords).where(eq(importRecords.runId, bound.runId)))[0]
        ?.status,
    ).toBe('staged');
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('refuses queued work for unbound namespaces and mismatched delta accounts', async () => {
    const unbound = uuidv7();
    await owner.db.insert(importRuns).values({
      id: unbound,
      brandId: BRAND,
      source: 'zendesk',
      status: 'loading',
      startedBy: USER,
    });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        enqueueImportWork(tx, { brandId: BRAND, runId: unbound, step: 'load' }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    const parent = await boundAccountRun('queue-parent');
    await owner.db
      .update(importRuns)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(importRuns.id, parent.runId));
    const other = await boundAccountRun('queue-other');
    await owner.db
      .update(importRuns)
      .set({ mode: 'delta', parentRunId: parent.runId })
      .where(eq(importRuns.id, other.runId));
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        enqueueImportWork(tx, { brandId: BRAND, runId: other.runId, step: 'load' }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('schedules import work transactionally with delayed, idempotent BullMQ delivery and ignores stale paused events', async () => {
    const run = await boundAccountRun('queue-account');
    const scope = { brandId: BRAND, runId: run.runId, step: 'load' as const };
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await enqueueImportWork(tx, scope);
        throw new Error('queue request rollback');
      }),
    ).rejects.toThrow('queue request rollback');
    expect(await owner.db.select().from(outbox)).toEqual([]);
    const notBefore = new Date(Date.now() + 60000).toISOString();
    const eventId = await withSystem(app.db, BRAND, (tx) =>
      enqueueImportWork(tx, { ...scope, notBefore }),
    );
    const [event] = await owner.db.select().from(outbox).where(eq(outbox.id, eventId));
    if (!event) throw new Error('Missing work event');
    const connection = redis.duplicate({ maxRetriesPerRequest: null });
    const queue = new Queue(`m11-import-${uuidv7()}`, { connection });
    const handler = createImportWorkHandler({
      add: async (_step, payload, jobId, delay) => {
        await queue.add(importLoadJob.name, payload, { ...importLoadJob.options, jobId, delay });
      },
    });
    const deliver = () =>
      withSystem(app.db, BRAND, (tx) =>
        handler({
          tx,
          brandId: BRAND,
          event: event.event,
          payload: event.payload,
          outboxId: eventId,
          log: silentJobLogger,
        }),
      );
    try {
      await deliver();
      await deliver();
      const jobs = await queue.getJobs(['delayed', 'waiting']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.data).toEqual({ brandId: BRAND, runId: run.runId });
      expect(jobs[0]?.id).toBe(`import.load.${run.runId}.${eventId}`);
      expect(jobs[0]?.attemptsMade).toBe(0);
      expect(jobs[0]?.opts.delay).toBeGreaterThan(0);
      expect(await jobs[0]?.getState()).toBe('delayed');
      await withSystem(app.db, BRAND, (tx) =>
        pauseImportRun(tx, { brandId: BRAND, runId: run.runId }),
      );
      await queue.obliterate({ force: true });
      await deliver();
      expect(await queue.getJobs(['delayed', 'waiting'])).toEqual([]);
      await expect(
        withSystem(app.db, BRAND, (tx) => enqueueImportWork(tx, scope)),
      ).rejects.toMatchObject({ code: 'mapping-invalid' });
      await expect(
        withSystem(app.db, OTHER_BRAND, (tx) =>
          enqueueImportWork(tx, { ...scope, brandId: OTHER_BRAND }),
        ),
      ).rejects.toMatchObject({ code: 'mapping-invalid' });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
      await owner.db.delete(outbox).where(eq(outbox.id, eventId));
    }
  });

  it('consumes staged history through real Redis phase jobs to terminal credential purge', async () => {
    const scenario = await mappedHistoryScenario('queued-history');
    const key = 'f'.repeat(64);
    await owner.db
      .update(importRuns)
      .set({
        sourceAccountKey: key,
        claimToken: null,
        claimedAt: null,
        credentialsEncrypted: 'synthetic-envelope',
      })
      .where(eq(importRuns.id, scenario.input.runId));
    await owner.db.insert(importExternalIds).values({
      brandId: BRAND,
      source: 'zendesk',
      sourceAccountKey: key,
      entity: 'contact',
      externalId: 'customer',
      helpdockId: CONTACT,
      payloadHash: 'a'.repeat(64),
    });
    await owner.db
      .delete(importRecords)
      .where(
        and(eq(importRecords.runId, scenario.input.runId), eq(importRecords.entity, 'attachment')),
      );
    const messages = await owner.db
      .select()
      .from(importRecords)
      .where(
        and(eq(importRecords.runId, scenario.input.runId), eq(importRecords.entity, 'message')),
      );
    for (const row of messages) {
      const payload = { ...row.payload, attachments: [] };
      await owner.db
        .update(importRecords)
        .set({ payload, payloadHash: hashImportValue(payload) })
        .where(eq(importRecords.id, row.id));
    }
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-queue-'));
    const storage = new FakeStorage(dir);
    const producerConnection = redis.duplicate({ maxRetriesPerRequest: null });
    const workerConnection = redis.duplicate({ maxRetriesPerRequest: null });
    const queueName = `m11-phases-${uuidv7()}`;
    const queue = new Queue(queueName, { connection: producerConnection });
    const failures: string[] = [];
    const processor = createImportProcessor({
      db: app.db,
      storage,
      resolve: async () => downloadHarness(fake, storage),
    });
    const worker = new Worker(queueName, processor, {
      connection: workerConnection,
      concurrency: 1,
    });
    worker.on('failed', (_job, error) => failures.push(error.message));
    const delivered = new Set<string>();
    const bridge = createImportWorkHandler({
      add: async (step, payload, jobId, delay) => {
        const definition = JOB_DEFINITIONS[`import.${step}`];
        await queue.add(definition.name, payload, { ...definition.options, jobId, delay });
      },
    });
    try {
      await withSystem(app.db, BRAND, (tx) =>
        enqueueImportWork(tx, { brandId: BRAND, runId: scenario.input.runId, step: 'load' }),
      );
      const deadline = Date.now() + 15000;
      let status = '';
      while (Date.now() < deadline) {
        const events = await owner.db
          .select()
          .from(outbox)
          .where(
            and(
              eq(outbox.event, 'import.work_requested'),
              sql`${outbox.payload}->>'runId' = ${scenario.input.runId}`,
            ),
          );
        for (const event of events)
          if (!delivered.has(event.id)) {
            await withSystem(app.db, BRAND, (tx) =>
              bridge({
                tx,
                brandId: BRAND,
                event: event.event,
                payload: event.payload,
                outboxId: event.id,
                log: silentJobLogger,
              }),
            );
            delivered.add(event.id);
          }
        status =
          (
            await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.input.runId))
          )[0]?.status ?? '';
        if (status === 'completed' || status === 'failed') break;
        await waitForQueue(20);
      }
      expect(failures).toEqual([]);
      expect(status).toBe('completed');
      expect(
        (
          await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.input.runId))
        )[0],
      ).toMatchObject({ credentialsEncrypted: null, claimToken: null });
      const [pointer] = await owner.db
        .select()
        .from(importExternalIds)
        .where(
          and(
            eq(importExternalIds.sourceAccountKey, key),
            eq(importExternalIds.entity, 'ticket'),
            eq(importExternalIds.externalId, 'queued-history'),
          ),
        );
      if (!pointer) throw new Error('Missing queued historical ticket');
      expect(
        await owner.db
          .select()
          .from(ticketMessages)
          .where(eq(ticketMessages.ticketId, pointer.helpdockId)),
      ).toHaveLength(2);
      expect(
        await owner.db.select().from(outbox).where(sql`${outbox.event} <> 'import.work_requested'`),
      ).toEqual([]);
      expect(fake.server.calls).toEqual([]);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await workerConnection.quit();
      await producerConnection.quit();
      await owner.db
        .delete(outbox)
        .where(sql`${outbox.payload}->>'runId' = ${scenario.input.runId}`);
      await fake.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defers rate-limited phase jobs without terminal failure or credential purge', async () => {
    const run = await boundAccountRun('queue-rate-limit');
    await owner.db
      .update(importRuns)
      .set({ credentialsEncrypted: 'synthetic-envelope' })
      .where(eq(importRuns.id, run.runId));
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-rate-'));
    try {
      const processor = createImportProcessor({
        db: app.db,
        storage: new FakeStorage(dir),
        resolve: async () => {
          throw new RateLimited(60000);
        },
      });
      await processor({
        name: 'import.attachments',
        data: { brandId: BRAND, runId: run.runId },
        id: 'rate-limited-fixture',
      });
      const [stored] = await owner.db.select().from(importRuns).where(eq(importRuns.id, run.runId));
      expect(stored).toMatchObject({
        status: 'loading',
        claimToken: null,
        credentialsEncrypted: 'synthetic-envelope',
        finishedAt: null,
      });
      expect(Date.parse(String(stored?.counts.retryAt))).toBeGreaterThan(Date.now() + 50000);
      const events = await owner.db.select().from(outbox);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        step: 'attachments',
        runId: run.runId,
        notBefore: stored?.counts.retryAt,
      });
      expect(JSON.stringify(events)).not.toContain('synthetic-envelope');
      await owner.db.delete(outbox).where(sql`${outbox.payload}->>'runId' = ${run.runId}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ends opaque phase failures with safe logs, one audit and credential purge', async () => {
    const run = await boundAccountRun('queue-opaque-failure');
    await owner.db
      .update(importRuns)
      .set({ credentialsEncrypted: 'synthetic-envelope' })
      .where(eq(importRuns.id, run.runId));
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-failure-'));
    try {
      const processor = createImportProcessor({
        db: app.db,
        storage: new FakeStorage(dir),
        resolve: async () => {
          throw new Error('provider body contains private-token-fixture');
        },
      });
      const job = {
        name: 'import.attachments',
        data: { brandId: BRAND, runId: run.runId },
        id: 'opaque-failure-fixture',
      };
      await processor(job);
      await processor(job);
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, run.runId)))[0],
      ).toMatchObject({
        status: 'failed',
        error: 'execution-failed',
        credentialsEncrypted: null,
        claimToken: null,
      });
      const logs = await owner.db.select().from(importLog).where(eq(importLog.runId, run.runId));
      expect(logs.map((row) => row.message)).toEqual(['import.execution-failed']);
      const audits = await owner.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetId, run.runId), eq(auditLog.action, 'import.failed')));
      expect(audits).toHaveLength(1);
      expect(JSON.stringify({ logs, audits })).not.toContain('private-token-fixture');
      expect(await owner.db.select().from(outbox)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers expired import claims once per minute and fences the old worker without touching fresh or paused runs', async () => {
    const recoveryBrand = uuidv7();
    await owner.db.insert(brands).values({ id: recoveryBrand, name: 'Recovery', prefix: 'RCR' });
    const expired = await boundAccountRun('recovery-expired', recoveryBrand);
    const claim = await withSystem(app.db, recoveryBrand, (tx) =>
      claimImportRun(tx, { brandId: recoveryBrand, runId: expired.runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing recovery claim');
    await owner.db
      .update(importRuns)
      .set({ claimedAt: new Date(Date.now() - IMPORT_CLAIM_TIMEOUT_MS - 1000) })
      .where(eq(importRuns.id, expired.runId));
    const waiting = await boundAccountRun('recovery-waiting', recoveryBrand);
    await owner.db
      .update(importRuns)
      .set({ counts: { retryAt: new Date(Date.now() + 3600000).toISOString() } })
      .where(eq(importRuns.id, waiting.runId));
    const paused = await boundAccountRun('recovery-paused', recoveryBrand);
    await withSystem(app.db, recoveryBrand, (tx) =>
      pauseImportRun(tx, { brandId: recoveryBrand, runId: paused.runId }),
    );
    const now = new Date();
    expect(
      await withSystem(app.db, recoveryBrand, (tx) => recoverBrandImports(tx, recoveryBrand, now)),
    ).toBe(1);
    expect(
      await withSystem(app.db, recoveryBrand, (tx) => recoverBrandImports(tx, recoveryBrand, now)),
    ).toBe(0);
    await expect(
      withSystem(app.db, recoveryBrand, (tx) => renewImportClaim(tx, claim)),
    ).rejects.toThrow('import.claim-lost');
    const events = await owner.db.select().from(outbox);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ runId: expired.runId, step: 'load' });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, expired.runId)))[0]?.counts,
    ).toMatchObject({ recoveryRequestedAt: now.toISOString() });
    const replacement = await withSystem(app.db, recoveryBrand, (tx) =>
      claimImportRun(tx, { brandId: recoveryBrand, runId: expired.runId, phase: 'loading' }),
    );
    if (!replacement) throw new Error('Missing replacement recovery claim');
    expect(replacement.token).not.toBe(claim.token);
    expect(
      await withSystem(app.db, recoveryBrand, (tx) =>
        recoverBrandImports(tx, recoveryBrand, new Date(now.getTime() + 61000)),
      ),
    ).toBe(0);
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, paused.runId)))[0]?.status,
    ).toBe('paused');
    await owner.db.delete(outbox).where(sql`${outbox.payload}->>'runId' = ${expired.runId}`);
  });

  async function historicalReportScenario(prefix: string, rebuildAllReports = true) {
    const brandId = uuidv7();
    const departmentId = uuidv7();
    const statusId = uuidv7();
    const runId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Historical report fixture', prefix, timezone: 'UTC' });
    await owner.db.insert(departments).values({ id: departmentId, brandId, name: 'Historical' });
    await owner.db
      .insert(ticketStatuses)
      .values({ id: statusId, brandId, name: 'Closed', systemState: 'closed', color: 'info' });
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId,
      source: 'zendesk',
      status: 'loading',
      startedBy: USER,
      options: { rebuildAllReports },
      credentialsEncrypted: 'synthetic-envelope',
    });
    const input = request(`report-${prefix}`);
    input.brandId = brandId;
    input.runId = runId;
    input.resolved = {
      ...input.resolved,
      departmentId,
      statusId,
      assigneeId: null,
      contactId: null,
    };
    input.record.status = 'closed';
    input.record.closedAt = '2019-01-03T00:00:00Z';
    input.authors = { oldagent: { kind: 'name', name: 'Historical agent' } };
    input.messages = [
      {
        ...input.messages[0],
        externalId: `reply-${prefix}`,
        ticketExternalId: input.record.externalId,
        authorExternalId: 'oldagent',
        authorKind: 'agent',
        public: true,
        bodyText: 'Historical reply',
        createdAt: '2019-01-02T00:00:00Z',
        attachments: [],
      },
    ];
    const loaded = await withSystem(app.db, brandId, (tx) => writer.ticket(tx, input));
    await owner.db.insert(importRecords).values({
      brandId,
      runId,
      entity: 'ticket',
      externalId: input.record.externalId,
      payload: input.record,
      payloadHash: hashImportValue(input.record),
      status: 'loaded',
      helpdockId: loaded.ticketId,
    });
    await owner.db.update(importRuns).set({ status: 'finishing' }).where(eq(importRuns.id, runId));
    const claim = await withSystem(app.db, brandId, (tx) =>
      claimImportRun(tx, { brandId, runId, phase: 'finishing' }),
    );
    if (!claim) throw new Error('Missing report claim');
    return { claim, ticketId: loaded.ticketId, runId, brandId };
  }

  it('rebuilds original report days in resumable chunks and leaves completion cleanup to the finish step', async () => {
    const scenario = await historicalReportScenario('RPA');
    const now = new Date('2019-03-05T12:00:00Z');
    const next = () =>
      withSystem(app.db, scenario.brandId, (tx) =>
        rebuildImportReportsBatch(tx, scenario.claim, now),
      );
    expect(await next()).toMatchObject({
      state: 'more',
      progress: { from: '2019-01-01', next: '2019-02-01', clipped: false },
    });
    const reports = await owner.db
      .select()
      .from(reportDaily)
      .where(eq(reportDaily.brandId, scenario.brandId));
    expect(reports.find((row) => row.day === '2019-01-01')?.created).toBe(1);
    expect(reports.find((row) => row.day === '2019-01-02')).toMatchObject({
      firstResponseMs: [86400000],
    });
    expect(reports.find((row) => row.day === '2019-01-03')?.resolved).toBe(1);
    expect(await next()).toMatchObject({ state: 'more', progress: { next: '2019-03-04' } });
    expect(await next()).toMatchObject({ state: 'reports_complete', progress: { next: null } });
    const revisions = await owner.db.execute(
      sql`SELECT day, xmin::text AS revision FROM report_daily WHERE brand_id = ${scenario.brandId} ORDER BY day`,
    );
    expect(await next()).toMatchObject({ state: 'reports_complete' });
    expect(
      await owner.db.execute(
        sql`SELECT day, xmin::text AS revision FROM report_daily WHERE brand_id = ${scenario.brandId} ORDER BY day`,
      ),
    ).toEqual(revisions);
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.runId)))[0],
    ).toMatchObject({
      status: 'finishing',
      credentialsEncrypted: 'synthetic-envelope',
      finishedAt: null,
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('rolls back report rows and cursor together, and refuses a paused worker or changed report grain', async () => {
    const scenario = await historicalReportScenario('RPB');
    const now = new Date('2019-03-05T12:00:00Z');
    await expect(
      withSystem(app.db, scenario.brandId, async (tx) => {
        await rebuildImportReportsBatch(tx, scenario.claim, now);
        throw new Error('interrupted report chunk');
      }),
    ).rejects.toThrow('interrupted report chunk');
    expect(
      await owner.db.select().from(reportDaily).where(eq(reportDaily.brandId, scenario.brandId)),
    ).toEqual([]);
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.runId)))[0]
        ?.counts,
    ).toEqual({});
    await withSystem(app.db, scenario.brandId, (tx) =>
      rebuildImportReportsBatch(tx, scenario.claim, now),
    );
    await owner.db
      .update(brands)
      .set({ timezone: 'Asia/Riyadh' })
      .where(eq(brands.id, scenario.brandId));
    await expect(
      withSystem(app.db, scenario.brandId, (tx) =>
        rebuildImportReportsBatch(tx, scenario.claim, now),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    await withSystem(app.db, scenario.brandId, (tx) =>
      pauseImportRun(tx, { brandId: scenario.brandId, runId: scenario.runId }),
    );
    await expect(
      withSystem(app.db, scenario.brandId, (tx) =>
        rebuildImportReportsBatch(tx, scenario.claim, now),
      ),
    ).rejects.toThrow('import.claim-lost');
  });

  it('records one clipping warning and prevents historical report targets crossing brands', async () => {
    const scenario = await historicalReportScenario('RPC', false);
    const now = new Date('2026-10-14T12:00:00Z');
    expect(
      await withSystem(app.db, scenario.brandId, (tx) =>
        rebuildImportReportsBatch(tx, scenario.claim, now),
      ),
    ).toMatchObject({
      state: 'more',
      progress: { from: '2025-09-10', next: '2025-10-11', clipped: true },
    });
    await withSystem(app.db, scenario.brandId, (tx) =>
      rebuildImportReportsBatch(tx, scenario.claim, now),
    );
    expect(
      (await owner.db.select().from(importLog).where(eq(importLog.runId, scenario.runId))).map(
        (row) => row.message,
      ),
    ).toEqual(['import.reports.history-clipped']);
    const foreign = await historicalReportScenario('RPD');
    await owner.db
      .update(importRecords)
      .set({ helpdockId: scenario.ticketId })
      .where(eq(importRecords.runId, foreign.runId));
    await expect(
      withSystem(app.db, foreign.brandId, (tx) =>
        rebuildImportReportsBatch(tx, foreign.claim, now),
      ),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    expect(
      await owner.db.select().from(reportDaily).where(eq(reportDaily.brandId, foreign.brandId)),
    ).toEqual([]);
  });

  it('finishes only after all report chunks and purges credentials exactly once', async () => {
    const scenario = await historicalReportScenario('RPE');
    const now = new Date('2019-03-05T12:00:00Z');
    const deps = { db: app.db, jobId: 'import.finish.fixture' };
    expect(await runImportFinishBatch(deps, scenario.claim, now)).toEqual({ state: 'more' });
    expect(await runImportFinishBatch(deps, scenario.claim, now)).toEqual({ state: 'more' });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.runId)))[0]
        ?.credentialsEncrypted,
    ).toBe('synthetic-envelope');
    expect(await runImportFinishBatch(deps, scenario.claim, now)).toEqual({ state: 'completed' });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.runId)))[0],
    ).toMatchObject({
      status: 'completed',
      credentialsEncrypted: null,
      claimToken: null,
      claimedAt: null,
      finishedAt: now,
    });
    expect(await runImportFinishBatch(deps, scenario.claim, now)).toEqual({
      state: 'already_completed',
    });
    const audits = await owner.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'import.completed'), eq(auditLog.targetId, scenario.runId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.meta).toEqual({ source: 'zendesk', mode: 'full' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('rolls back completion, credential purge, audit and the single import event together', async () => {
    const scenario = await stagedKnowledgeBatch('completion-knowledge');
    const deps = {
      db: app.db,
      jobId: 'import.finish.knowledge',
      prepareArticle: async ({ record }: { record: { bodyHtml: string } }) => record.bodyHtml,
    };
    await runImportLoadBatch(deps, { claim: scenario.claim });
    await owner.db
      .update(importRuns)
      .set({ credentialsEncrypted: 'synthetic-envelope' })
      .where(eq(importRuns.id, scenario.runId));
    const claim = await withSystem(app.db, BRAND, (tx) => beginImportFinishing(tx, scenario.claim));
    if (!claim) throw new Error('Missing finishing claim');
    await expect(withSystem(app.db, BRAND, (tx) => completeImportRun(tx, claim))).rejects.toThrow();
    await withSystem(app.db, BRAND, (tx) => rebuildImportReportsBatch(tx, claim));
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await completeImportRun(tx, claim);
        throw new Error('completion rollback');
      }),
    ).rejects.toThrow('completion rollback');
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.runId)))[0],
    ).toMatchObject({
      status: 'finishing',
      credentialsEncrypted: 'synthetic-envelope',
      finishedAt: null,
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(
      await owner.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'import.completed'), eq(auditLog.targetId, scenario.runId))),
    ).toEqual([]);
    expect(await runImportFinishBatch(deps, claim)).toEqual({ state: 'completed' });
    expect(await runImportFinishBatch(deps, claim)).toEqual({ state: 'already_completed' });
    const events = await owner.db.select().from(outbox);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (!event) throw new Error('Missing import event');
    expect(event).toMatchObject({
      brandId: BRAND,
      event: 'help_center.imported',
      payload: { runId: scenario.runId },
    });
    const ids: string[] = [];
    await withSystem(app.db, BRAND, (tx) =>
      forEachImportedArticleBatch(tx, { brandId: BRAND, runId: scenario.runId }, async (batch) => {
        ids.push(...batch);
      }),
    );
    expect(ids).toHaveLength(1);
    let embeddings = 0;
    const handler = createArticleKnowledgeHandlers({
      addEmbed: async () => {
        embeddings++;
      },
    }).imported;
    await withSystem(app.db, BRAND, async (tx) => {
      const context = {
        tx,
        brandId: BRAND,
        event: event.event,
        payload: event.payload,
        outboxId: event.id,
        log: silentJobLogger,
      };
      await importedArticlesHandler(context);
      await handler(context);
      await importedArticlesHandler(context);
      await handler(context);
    });
    expect(embeddings).toBe(0);
    const [quiet] =
      await owner.db.execute(sql`SELECT (SELECT count(*) FROM ai_calls WHERE brand_id = ${BRAND})::int AS ai,
      (SELECT count(*) FROM webhook_deliveries WHERE brand_id = ${BRAND})::int AS webhooks`);
    expect(quiet).toMatchObject({ ai: 0, webhooks: 0 });
    await expect(
      withSystem(app.db, OTHER_BRAND, (tx) =>
        forEachImportedArticleBatch(
          tx,
          { brandId: OTHER_BRAND, runId: scenario.runId },
          async () => {},
        ),
      ),
    ).rejects.toThrow('import.event-run-unavailable');
    await owner.db.delete(outbox).where(eq(outbox.id, event.id));
    const repeated = await stagedKnowledgeBatch('completion-knowledge');
    await runImportLoadBatch(deps, { claim: repeated.claim });
    const repeatedClaim = await withSystem(app.db, BRAND, (tx) =>
      beginImportFinishing(tx, repeated.claim),
    );
    if (!repeatedClaim) throw new Error('Missing repeated finishing claim');
    expect(await runImportFinishBatch(deps, repeatedClaim)).toEqual({ state: 'completed' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('pages imported article targets and reindexes published en/ar versions without repeating embedding work', async () => {
    const scenario = await stagedKnowledgeBatch('published-completion');
    const rows = await owner.db
      .select()
      .from(importRecords)
      .where(and(eq(importRecords.runId, scenario.runId), eq(importRecords.entity, 'article')));
    for (const row of rows) {
      const native = importRecordSchema.parse({ entity: 'article', payload: row.payload });
      if (native.entity !== 'article') throw new Error('Missing native article');
      const payload = { ...native.payload, draft: false, internal: false };
      await owner.db
        .update(importRecords)
        .set({ payload, payloadHash: hashImportValue(payload) })
        .where(eq(importRecords.id, row.id));
    }
    await runImportLoadBatch(
      {
        db: app.db,
        jobId: 'import.published.load',
        prepareArticle: async ({ record }) => record.bodyHtml,
      },
      { claim: scenario.claim },
    );
    const [loaded] = await owner.db
      .select()
      .from(importRecords)
      .where(and(eq(importRecords.runId, scenario.runId), eq(importRecords.entity, 'article')))
      .limit(1);
    if (!loaded?.helpdockId) throw new Error('Missing article target');
    const [original] = await owner.db
      .select()
      .from(hcArticles)
      .where(eq(hcArticles.id, loaded.helpdockId));
    if (!original) throw new Error('Missing original article');
    for (let index = 0; index < 11; index++) {
      const id = uuidv7();
      await owner.db.insert(hcArticles).values({
        id,
        brandId: BRAND,
        sectionId: original.sectionId,
        slug: `pagination-fixture-${index}`,
      });
      const payload = { ...loaded.payload, externalId: `pagination-${index}` };
      await owner.db.insert(importRecords).values({
        brandId: BRAND,
        runId: scenario.runId,
        entity: 'article',
        externalId: `pagination-${index}`,
        payload,
        payloadHash: hashImportValue(payload),
        status: 'loaded',
        helpdockId: id,
      });
    }
    const claim = await withSystem(app.db, BRAND, (tx) => beginImportFinishing(tx, scenario.claim));
    if (!claim) throw new Error('Missing published finishing claim');
    expect(
      await runImportFinishBatch({ db: app.db, jobId: 'import.published.finish' }, claim),
    ).toEqual({ state: 'completed' });
    const [event] = await owner.db.select().from(outbox);
    if (!event) throw new Error('Missing published import event');
    const pages: string[][] = [];
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        forEachImportedArticleBatch(tx, { brandId: BRAND, runId: scenario.runId }, async (ids) => {
          pages.push(ids);
        }),
      ),
    ).toBe(12);
    expect(pages.map((page) => page.length)).toEqual([10, 2]);
    expect(new Set(pages.flat()).size).toBe(12);
    let embeddings = 0;
    const knowledge = createArticleKnowledgeHandlers({
      addEmbed: async () => {
        embeddings++;
      },
    }).imported;
    const deliver = () =>
      withSystem(app.db, BRAND, async (tx) => {
        const context = {
          tx,
          brandId: BRAND,
          event: event.event,
          payload: event.payload,
          outboxId: event.id,
          log: silentJobLogger,
        };
        await importedArticlesHandler(context);
        await knowledge(context);
      });
    await deliver();
    const indexed = await owner.db
      .select()
      .from(hcSearchDocuments)
      .where(eq(hcSearchDocuments.articleId, original.id));
    expect(indexed.map((row) => row.locale).sort()).toEqual(['ar', 'en']);
    expect(
      await owner.db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.articleId, original.id)),
    ).toHaveLength(2);
    expect(embeddings).toBe(1);
    await deliver();
    expect(embeddings).toBe(1);
    expect(
      await owner.db
        .select()
        .from(hcSearchDocuments)
        .where(eq(hcSearchDocuments.articleId, original.id)),
    ).toEqual(indexed);
    await owner.db.delete(outbox).where(eq(outbox.id, event.id));
  });

  it.each(['pending', 'processing', 'ready', 'rejected', 'infected'] as const)(
    'only advances import finalization once attachment status %s is settled',
    async (status) => {
      const scenario = await stagedTicketScenario(`finish-media-${status}`);
      expect(
        await withSystem(app.db, BRAND, (tx) => beginImportFinishing(tx, scenario.claim)),
      ).toBeNull();
      const loaded = await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
      await owner.db
        .update(attachments)
        .set({ status })
        .where(eq(attachments.ticketId, loaded.ticketId));
      const next = await withSystem(app.db, BRAND, (tx) =>
        beginImportFinishing(tx, scenario.claim),
      );
      const settled = ['ready', 'rejected', 'infected'].includes(status);
      expect(next).toEqual(settled ? { ...scenario.claim, phase: 'finishing' } : null);
      expect(
        (
          await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.input.runId))
        )[0],
      ).toMatchObject({
        status: settled ? 'finishing' : 'loading',
        claimToken: scenario.claim.token,
        finishedAt: null,
      });
      expect(await owner.db.select().from(outbox)).toEqual([]);
      if (next) {
        await expect(
          withSystem(app.db, BRAND, (tx) => renewImportClaim(tx, scenario.claim)),
        ).rejects.toThrow('import.claim-lost');
        await withSystem(app.db, BRAND, (tx) => renewImportClaim(tx, next));
      }
    },
  );

  it('refuses missing imported media and rolls back the finalization boundary atomically', async () => {
    const scenario = await stagedTicketScenario('finish-rollback');
    const loaded = await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
    await owner.db
      .update(attachments)
      .set({ status: 'ready' })
      .where(eq(attachments.ticketId, loaded.ticketId));
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await beginImportFinishing(tx, scenario.claim);
        throw new Error('finish rollback');
      }),
    ).rejects.toThrow('finish rollback');
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.input.runId)))[0]
        ?.status,
    ).toBe('loading');
    await owner.db.delete(attachments).where(eq(attachments.ticketId, loaded.ticketId));
    await expect(
      withSystem(app.db, BRAND, (tx) => beginImportFinishing(tx, scenario.claim)),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, scenario.input.runId)))[0]
        ?.status,
    ).toBe('loading');
  });

  it('loads customer user references through contacts without creating staff or replaying counts', async () => {
    const runId = uuidv7();
    const externalId = 'reference-customer';
    const contactId = uuidv7();
    await owner.db
      .insert(contacts)
      .values({ id: contactId, brandId: BRAND, name: 'Reference customer' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
    await owner.db.insert(importExternalIds).values({
      brandId: BRAND,
      source: 'zendesk',
      entity: 'contact',
      externalId,
      helpdockId: contactId,
      payloadHash: 'a'.repeat(64),
    });
    const payload = { externalId, kind: 'customer', name: 'Historical customer', active: true };
    const [record] = await owner.db
      .insert(importRecords)
      .values({
        brandId: BRAND,
        runId,
        entity: 'user',
        externalId,
        payload,
        payloadHash: hashImportValue(payload),
      })
      .returning({ id: importRecords.id });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim || !record) throw new Error('Missing customer reference');
    const usersBefore = await owner.db.select().from(users);
    const rolesBefore = await owner.db.select().from(userBrandRoles);
    expect(
      await runImportLoadBatch({ db: app.db, jobId: 'import.reference.customer' }, { claim }),
    ).toEqual({ state: 'records_loaded', processed: 1 });
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        loadStagedReference(tx, { claim, recordId: record.id }),
      ),
    ).toEqual({ state: 'already_done', id: contactId });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts,
    ).toEqual({ loaded: { user: 1 } });
    expect(await owner.db.select().from(users)).toEqual(usersBefore);
    expect(await owner.db.select().from(userBrandRoles)).toEqual(rolesBefore);
    expect(await owner.db.select().from(outbox)).toEqual([]);
    await owner.db
      .update(contacts)
      .set({ anonymisedAt: new Date() })
      .where(eq(contacts.id, contactId));
    await expect(
      withSystem(app.db, BRAND, (tx) => loadStagedReference(tx, { claim, recordId: record.id })),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
  });

  it('checkpoints mapped group and explicit tag skips once without creating domain rows', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'loading',
      startedBy: USER,
    });
    const records = [
      importRecordSchema.parse({
        entity: 'group',
        payload: { externalId: '42', name: 'Legacy support' },
      }),
      importRecordSchema.parse({
        entity: 'tag',
        payload: { externalId: '77', name: 'legacy-label' },
      }),
    ];
    const staged = await owner.db
      .insert(importRecords)
      .values(
        records.map((record) => ({
          brandId: BRAND,
          runId,
          entity: record.entity,
          externalId: record.payload.externalId,
          payload: record.payload,
          payloadHash: hashImportValue(record.payload),
        })),
      )
      .returning({ id: importRecords.id, entity: importRecords.entity });
    await owner.db.insert(importMappings).values([
      {
        brandId: BRAND,
        runId,
        kind: 'group',
        externalValue: '42',
        target: { departmentId: DEPARTMENT, teamId: null },
      },
      {
        brandId: BRAND,
        runId,
        kind: 'tag',
        externalValue: 'legacy-label',
        target: { tagId: null },
      },
    ]);
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing reference claim');
    const departmentsBefore = await owner.db.select().from(departments);
    const tagsBefore = await owner.db.select().from(tags);
    expect(
      await runImportLoadBatch({ db: app.db, jobId: 'import.reference.batch' }, { claim }),
    ).toEqual({ state: 'records_loaded', processed: 2 });
    for (const record of staged) {
      expect(
        await withSystem(app.db, BRAND, (tx) =>
          loadStagedReference(tx, { claim, recordId: record.id }),
        ),
      ).toEqual({ state: 'already_done', id: record.entity === 'group' ? DEPARTMENT : null });
    }
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts,
    ).toEqual({ loaded: { group: 1 }, skipped: { tag: 1 } });
    expect(await owner.db.select().from(departments)).toEqual(departmentsBefore);
    expect(await owner.db.select().from(tags)).toEqual(tagsBefore);
    expect(await owner.db.select().from(outbox)).toEqual([]);
    await owner.db
      .update(importMappings)
      .set({ target: { departmentId: OTHER_DEPARTMENT, teamId: null } })
      .where(and(eq(importMappings.runId, runId), eq(importMappings.kind, 'group')));
    const group = staged.find((row) => row.entity === 'group');
    if (!group) throw new Error('Missing group receipt');
    await expect(
      withSystem(app.db, BRAND, (tx) => loadStagedReference(tx, { claim, recordId: group.id })),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts,
    ).toEqual({ loaded: { group: 1 }, skipped: { tag: 1 } });
  });

  it.each(['group', 'message'] as const)(
    'keeps unresolved $0 records out of the completed-record boundary',
    async (entity) => {
      const runId = uuidv7();
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: BRAND,
        source: 'zendesk',
        status: 'loading',
        startedBy: USER,
      });
      const record = importRecordSchema.parse(
        entity === 'group'
          ? { entity, payload: { externalId: 'batch-reference-group', name: 'Original group' } }
          : {
              entity,
              payload: {
                externalId: 'batch-orphan-message',
                ticketExternalId: 'absent-ticket',
                authorKind: 'system',
                public: true,
                bodyText: 'Unattached history',
                createdAt: '2020-01-01T00:00:00Z',
                attachments: [],
              },
            },
      );
      const [staged] = await owner.db
        .insert(importRecords)
        .values({
          brandId: BRAND,
          runId,
          entity: record.entity,
          externalId: record.payload.externalId,
          payload: record.payload,
          payloadHash: hashImportValue(record.payload),
        })
        .returning({ id: importRecords.id });
      const claim = await withSystem(app.db, BRAND, (tx) =>
        claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
      );
      if (!claim || !staged) throw new Error('Missing boundary fixture');
      const batch = runImportLoadBatch({ db: app.db, jobId: 'import.batch.reference' }, { claim });
      await expect(batch).rejects.toMatchObject({ code: 'mapping-invalid' });
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0],
      ).toMatchObject({ status: 'loading', counts: {} });
      expect(
        (await owner.db.select().from(importRecords).where(eq(importRecords.id, staged.id)))[0]
          ?.status,
      ).toBe('staged');
      expect(await owner.db.select().from(outbox)).toEqual([]);
    },
  );

  it.each(['existing', 'invited', 'name'] as const)(
    'checkpoints %s staff mappings once without invitation delivery',
    async (kind) => {
      const runId = uuidv7();
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: BRAND,
        source: 'zendesk',
        status: 'loading',
        startedBy: USER,
      });
      const input = staffLoadSchema.parse({
        brandId: BRAND,
        runId,
        source: 'zendesk',
        record: {
          externalId: `checkpoint-staff-${kind}`,
          kind: 'agent',
          name: 'Historical staff',
          active: false,
          email: `checkpoint-staff-${kind}@example.invalid`,
        },
        mapping:
          kind === 'existing'
            ? { kind, userId: USER }
            : kind === 'invited'
              ? { kind, departmentIds: [DEPARTMENT] }
              : { kind },
      });
      const recordId = uuidv7();
      await owner.db.insert(importRecords).values({
        id: recordId,
        brandId: BRAND,
        runId,
        entity: 'user',
        externalId: input.record.externalId,
        payload: input.record,
        payloadHash: hashImportValue(input.record),
      });
      const before = await owner.db.select({ id: users.id }).from(users).orderBy(users.id);
      const claim = await withSystem(app.db, BRAND, (tx) =>
        claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
      );
      if (!claim) throw new Error('Missing loading claim');
      const operation = { entity: 'user' as const, input };
      const loaded = await withSystem(app.db, BRAND, (tx) =>
        loadStagedRecord(tx, { claim, recordId, operation }),
      );
      expect(loaded.state).toBe('loaded');
      expect(
        await withSystem(app.db, BRAND, (tx) =>
          loadStagedRecord(tx, { claim, recordId, operation }),
        ),
      ).toEqual({ state: 'already_done', id: loaded.id });
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts,
      ).toEqual({ loaded: { user: 1 } });
      const after = await owner.db.select({ id: users.id }).from(users).orderBy(users.id);
      if (kind === 'invited') {
        expect(after).toHaveLength(before.length + 1);
        if (!loaded.id) throw new Error('Missing invited user');
        expect(
          (await owner.db.select().from(users).where(eq(users.id, loaded.id)))[0],
        ).toMatchObject({ status: 'invited' });
      } else {
        expect(after).toEqual(before);
        expect(loaded.id).toBe(kind === 'name' ? null : USER);
      }
      expect(await owner.db.select().from(outbox)).toEqual([]);
      expect(await redis.dbsize()).toBe(0);
    },
  );

  it('builds field, profile, staff and knowledge loads directly from staged records and confirmed mappings', async () => {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
    const records = [
      {
        entity: 'field',
        payload: {
          externalId: 'prepared-field',
          target: 'organization',
          key: 'source_region',
          label: 'Region',
          type: 'text',
        },
      },
      {
        entity: 'organization',
        payload: {
          externalId: 'prepared-org',
          name: 'Prepared company',
          domains: ['prepared.invalid'],
          custom: { source_region: 'North' },
        },
      },
      {
        entity: 'contact',
        payload: {
          externalId: 'prepared-contact',
          name: 'Prepared contact',
          organizationExternalId: 'prepared-org',
          emails: ['prepared@example.invalid'],
          phones: [],
          custom: {},
        },
      },
      {
        entity: 'user',
        payload: {
          externalId: 'prepared-agent',
          kind: 'agent',
          name: 'Historical person',
          active: false,
        },
      },
      {
        entity: 'category',
        payload: {
          externalId: 'prepared-category',
          names: { en: 'Prepared docs', ar: 'توثيق الاستيراد' },
        },
      },
      {
        entity: 'section',
        payload: {
          externalId: 'prepared-section',
          parentExternalId: 'prepared-category',
          names: { en: 'Prepared section', ar: 'قسم الاستيراد' },
        },
      },
      {
        entity: 'article',
        payload: {
          externalId: 'prepared-article',
          sectionExternalId: 'prepared-section',
          locale: 'en',
          title: 'Prepared article',
          bodyHtml: '<p>Prepared history</p>',
          draft: true,
          internal: true,
          createdAt: '2020-01-01T00:00:00Z',
          updatedAt: '2020-01-02T00:00:00Z',
        },
      },
    ].map((record) => importRecordSchema.parse(record));
    const ids = new Map<string, string>();
    for (const record of records) {
      const id = uuidv7();
      ids.set(record.payload.externalId, id);
      await owner.db.insert(importRecords).values({
        id,
        brandId: BRAND,
        runId,
        entity: record.entity,
        externalId: record.payload.externalId,
        payload: record.payload,
        payloadHash: hashImportValue(record.payload),
      });
    }
    await owner.db.insert(importMappings).values([
      {
        brandId: BRAND,
        runId,
        kind: 'field',
        externalValue: 'prepared-field',
        target: {
          kind: 'create',
          definition: { target: 'account', key: 'prepared_region', label: 'Region', type: 'text' },
        },
      },
      {
        brandId: BRAND,
        runId,
        kind: 'agent',
        externalValue: 'prepared-agent',
        target: { kind: 'name' },
      },
    ]);
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing loading claim');
    const targets = new Map<string, string | null>();
    for (const record of records) {
      const recordId = ids.get(record.payload.externalId);
      if (!recordId) throw new Error('Missing staged record');
      if (record.entity === 'article')
        await expect(
          withSystem(app.db, BRAND, (tx) => loadPreparedStagedRecord(tx, { claim, recordId })),
        ).rejects.toMatchObject({ code: 'mapping-invalid' });
      const command = {
        claim,
        recordId,
        ...(record.entity === 'article' ? { preparedBodyHtml: '<p>Prepared history</p>' } : {}),
      };
      const loaded = await withSystem(app.db, BRAND, (tx) => loadPreparedStagedRecord(tx, command));
      expect(loaded.state).toBe('loaded');
      targets.set(record.payload.externalId, loaded.id);
      expect(
        await withSystem(app.db, BRAND, (tx) => loadPreparedStagedRecord(tx, command)),
      ).toEqual({ state: 'already_done', id: loaded.id });
    }
    const companyId = targets.get('prepared-org');
    const contactId = targets.get('prepared-contact');
    if (!companyId || !contactId) throw new Error('Missing prepared profiles');
    expect(
      (await owner.db.select().from(accounts).where(eq(accounts.id, companyId)))[0]?.custom,
    ).toEqual({ prepared_region: 'North' });
    expect(
      (await owner.db.select().from(contacts).where(eq(contacts.id, contactId)))[0]?.accountId,
    ).toBe(companyId);
    expect(targets.get('prepared-agent')).toBeNull();
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts,
    ).toEqual({
      loaded: {
        field: 1,
        organization: 1,
        contact: 1,
        user: 1,
        category: 1,
        section: 1,
        article: 1,
      },
      knowledgeChanged: true,
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('selects ready metadata parents even when children were staged first and stops only at the metadata boundary', async () => {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
    const records = [
      {
        entity: 'contact',
        payload: {
          externalId: 'ordered-contact',
          name: 'Ordered contact',
          organizationExternalId: 'ordered-org',
          emails: ['ordered@example.invalid'],
          phones: [],
          custom: {},
        },
      },
      {
        entity: 'organization',
        payload: {
          externalId: 'ordered-org',
          name: 'Ordered company',
          domains: [],
          custom: { source_region: 'North' },
        },
      },
      {
        entity: 'field',
        payload: {
          externalId: 'ordered-field',
          target: 'organization',
          key: 'source_region',
          label: 'Region',
          type: 'text',
        },
      },
      {
        entity: 'section',
        payload: {
          externalId: 'ordered-child-section',
          parentExternalId: 'ordered-category',
          parentSectionExternalId: 'ordered-parent-section',
          names: { en: 'Child' },
        },
      },
      {
        entity: 'section',
        payload: {
          externalId: 'ordered-parent-section',
          parentExternalId: 'ordered-category',
          names: { en: 'Parent' },
        },
      },
      {
        entity: 'category',
        payload: {
          externalId: 'ordered-category',
          parentExternalId: 'ordered-root',
          names: { en: 'Nested' },
        },
      },
      { entity: 'category', payload: { externalId: 'ordered-root', names: { en: 'Root' } } },
    ].map((record) => importRecordSchema.parse(record));
    const sourceIds = new Map<string, string>();
    for (const record of records) {
      const id = uuidv7();
      sourceIds.set(id, record.payload.externalId);
      await owner.db.insert(importRecords).values({
        id,
        brandId: BRAND,
        runId,
        entity: record.entity,
        externalId: record.payload.externalId,
        payload: record.payload,
        payloadHash: hashImportValue(record.payload),
      });
    }
    await owner.db.insert(importMappings).values({
      brandId: BRAND,
      runId,
      kind: 'field',
      externalValue: 'ordered-field',
      target: {
        kind: 'create',
        definition: { target: 'account', key: 'ordered_region', label: 'Region', type: 'text' },
      },
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing loading claim');
    const order = [];
    for (let index = 0; index < records.length; index++) {
      const loaded = await withSystem(app.db, BRAND, (tx) => loadNextStagedMetadata(tx, { claim }));
      if (loaded.state !== 'loaded') throw new Error('Metadata finished early');
      order.push(sourceIds.get(loaded.recordId));
    }
    expect(order).toEqual([
      'ordered-field',
      'ordered-org',
      'ordered-contact',
      'ordered-root',
      'ordered-category',
      'ordered-parent-section',
      'ordered-child-section',
    ]);
    expect(await withSystem(app.db, BRAND, (tx) => loadNextStagedMetadata(tx, { claim }))).toEqual({
      state: 'metadata_done',
    });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.status,
    ).toBe('loading');
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('refuses a metadata cycle instead of treating unready records as a finished phase', async () => {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
    for (const [externalId, parentExternalId] of [
      ['cycle-a', 'cycle-b'],
      ['cycle-b', 'cycle-a'],
    ]) {
      const record = importRecordSchema.parse({
        entity: 'category',
        payload: { externalId, parentExternalId, names: { en: externalId } },
      });
      await owner.db.insert(importRecords).values({
        brandId: BRAND,
        runId,
        entity: 'category',
        externalId: record.payload.externalId,
        payload: record.payload,
        payloadHash: hashImportValue(record.payload),
      });
    }
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing loading claim');
    await expect(
      withSystem(app.db, BRAND, (tx) => loadNextStagedMetadata(tx, { claim })),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts,
    ).toEqual({});
  });

  it('refuses a failed staged child before loading or reporting a complete ticket', async () => {
    const scenario = await stagedTicketScenario('failed-child-history');
    await owner.db
      .update(importRecords)
      .set({ status: 'failed', error: 'import.record-unavailable' })
      .where(
        and(eq(importRecords.runId, scenario.input.runId), eq(importRecords.entity, 'message')),
      );
    await expect(
      withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario)),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(
          and(
            eq(importExternalIds.entity, 'ticket'),
            eq(importExternalIds.externalId, scenario.input.record.externalId),
          ),
        ),
    ).toEqual([]);
    expect(
      (
        await owner.db.select().from(importRecords).where(eq(importRecords.id, scenario.recordId))
      )[0]?.status,
    ).toBe('staged');
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('accepts only ready same-brand images and refuses missing knowledge parents without leaving content', async () => {
    const scope = { brandId: BRAND, runId: RUN, source: 'zendesk' as const };
    const mediaId = uuidv7();
    const foreignId = uuidv7();
    await owner.db.insert(hcMedia).values([
      {
        id: mediaId,
        brandId: BRAND,
        s3Key: `hc/${mediaId}`,
        originalName: 'image.png',
        mime: 'image/webp',
        size: 10,
        status: 'ready',
        webpKey: `hc/${mediaId}.webp`,
      },
      {
        id: foreignId,
        brandId: OTHER_BRAND,
        s3Key: `hc/${foreignId}`,
        originalName: 'private.png',
        mime: 'image/webp',
        size: 10,
        status: 'ready',
        webpKey: `hc/${foreignId}.webp`,
      },
    ]);
    const input = articleLoadSchema.parse({
      ...scope,
      record: {
        externalId: 'kb-image',
        sectionExternalId: 'kb-section',
        locale: 'en',
        title: 'Image',
        bodyHtml: '<p>Image</p>',
        draft: false,
        internal: false,
        createdAt: '2019-01-01T00:00:00Z',
        updatedAt: '2019-01-01T00:00:00Z',
      },
      preparedBodyHtml: `<img src="/api/help-center/brands/${BRAND}/media/${mediaId}" alt="original">`,
    });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.article(tx, input));
    const [version] = await owner.db
      .select()
      .from(hcArticleVersions)
      .where(eq(hcArticleVersions.articleId, loaded.id));
    expect(version?.publishedBodyHtml).toContain(mediaId);
    for (const src of [
      'https://vendor.invalid/image.png',
      `/api/help-center/brands/${OTHER_BRAND}/media/${foreignId}`,
      `/api/help-center/brands/${BRAND}/media/${foreignId}`,
    ]) {
      await expect(
        withSystem(app.db, BRAND, (tx) =>
          writer.article(tx, {
            ...input,
            record: { ...input.record, externalId: `invalid-image-${src.length}` },
            preparedBodyHtml: `<img src='${src}'>`,
          }),
        ),
      ).rejects.toMatchObject({ code: 'mapping-invalid' });
    }
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.section(
          tx,
          sectionLoadSchema.parse({
            ...scope,
            record: {
              externalId: 'missing-section',
              parentExternalId: 'missing-parent',
              names: { en: 'Missing' },
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.externalId, 'missing-section')),
    ).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('retains original profile dates, notes, descriptions and native verification provenance without granting verification', async () => {
    const record = {
      externalId: 'source-profile-metadata',
      name: 'Original profile',
      emails: ['profile-metadata@example.invalid'],
      phones: [],
      custom: {},
      createdAt: '2010-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
      notes: 'Original contact note',
      description: 'Original contact description',
      sourceIdentities: [
        {
          externalId: 'email-1',
          type: 'email',
          value: 'profile-metadata@example.invalid',
          verificationMethod: 'full',
        },
        { externalId: 'social-1', type: 'twitter', value: 'original-handle' },
      ],
    };
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record,
    });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input));
    const [profile] = await owner.db.select().from(contacts).where(eq(contacts.id, loaded.id));
    expect(profile).toMatchObject({
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      importedDetails: {
        notes: record.notes,
        description: record.description,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        sourceIdentities: record.sourceIdentities,
      },
    });
    expect(
      await owner.db
        .select()
        .from(contactIdentities)
        .where(eq(contactIdentities.contactId, loaded.id)),
    ).toMatchObject([{ verified: false, source: 'import' }]);
    const organization = organizationLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      custom: {},
      record: {
        externalId: 'source-company-metadata',
        name: 'Original company',
        domains: [],
        custom: {},
        description: 'Native company description',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
    const company = await withSystem(app.db, BRAND, (tx) => writer.organization(tx, organization));
    expect(await owner.db.select().from(accounts).where(eq(accounts.id, company.id))).toMatchObject(
      [
        {
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
          importedDetails: { description: 'Native company description' },
        },
      ],
    );
  });

  it('loads companies with all domains/notes, links through a secondary domain and writes nothing on repeat', async () => {
    const input = organizationLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      custom: { region: 'MENA' },
      record: {
        externalId: 'company-1',
        name: 'Original company',
        domains: ['EXAMPLE.COM', 'other.example'],
        notes: 'Original company note',
        custom: {},
      },
    });
    const first = await withSystem(app.db, BRAND, (tx) => writer.organization(tx, input));
    const [company] = await owner.db.select().from(accounts).where(eq(accounts.id, first.id));
    expect(company).toMatchObject({
      domain: 'example.com',
      custom: { region: 'MENA' },
      importedDetails: {
        domains: ['example.com', 'other.example'],
        notes: 'Original company note',
      },
    });
    const before = await owner.db.execute(
      sql`SELECT xmin::text AS revision FROM accounts WHERE id = ${first.id}`,
    );
    expect(await withSystem(app.db, BRAND, (tx) => writer.organization(tx, input))).toEqual({
      id: first.id,
      outcome: 'unchanged',
    });
    expect([
      ...(await owner.db.execute(
        sql`SELECT xmin::text AS revision FROM accounts WHERE id = ${first.id}`,
      )),
    ]).toEqual([...before]);
    input.record = {
      ...input.record,
      externalId: 'company-2',
      name: 'Other vendor label',
      domains: ['other.example'],
    };
    expect(await withSystem(app.db, BRAND, (tx) => writer.organization(tx, input))).toEqual({
      id: first.id,
      outcome: 'linked',
    });
    expect((await owner.db.select().from(accounts).where(eq(accounts.id, first.id)))[0]?.name).toBe(
      'Original company',
    );
  });

  it('creates unverified imported identifiers and retains unsupported profile values with safe warnings', async () => {
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: { tier: 'gold' },
      record: {
        externalId: 'profile-1',
        name: 'Source person',
        emails: ['PROFILE@example.com'],
        phones: ['+963931234567', 'local-only'],
        locale: 'fr',
        timezone: 'Invalid/Zone',
        custom: {},
      },
    });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input));
    const [profile] = await owner.db.select().from(contacts).where(eq(contacts.id, loaded.id));
    expect(profile).toMatchObject({
      name: 'Source person',
      locale: null,
      timezone: null,
      custom: { tier: 'gold' },
      importedDetails: {
        phones: ['+963931234567', 'local-only'],
        locale: 'fr',
        timezone: 'Invalid/Zone',
      },
    });
    const identifiers = await owner.db
      .select()
      .from(contactIdentities)
      .where(eq(contactIdentities.contactId, loaded.id));
    expect(
      identifiers.map((identity) => [
        identity.kind,
        identity.value,
        identity.verified,
        identity.source,
      ]),
    ).toEqual([
      ['email', 'profile@example.com', false, 'import'],
      ['phone', '+963931234567', false, 'import'],
    ]);
    const warnings = await owner.db
      .select()
      .from(importLog)
      .where(eq(importLog.externalId, 'profile-1'));
    expect(warnings).toHaveLength(3);
    expect(JSON.stringify(warnings)).not.toMatch(/PROFILE@example|local-only|Invalid\/Zone/);
    expect(await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input))).toEqual({
      id: loaded.id,
      outcome: 'unchanged',
    });
    expect(
      await owner.db.select().from(importLog).where(eq(importLog.externalId, 'profile-1')),
    ).toHaveLength(3);
  });

  it('links a known identity without renaming the local person or downgrading verification', async () => {
    await owner.db.insert(contactIdentities).values({
      brandId: BRAND,
      contactId: CONTACT,
      kind: 'email',
      value: 'local@example.com',
      verified: true,
      source: 'agent',
    });
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'profile-local',
        name: 'Vendor name',
        emails: ['LOCAL@example.com'],
        phones: [],
        custom: {},
      },
    });
    expect(await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input))).toEqual({
      id: CONTACT,
      outcome: 'linked',
    });
    expect((await owner.db.select().from(contacts).where(eq(contacts.id, CONTACT)))[0]?.name).toBe(
      'Original customer',
    );
    expect(
      (
        await owner.db
          .select()
          .from(contactIdentities)
          .where(eq(contactIdentities.contactId, CONTACT))
      )[0]?.verified,
    ).toBe(true);
  });

  it('refuses conflicting identities instead of merging contacts', async () => {
    const second = uuidv7();
    await owner.db.insert(contacts).values({ id: second, brandId: BRAND, name: 'Second' });
    await owner.db.insert(contactIdentities).values({
      brandId: BRAND,
      contactId: second,
      kind: 'email',
      value: 'second@example.com',
      verified: false,
      source: 'agent',
    });
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'profile-conflict',
        name: 'Ambiguous',
        emails: ['local@example.com', 'second@example.com'],
        phones: [],
        custom: {},
      },
    });
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.contact(tx, input)),
    ).rejects.toMatchObject({ code: 'identity-ambiguous' });
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.externalId, 'profile-conflict')),
    ).toHaveLength(0);
  });

  it('clears retained import profile data on erasure and refuses to resurrect the contact on another run', async () => {
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'profile-erased',
        name: 'Erase me',
        emails: ['erased-source@example.com'],
        phones: ['local number'],
        custom: {},
      },
    });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input));
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: RUN,
      entity: 'contact',
      externalId: 'profile-erased',
      payload: input.record,
      payloadHash: hashImportValue(input.record),
    });
    await withSystem(app.db, BRAND, (tx) =>
      new ContactsRepository().anonymise(tx, loaded.id, { name: 'Erased contact', identities: [] }),
    );
    expect(
      (await owner.db.select().from(contacts).where(eq(contacts.id, loaded.id)))[0]
        ?.importedDetails,
    ).toBeNull();
    expect(
      await owner.db
        .select()
        .from(importRecords)
        .where(eq(importRecords.externalId, 'profile-erased')),
    ).toHaveLength(0);
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.contact(tx, input)),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
  });

  it('follows a manual contact merge without rewriting the stable source identity', async () => {
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'profile-merged',
        name: 'Source identity',
        emails: ['merged-source@example.com'],
        phones: [],
        custom: {},
      },
    });
    const original = await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input));
    const survivor = uuidv7();
    await owner.db
      .insert(contacts)
      .values({ id: survivor, brandId: BRAND, name: 'Manual survivor' });
    await withSystem(app.db, BRAND, async (tx) => {
      const merges = new ContactMergesRepository();
      await merges.moveIdentities(tx, { from: original.id, to: survivor });
      await merges.markMerged(tx, original.id, survivor);
    });
    expect(await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input))).toEqual({
      id: survivor,
      outcome: 'unchanged',
    });
    expect(
      (
        await owner.db
          .select()
          .from(importExternalIds)
          .where(eq(importExternalIds.externalId, 'profile-merged'))
      )[0]?.helpdockId,
    ).toBe(original.id);
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: RUN,
      entity: 'contact',
      externalId: input.record.externalId,
      payload: input.record,
      payloadHash: hashImportValue(input.record),
    });
    await withSystem(app.db, BRAND, (tx) =>
      new ContactsRepository().anonymise(tx, survivor, { name: 'Erased contact', identities: [] }),
    );
    expect(
      (await owner.db.select().from(contacts).where(eq(contacts.id, original.id)))[0]
        ?.importedDetails,
    ).toBeNull();
    expect(
      await owner.db
        .select()
        .from(importRecords)
        .where(eq(importRecords.externalId, input.record.externalId)),
    ).toHaveLength(0);
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.contact(tx, input)),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
  });

  it('retains historical assignees mapped to invited staff without activating them or sending mail', async () => {
    const invited = uuidv7();
    await owner.db.insert(users).values({
      id: invited,
      email: 'invited-history@example.com',
      name: 'Invited agent',
      status: 'invited',
    });
    await owner.db
      .insert(userBrandRoles)
      .values({ userId: invited, brandId: BRAND, role: 'agent', departmentIds: [DEPARTMENT] });
    const input = request('invited-assignee');
    input.resolved.assigneeId = invited;
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      (await owner.db.select().from(tickets).where(eq(tickets.id, loaded.ticketId)))[0]?.assigneeId,
    ).toBe(invited);
    expect((await owner.db.select().from(users).where(eq(users.id, invited)))[0]?.status).toBe(
      'invited',
    );
    expect(await owner.db.select().from(outbox)).toHaveLength(0);
  });

  it('keeps authors, note visibility and original dates while sanitizing remote content', async () => {
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, request()));
    expect(loaded).toMatchObject({ outcome: 'created', messages: 2 });
    const [ticket] = await owner.db.select().from(tickets).where(eq(tickets.id, loaded.ticketId));
    expect(ticket).toMatchObject({
      createdAt: new Date('2019-01-01T00:00:00Z'),
      updatedAt: new Date('2019-01-03T00:00:00Z'),
      importSource: 'zendesk',
      slaPolicyId: null,
    });
    expect(ticket?.number).toBeGreaterThan(0);
    expect(ticket?.number).not.toBe(900);
    const thread = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, loaded.ticketId))
      .orderBy(ticketMessages.seq);
    expect(
      thread.map((message) => [
        message.seq,
        message.kind,
        message.authorType,
        message.authorDisplay,
      ]),
    ).toEqual([
      [1, 'public', 'contact', null],
      [2, 'note', 'system', 'Original agent'],
    ]);
    expect(thread[0]?.bodyHtml).not.toMatch(/script|tracker/);
    expect(await owner.db.select().from(outbox)).toHaveLength(0);
    for (const table of [
      'workflow_runs',
      'ticket_sla_clocks',
      'notifications',
      'ai_calls',
      'webhook_deliveries',
    ]) {
      const rows = await owner.db.execute(
        sql`SELECT count(*)::int AS total FROM ${sql.identifier(table)}`,
      );
      expect(rows[0]?.total, table).toBe(0);
    }
    expect(await redis.dbsize()).toBe(0);
  });

  it('writes nothing on a repeat and appends delta replies without rewriting historical messages', async () => {
    const payload = request('delta');
    const first = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload));
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${first.ticketId}`,
    );
    const repeated = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload));
    expect(repeated).toMatchObject({ outcome: 'unchanged', messages: 0 });
    payload.messages.push({
      externalId: 'new-reply',
      ticketExternalId: 'delta',
      authorExternalId: 'staff',
      authorKind: 'agent',
      public: true,
      bodyText: 'New reply',
      createdAt: '2019-01-03T00:00:00Z',
      attachments: [],
    });
    const delta = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload));
    expect(delta).toMatchObject({ ticketId: first.ticketId, outcome: 'updated', messages: 1 });
    const after = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${first.ticketId} AND seq <= 2`,
    );
    expect([...after]).toEqual([...before]);
  });

  it('keeps one asset identity when the same file appears in two historical messages', async () => {
    const payload = request('attachments');
    for (const message of payload.messages)
      message.attachments.push({
        externalId: 'shared-file',
        fileName: '../../screenshot.png',
        contentType: 'image/png',
        url: 'https://files.example.com/file?expires=first',
      });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload));
    const files = await owner.db
      .select()
      .from(attachments)
      .where(eq(attachments.ticketId, loaded.ticketId));
    expect(files).toHaveLength(2);
    expect(new Set(files.map((file) => file.s3Key)).size).toBe(1);
    expect(files.every((file) => file.s3Key.endsWith('/original'))).toBe(true);
    expect(files.filter((file) => file.copiedFromAttachmentId !== null)).toHaveLength(1);
    expect(files.every((file) => file.originalName === 'screenshot.png')).toBe(true);
    const ledger = await owner.db
      .select()
      .from(importExternalIds)
      .where(eq(importExternalIds.externalId, 'shared-file'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.helpdockId).toBe(
      files.find((file) => file.copiedFromAttachmentId === null)?.id,
    );
    for (const message of payload.messages)
      for (const file of message.attachments)
        file.url = 'https://files.example.com/file?expires=second';
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload))).toMatchObject({
      outcome: 'unchanged',
      messages: 0,
    });
  });

  it('reconciles shared historical attachment links atomically and preserves ordinary uploads', async () => {
    const input = request('reconciled-shared-files');
    const ref = {
      externalId: 'reconciled-shared-file',
      url: 'https://vendor.invalid/shared-file',
      fileName: 'history.pdf',
      contentType: 'application/pdf',
      size: 10,
    };
    for (const message of input.messages) message.attachments = [{ ...ref }];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const files = await owner.db
      .select()
      .from(attachments)
      .where(eq(attachments.ticketId, loaded.ticketId));
    const original = files.find((file) => file.copiedFromAttachmentId === null);
    if (!original?.messageId) throw new Error('Missing source attachment');
    const manualId = uuidv7();
    await owner.db.insert(attachments).values({
      id: manualId,
      brandId: BRAND,
      ticketId: loaded.ticketId,
      departmentId: DEPARTMENT,
      messageId: original.messageId,
      uploaderType: 'staff',
      uploaderId: USER,
      s3Key: `brands/${BRAND}/manual/${manualId}/original`,
      originalName: 'manual.pdf',
      mime: 'application/pdf',
      size: 10,
      kind: 'file',
      status: 'ready',
    });
    const source = input.messages.find((message) => message.createdAt === '2019-01-01T00:00:00Z');
    if (!source) throw new Error('Missing original source message');
    source.attachments = [];
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(
      await owner.db.select().from(attachments).where(eq(attachments.id, original.id)),
    ).toEqual([]);
    source.attachments = [{ ...ref }];
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const restored = await owner.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.ticketId, loaded.ticketId), eq(attachments.origin, 'import')));
    expect(restored).toHaveLength(2);
    expect(restored.every((file) => file.s3Key === original.s3Key)).toBe(true);
    for (const message of input.messages) message.attachments = [];
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await writer.ticket(tx, input);
        throw new Error('reconciliation interrupted');
      }),
    ).rejects.toThrow('reconciliation interrupted');
    expect(
      await owner.db
        .select()
        .from(attachments)
        .where(and(eq(attachments.ticketId, loaded.ticketId), eq(attachments.origin, 'import'))),
    ).toHaveLength(2);
    expect(await owner.db.select().from(outbox)).toEqual([]);
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      await owner.db.select().from(attachments).where(eq(attachments.ticketId, loaded.ticketId)),
    ).toMatchObject([{ id: manualId, origin: 'upload' }]);
    const cleanup = await owner.db.select().from(outbox);
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({
      event: 'media.objects.purge',
      brandId: BRAND,
      payload: { keys: expect.arrayContaining([original.s3Key]) },
    });
    const cleanupId = cleanup[0]?.id;
    if (!cleanupId) throw new Error('Missing durable cleanup');
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'unchanged',
      messages: 0,
    });
    expect(await owner.db.select().from(outbox)).toHaveLength(1);
    await owner.db.delete(outbox).where(eq(outbox.id, cleanupId));
    expect(await redis.dbsize()).toBe(0);
  });

  it('allocates a fresh pending object for changed source file metadata without overwriting another historical link', async () => {
    const input = request('changed-source-file');
    const ref = {
      externalId: 'changed-file-metadata',
      fileName: 'old.pdf',
      size: 10,
      contentType: 'application/pdf',
      url: 'https://vendor.invalid/changed-file',
    };
    for (const message of input.messages) message.attachments = [{ ...ref }];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const originalFiles = await owner.db
      .select()
      .from(attachments)
      .where(eq(attachments.ticketId, loaded.ticketId));
    const original = originalFiles.find((file) => file.copiedFromAttachmentId === null);
    if (!original) throw new Error('Missing source object');
    await owner.db
      .update(attachments)
      .set({ status: 'ready', processedAt: new Date() })
      .where(eq(attachments.id, original.id));
    const source = input.messages[0];
    if (!source) throw new Error('Missing source note');
    source.attachments = [{ ...ref, fileName: 'corrected.pdf', size: 20 }];
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const files = await owner.db
      .select()
      .from(attachments)
      .where(eq(attachments.ticketId, loaded.ticketId));
    expect(files).toHaveLength(2);
    expect(files.find((file) => file.originalName === 'corrected.pdf')).toMatchObject({
      status: 'pending',
      size: 20,
      copiedFromAttachmentId: null,
      processedAt: null,
    });
    expect(files.find((file) => file.originalName === 'corrected.pdf')?.s3Key).not.toBe(
      original.s3Key,
    );
    expect(files.find((file) => file.id === original.id)).toMatchObject({
      status: 'ready',
      size: 10,
    });
    const revisions = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM attachments WHERE ticket_id = ${loaded.ticketId}`,
    );
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'unchanged',
      messages: 0,
    });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM attachments WHERE ticket_id = ${loaded.ticketId}`,
      ),
    ).toEqual(revisions);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  function downloadHarness(fake: FakeZendesk, storage: FakeStorage) {
    return {
      db: app.db,
      storage,
      jobId: 'import.download.fixture',
      connector: new ZendeskConnector({ apiRoot: fake.server.root }),
      context: {
        credentials: { auth: 'oauth' as const, subdomain: 'demo', accessToken: 'synthetic-token' },
        signal: new AbortController().signal,
        log: async () => {},
        http: new ImportHttp({
          hosts: ['127.0.0.1', 'cdn.zendesk.test'],
          limiter: new ImportRateLimiter({ capacity: 100, perMinute: 1000 }),
          policy: {
            allowedPorts: [Number(new URL(fake.server.root).port)],
            allowCidrs: ['127.0.0.1/32'],
            lookup: async () => [{ address: '127.0.0.1', family: 4 }],
          },
        }),
      },
    };
  }

  it.each(['pdf', 'image'] as const)(
    'downloads a staged Zendesk $0 through safe HTTP, stores it and queues silent processing once',
    async (format) => {
      const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
      await fake.server.start();
      const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-download-'));
      const storage = new FakeStorage(dir);
      const bytes =
        format === 'pdf'
          ? Buffer.from('%PDF-1.7\nHistorical attachment')
          : await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } })
              .png()
              .toBuffer();
      const mime = format === 'pdf' ? 'application/pdf' : 'image/png';
      try {
        const url = fake.addAttachment('source-file', bytes);
        const scenario = await stagedTicketScenario(
          `downloaded-source-attachment-${format}`,
          url,
          mime,
        );
        await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
        const [record] = await owner.db
          .select()
          .from(importRecords)
          .where(
            and(
              eq(importRecords.runId, scenario.input.runId),
              eq(importRecords.entity, 'attachment'),
            ),
          );
        if (!record) throw new Error('Missing staged attachment');
        const deps = downloadHarness(fake, storage);
        const request = { claim: scenario.claim, recordId: record.id };
        expect(await runImportAttachmentBatch(deps, { claim: scenario.claim })).toEqual({
          state: 'awaiting_media',
          processed: 1,
        });
        const downloaded = await downloadStagedImportAttachment(deps, request);
        expect(downloaded.state).toBe('processing');
        const [row] = await owner.db
          .select()
          .from(attachments)
          .where(eq(attachments.id, downloaded.attachmentId));
        if (!row) throw new Error('Missing downloaded attachment');
        expect(row).toMatchObject({
          origin: 'import',
          status: 'processing',
          size: bytes.length,
          mime,
          kind: format === 'pdf' ? 'file' : 'image',
        });
        expect(await storage.read(row.s3Key)).toEqual(bytes);
        const calls = fake.server.calls.length;
        expect(await runImportAttachmentBatch(deps, { claim: scenario.claim })).toEqual({
          state: 'awaiting_media',
          processed: 0,
        });
        expect(await downloadStagedImportAttachment(deps, request)).toEqual({
          state: 'processing',
          attachmentId: row.id,
        });
        expect(fake.server.calls).toHaveLength(calls);
        expect(
          fake.server.calls
            .filter((call) => call.path.startsWith('/cdn/'))
            .every((call) => !call.authenticated),
        ).toBe(true);
        const events = await owner.db.select().from(outbox);
        expect(events.filter((event) => event.event === 'attachment.uploaded')).toHaveLength(1);
        expect(
          events.every((event) =>
            ['attachment.uploaded', 'media.objects.purge'].includes(event.event),
          ),
        ).toBe(true);
        const processor = createMediaProcessor({
          storage,
          tools: fakeTools(),
          scanner: undefined,
        });
        await withSystem(app.db, BRAND, (tx) =>
          processor.run({
            payload: { brandId: BRAND, attachmentId: row.id },
            tx,
            log: silentJobLogger,
          }),
        );
        expect(
          (await owner.db.select().from(attachments).where(eq(attachments.id, row.id)))[0]?.status,
        ).toBe('ready');
        if (format === 'image') {
          expect(
            (await sharp(await storage.read(objectKeyBeside(row.s3Key, 'webp'))).metadata()).format,
          ).toBe('webp');
          expect(await storage.head(row.s3Key)).toBeUndefined();
        }
        expect(await runImportAttachmentBatch(deps, { claim: scenario.claim })).toEqual({
          state: 'finishing',
          processed: 0,
          claim: { ...scenario.claim, phase: 'finishing' },
        });
        expect(await runImportAttachmentBatch(deps, { claim: scenario.claim })).toEqual({
          state: 'stopped',
          processed: 0,
        });
        expect(await owner.db.select().from(outbox)).toHaveLength(events.length);
        for (const event of events) await owner.db.delete(outbox).where(eq(outbox.id, event.id));
        expect(await redis.dbsize()).toBe(0);
      } finally {
        await fake.server.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('fences a download paused during storage upload and resumes on a separate object key', async () => {
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-fenced-download-'));
    const bytes = Buffer.from('%PDF-1.7\nClaim fenced history');
    let releaseStaleUpload = () => {};
    let staleCheck: Promise<unknown> | undefined;
    try {
      const url = fake.addAttachment('fenced-file', bytes);
      const scenario = await stagedTicketScenario('fenced-source-download', url);
      await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
      const [record] = await owner.db
        .select()
        .from(importRecords)
        .where(
          and(
            eq(importRecords.runId, scenario.input.runId),
            eq(importRecords.entity, 'attachment'),
          ),
        );
      if (!record) throw new Error('Missing staged attachment');
      class PausingStorage extends FakeStorage {
        pauseNext = true;
        signalPaused: () => void = () => {};
        releaseUpload: () => void = () => {};
        readonly paused = new Promise<void>((resolve) => {
          this.signalPaused = resolve;
        });
        readonly released = new Promise<void>((resolve) => {
          this.releaseUpload = resolve;
        });
        override async upload(options: Parameters<FakeStorage['upload']>[0]) {
          if (this.pauseNext) {
            this.pauseNext = false;
            await withSystem(app.db, BRAND, (tx) =>
              pauseImportRun(tx, {
                brandId: BRAND,
                runId: scenario.input.runId,
              }),
            );
            this.signalPaused();
            await this.released;
          }
          await super.upload(options);
        }
      }
      const storage = new PausingStorage(dir);
      releaseStaleUpload = storage.releaseUpload;
      const deps = downloadHarness(fake, storage);
      const stale = expect(
        downloadStagedImportAttachment(deps, {
          claim: scenario.claim,
          recordId: record.id,
        }),
      ).rejects.toMatchObject({ name: 'ImportClaimLost' });
      staleCheck = stale;
      await storage.paused;
      const [pending] = await owner.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, record.helpdockId ?? ''));
      if (!pending) throw new Error('Missing fenced attachment');
      expect(pending.status).toBe('pending');
      expect(
        (await owner.db.select().from(outbox)).every(
          (event) => event.event === 'media.objects.purge',
        ),
      ).toBe(true);
      await withSystem(app.db, BRAND, (tx) =>
        resumeImportRun(tx, { brandId: BRAND, runId: scenario.input.runId }),
      );
      const claim = await withSystem(app.db, BRAND, (tx) =>
        claimImportRun(tx, {
          brandId: BRAND,
          runId: scenario.input.runId,
          phase: 'loading',
        }),
      );
      if (!claim) throw new Error('Missing resumed claim');
      expect(
        await downloadStagedImportAttachment(deps, { claim, recordId: record.id }),
      ).toMatchObject({ state: 'downloaded', attachmentId: pending.id });
      const [processed] = await owner.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, pending.id));
      if (!processed) throw new Error('Missing resumed attachment');
      expect(processed.status).toBe('processing');
      expect(processed.s3Key).not.toBe(pending.s3Key);
      expect(await storage.read(processed.s3Key)).toEqual(bytes);
      const beforeLateUpload = await owner.db.select().from(outbox);
      expect(
        beforeLateUpload.filter((event) => event.event === 'attachment.uploaded'),
      ).toHaveLength(1);
      for (const event of beforeLateUpload.filter(
        (event) => event.event === 'media.objects.purge',
      )) {
        await withSystem(app.db, BRAND, (tx) =>
          createObjectPurgeHandler(storage)({
            brandId: BRAND,
            outboxId: event.id,
            event: event.event,
            payload: event.payload,
            tx,
            log: silentJobLogger,
          }),
        );
        await owner.db.delete(outbox).where(eq(outbox.id, event.id));
      }
      expect(await storage.head(pending.s3Key)).toBeUndefined();
      storage.releaseUpload();
      await stale;
      const events = await owner.db.select().from(outbox);
      expect(events.filter((event) => event.event === 'attachment.uploaded')).toHaveLength(1);
      expect(
        events
          .filter((event) => event.event === 'media.objects.purge')
          .flatMap((event) => event.payload.keys),
      ).toContain(pending.s3Key);
      for (const event of events) {
        if (event.event === 'media.objects.purge')
          await withSystem(app.db, BRAND, (tx) =>
            createObjectPurgeHandler(storage)({
              brandId: BRAND,
              outboxId: event.id,
              event: event.event,
              payload: event.payload,
              tx,
              log: silentJobLogger,
            }),
          );
        await owner.db.delete(outbox).where(eq(outbox.id, event.id));
      }
      expect(await storage.head(pending.s3Key)).toBeUndefined();
      expect(await storage.read(processed.s3Key)).toEqual(bytes);
      expect(await redis.dbsize()).toBe(0);
    } finally {
      releaseStaleUpload();
      await staleCheck?.catch(() => {});
      await fake.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['present', 'purged during fetch'] as const)(
    'refuses unsafe vendor bytes with a $0 target without reporting a missing placeholder',
    async (mode) => {
      const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
      await fake.server.start();
      const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-refused-download-'));
      try {
        const url = fake.addAttachment(
          'invalid-pdf',
          Buffer.from('<html>expired login page</html>'),
        );
        const scenario = await stagedTicketScenario(`refused-source-file-${mode}`, url);
        await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
        const [record] = await owner.db
          .select()
          .from(importRecords)
          .where(
            and(
              eq(importRecords.runId, scenario.input.runId),
              eq(importRecords.entity, 'attachment'),
            ),
          );
        if (!record) throw new Error('Missing staged attachment');
        const storage = new FakeStorage(dir);
        const deps = downloadHarness(fake, storage);
        if (mode === 'purged during fetch') {
          const fetchAttachment = deps.connector.fetchAttachment.bind(deps.connector);
          deps.connector.fetchAttachment = async (context, ref) => {
            const downloaded = await fetchAttachment(context, ref);
            if (!record.helpdockId) throw new Error('Missing loaded attachment pointer');
            await owner.db.delete(attachments).where(eq(attachments.id, record.helpdockId));
            return downloaded;
          };
          await expect(
            downloadStagedImportAttachment(deps, { claim: scenario.claim, recordId: record.id }),
          ).rejects.toMatchObject({ code: 'target-unavailable' });
          expect(
            await owner.db
              .select()
              .from(importLog)
              .where(eq(importLog.runId, scenario.input.runId)),
          ).toEqual([]);
        } else {
          const result = await downloadStagedImportAttachment(deps, {
            claim: scenario.claim,
            recordId: record.id,
          });
          expect(result.state).toBe('rejected');
          const [row] = await owner.db
            .select()
            .from(attachments)
            .where(eq(attachments.id, result.attachmentId));
          if (!row) throw new Error('Missing refused attachment');
          expect(row).toMatchObject({ status: 'rejected', rejectReason: 'mime_mismatch' });
          expect(await storage.head(row.s3Key)).toBeUndefined();
          const warnings = await owner.db
            .select()
            .from(importLog)
            .where(eq(importLog.runId, scenario.input.runId));
          expect(warnings).toMatchObject([
            { message: 'import.attachment.rejected', level: 'warning' },
          ]);
          expect(JSON.stringify(warnings)).not.toContain('synthetic-token');
          expect(JSON.stringify(warnings)).not.toContain(url);
        }
        const events = await owner.db.select().from(outbox);
        expect(events.every((event) => event.event === 'media.objects.purge')).toBe(true);
        for (const event of events) await owner.db.delete(outbox).where(eq(outbox.id, event.id));
        expect(await redis.dbsize()).toBe(0);
      } finally {
        await fake.server.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('processes a shared imported image once, updates all historical copies and emits nothing', async () => {
    const input = request('processed-import-asset');
    for (const message of input.messages)
      message.attachments.push({
        externalId: 'processed-shared-image',
        fileName: 'screenshot.png',
        contentType: 'image/png',
        url: 'https://vendor.example/image',
      });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const files = await owner.db
      .select()
      .from(attachments)
      .where(eq(attachments.ticketId, loaded.ticketId));
    const original = files.find((file) => file.copiedFromAttachmentId === null);
    if (!original) throw new Error('Missing source attachment');
    const bytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    await owner.db
      .update(attachments)
      .set({ status: 'processing', kind: 'image', size: bytes.length })
      .where(eq(attachments.id, original.id));
    const liveId = uuidv7();
    await owner.db.insert(attachments).values({
      ...original,
      id: liveId,
      copiedFromAttachmentId: original.id,
      origin: 'upload',
      status: 'pending',
    });
    const directory = await mkdtemp(path.join(tmpdir(), 'helpdock-import-media-'));
    try {
      const storage = new FakeStorage(directory);
      await storage.put(original.s3Key, bytes);
      const repository = new MediaRepository();
      await withSystem(app.db, OTHER_BRAND, (tx) =>
        repository.setImportedAssetStatus(tx, original, { status: 'ready' }),
      );
      expect(
        (await owner.db.select().from(attachments).where(eq(attachments.id, original.id)))[0]
          ?.status,
      ).toBe('processing');
      const processor = createMediaProcessor({ storage, tools: fakeTools(), scanner: undefined });
      expect(
        await withSystem(app.db, BRAND, (tx) =>
          processor.run({
            tx,
            payload: { brandId: BRAND, attachmentId: original.id },
            log: silentJobLogger,
          }),
        ),
      ).toEqual({ status: 'ready' });
      const processed = await owner.db
        .select()
        .from(attachments)
        .where(eq(attachments.ticketId, loaded.ticketId));
      const imported = processed.filter((file) => file.origin === 'import');
      expect(imported).toHaveLength(2);
      for (const file of imported) {
        expect(file).toMatchObject({
          status: 'ready',
          kind: 'image',
          mime: 'image/png',
          size: bytes.length,
          scanStatus: 'skipped',
        });
        expect(file.variants).toHaveProperty('webp');
        expect(
          (await sharp(await storage.read(objectKeyBeside(file.s3Key, 'webp'))).metadata()).format,
        ).toBe('webp');
        expect(file.createdAt).toEqual(files.find((prior) => prior.id === file.id)?.createdAt);
      }
      expect(imported[0]?.processedAt).toEqual(imported[1]?.processedAt);
      expect(processed.find((file) => file.id === liveId)?.status).toBe('pending');
      expect(await owner.db.select().from(outbox)).toEqual([]);
      expect(await redis.keys('*')).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses transcription of historical audio even through a stale live event or queued job', async () => {
    const input = request('import-transcription-refused');
    input.messages[0]?.attachments.push({
      externalId: 'historical-audio',
      fileName: 'voice.ogg',
      contentType: 'audio/ogg',
      url: 'https://vendor.example/voice',
    });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const [audio] = await owner.db
      .select()
      .from(attachments)
      .where(eq(attachments.ticketId, loaded.ticketId));
    if (!audio) throw new Error('Missing audio attachment');
    await owner.db
      .update(attachments)
      .set({ status: 'ready', kind: 'audio' })
      .where(eq(attachments.id, audio.id));
    const config = async () => ({
      endpoint: 'https://whisper.test/v1/audio/transcriptions',
      model: 'whisper-1',
      apiKey: 'fixture-only',
    });
    let queued = 0;
    const handler = createTranscriptionHandler(
      {
        add: async () => {
          queued++;
        },
      },
      config,
    );
    await withSystem(app.db, BRAND, (tx) =>
      handler({
        brandId: BRAND,
        tx,
        event: 'attachment.ready',
        outboxId: uuidv7(),
        log: silentJobLogger,
        payload: {
          attachmentId: audio.id,
          ticketId: loaded.ticketId,
          departmentId: DEPARTMENT,
          status: 'ready',
        },
      }),
    );
    expect(queued).toBe(0);
    expect(
      (await owner.db.select().from(attachments).where(eq(attachments.id, audio.id)))[0]
        ?.transcriptStatus,
    ).toBeNull();
    let downloaded = 0;
    let calledAi = 0;
    expect(
      await runTranscription(
        {
          db: app.db,
          config,
          log: silentJobLogger,
          storage: {
            download: async () => {
              downloaded++;
            },
          },
          ai: {
            transcribe: async () => {
              calledAi++;
              throw new Error('Historical audio must not reach AI');
            },
          },
        },
        { brandId: BRAND, attachmentId: audio.id },
        { jobId: 'stale-import-fixture', lastAttempt: true },
      ),
    ).toBe('skipped');
    expect(downloaded).toBe(0);
    expect(calledAi).toBe(0);
  });

  it('refuses a system message mapped to an old agent name rather than fabricating a reportable reply', async () => {
    const input = request('system-name-mismatch');
    const note = input.messages.find((message) => message.authorExternalId === 'oldagent');
    if (!note) throw new Error('Missing old-agent fixture');
    note.authorKind = 'system';
    note.public = true;
    await expect(withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).rejects.toMatchObject(
      { code: 'mapping-invalid' },
    );
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.externalId, input.record.externalId)),
    ).toEqual([]);
  });

  it('rolls back a ticket and its prior messages when a later author is unmapped', async () => {
    const payload = request('rollback');
    delete payload.authors.oldagent;
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload)),
    ).rejects.toMatchObject({ code: 'author-unmapped' });
    const rows = await owner.db
      .select()
      .from(importExternalIds)
      .where(
        and(
          eq(importExternalIds.brandId, payload.brandId),
          eq(importExternalIds.source, payload.source),
          inArray(importExternalIds.externalId, [
            payload.record.externalId,
            ...payload.messages.map((message) => message.externalId),
          ]),
        ),
      );
    expect(rows).toEqual([]);
  });

  it('refuses a department from another brand before writing any history', async () => {
    const payload = request('isolation');
    payload.resolved.departmentId = OTHER_DEPARTMENT;
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload)),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
  });
});
