import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  hcSections,
  importExternalIds,
  importLog,
  importMappings,
  importRecords,
  importRuns,
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
import { importEntitySchema, importRecordSchema, ticketCcSchema } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContactMergesRepository } from '../../contacts/contact-merges.repository.js';
import { ContactsRepository } from '../../contacts/contacts.repository.js';
import { CsatRepository } from '../../csat/csat.repository.js';
import { objectKeyBeside } from '../../media/keys.js';
import { MediaRepository } from '../../media/media.repository.js';
import { createMediaProcessor } from '../../media/process.job.js';
import { RollupRepository } from '../../reports/rollup.repository.js';
import { FakeStorage, fakeTools, silentJobLogger } from '../../testing/media.js';
import { hasDocker, startPostgres, startRedis } from '../../testing/meta-install.js';
import { runTranscription } from '../../transcription/transcribe.job.js';
import { createTranscriptionHandler } from '../../transcription/transcription-events.js';
import { claimImportRun, IMPORT_CLAIM_TIMEOUT_MS, renewImportClaim } from '../jobs/claims.js';
import { storeImportPage } from '../jobs/extract-page.js';
import { runImportExtraction } from '../jobs/extract-run.js';
import { loadAssembledStagedTicket } from '../jobs/load-assembled-ticket.js';
import { loadMappedStagedTicket } from '../jobs/load-mapped-ticket.js';
import { loadPreparedStagedRecord } from '../jobs/load-prepared-record.js';
import { loadStagedRecord } from '../jobs/load-record-checkpoint.js';
import { loadStagedTicket } from '../jobs/load-ticket-checkpoint.js';
import { cancelImportRun, pauseImportRun, resumeImportRun } from '../jobs/run-control.js';
import { saveImportMappings } from '../jobs/save-mappings.js';
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

  async function stagedTicketScenario(externalId: string) {
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
      contentType: 'application/pdf',
      url: 'https://vendor.example/history.pdf',
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

  it('assembles staged history and confirmed authors without caller-supplied thread data', async () => {
    const scenario = await stagedTicketScenario('assembled-history');
    const user = { externalId: 'oldagent', kind: 'agent', name: 'Original agent', active: false };
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: scenario.input.runId,
      entity: 'user',
      externalId: 'oldagent',
      payload: user,
      payloadHash: hashImportValue(user),
    });
    await owner.db.insert(importExternalIds).values({
      brandId: BRAND,
      source: 'zendesk',
      entity: 'contact',
      externalId: 'customer',
      helpdockId: CONTACT,
      payloadHash: 'a'.repeat(64),
    });
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
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
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
    const rows = await owner.db.execute(
      sql`SELECT count(*)::int AS total FROM import_external_ids WHERE external_id LIKE '%rollback%'`,
    );
    expect(rows[0]?.total).toBe(0);
  });

  it('refuses a department from another brand before writing any history', async () => {
    const payload = request('isolation');
    payload.resolved.departmentId = OTHER_DEPARTMENT;
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload)),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
  });
});
