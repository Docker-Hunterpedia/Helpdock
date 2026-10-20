import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as waitForQueue } from 'node:timers/promises';
import type { Ai } from '@helpdock/ai';
import { createKeyring, decryptSecret, encryptSecret } from '@helpdock/config';
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
  hcImportAssets,
  hcMedia,
  hcSearchDocuments,
  hcSections,
  importExternalIds,
  importFiles,
  importLog,
  importMappings,
  importPages,
  importRecords,
  importRuns,
  importTicketInventory,
  knowledgeDocuments,
  outbox,
  reportAgentDaily,
  reportDaily,
  retentionSettings,
  runMigrations,
  setEmbeddingDims,
  slaPolicies,
  tags,
  teams,
  ticketActivity,
  ticketMessages,
  ticketParticipants,
  ticketSlaClocks,
  ticketStatuses,
  tickets,
  ticketTags,
  updateEmbeddingSpace,
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
  type ImportSnapshotScope,
  importRecordParent,
  RateLimited,
  RUN_SNAPSHOT,
  ZendeskConnector,
  type ZendeskCredentials,
} from '@helpdock/importers';
import {
  FakeZendesk,
  FakeZoho,
  VendorServer,
  type ZendeskFixture,
  zendeskCoreFixture,
  zohoCoreFixture,
} from '@helpdock/importers/testing';
import { importLoadJob, JOB_DEFINITIONS } from '@helpdock/jobs';
import {
  contentPolicySchema,
  importArticleSchema,
  importEntitySchema,
  importMappingSchema,
  importRecordSchema,
  MAX_CUSTOM_FIELDS_PER_TARGET,
  ticketCcSchema,
  zendeskCredentialsSchema,
} from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ContactMergesRepository } from '../../contacts/contact-merges.repository.js';
import { ContactsRepository } from '../../contacts/contacts.repository.js';
import { CsatRepository } from '../../csat/csat.repository.js';
import { HelpCenterRepository } from '../../help-center/help-center.repository.js';
import { markImportedHcMediaFailed } from '../../help-center/import-media-failure.js';
import { forEachImportedArticleBatch } from '../../help-center/imported-articles.js';
import { createHcMediaProcessor } from '../../help-center/media-process.job.js';
import { publishVersion } from '../../help-center/publish.js';
import { importedArticlesHandler } from '../../help-center/search/search-events.js';
import { readableVersions } from '../../help-center/visibility.js';
import { embedPending } from '../../knowledge/embed-pending.js';
import { reembedChunks } from '../../knowledge/embedding-space.job.js';
import { createArticleKnowledgeHandlers } from '../../knowledge/knowledge-events.js';
import { objectKeyBeside } from '../../media/keys.js';
import { MediaRepository } from '../../media/media.repository.js';
import { createObjectPurgeHandler } from '../../media/object-purge.js';
import { createMediaProcessor } from '../../media/process.job.js';
import { RollupRepository } from '../../reports/rollup.repository.js';
import { SlaRepository } from '../../sla/sla.repository.js';
import { SlaService } from '../../sla/sla.service.js';
import { FakeStorage, fakeTools, silentJobLogger } from '../../testing/media.js';
import { hasDocker, startPostgres, startRedis } from '../../testing/meta-install.js';
import { DbTicketStatsProvider } from '../../tickets/contact-providers.js';
import { runTranscription } from '../../transcription/transcribe.job.js';
import { createTranscriptionHandler } from '../../transcription/transcription-events.js';
import { importArticleAssetMetadataHash } from '../article-asset-requests.js';
import { purgeImportedArticleAssetsBatch } from '../article-asset-retention.js';
import { ImportArticleAssetsPending } from '../article-asset-state.js';
import { preparedImportArticleSchema } from '../article-prepared.js';
import { createImportWorkHandler, enqueueImportWork } from '../import-events.js';
import { ImportsService } from '../imports.service.js';
import {
  readArticlePreparation,
  saveArticlePreparation,
} from '../jobs/article-asset-checkpoint.js';
import { runImportAttachmentBatch } from '../jobs/attachment-batch.js';
import {
  claimImportRun,
  IMPORT_CLAIM_TIMEOUT_MS,
  ImportClaimLost,
  importRunRefSchema,
  renewImportClaim,
} from '../jobs/claims.js';
import { completeImportRun } from '../jobs/complete-run.js';
import {
  createImportConnectorRuntime,
  createZendeskImportConnection,
} from '../jobs/connector-runtime.js';
import { continueImportWork } from '../jobs/continuation.js';
import { importDestinationFingerprint } from '../jobs/destination-fingerprint.js';
import { downloadStagedImportAttachment } from '../jobs/download-attachment.js';
import { runImportDryRunBatch } from '../jobs/dry-run-batch.js';
import { runImportDryRunMediaBatch } from '../jobs/dry-run-media.js';
import { runImportDryRunRecordBatch } from '../jobs/dry-run-records.js';
import { importDryRunCheckpointSchema } from '../jobs/dry-run-state.js';
import { discardUnavailableTicket, storeImportPage } from '../jobs/extract-page.js';
import { runImportExtraction } from '../jobs/extract-run.js';
import { completeExtraction } from '../jobs/extract-state.js';
import { runImportFinishBatch } from '../jobs/finish-batch.js';
import { beginImportFinishing } from '../jobs/finish-readiness.js';
import { createImportProcessor } from '../jobs/import-processor.js';
import { importInputFingerprint } from '../jobs/input-fingerprint.js';
import { loadAssembledStagedTicket } from '../jobs/load-assembled-ticket.js';
import { runImportLoadBatch } from '../jobs/load-batch.js';
import { loadMappedStagedTicket } from '../jobs/load-mapped-ticket.js';
import { loadNextStagedMetadata } from '../jobs/load-next-metadata.js';
import { loadPreparedStagedRecord } from '../jobs/load-prepared-record.js';
import { loadStagedRecord } from '../jobs/load-record-checkpoint.js';
import { loadStagedReference } from '../jobs/load-reference.js';
import { loadStagedCsat } from '../jobs/load-staged-csat.js';
import { loadStagedTicket } from '../jobs/load-ticket-checkpoint.js';
import { importExtractionPageCache } from '../jobs/page-cache.js';
import { markPendingImportWork } from '../jobs/pending-work.js';
import { createImportArticlePreparer } from '../jobs/prepare-article.js';
import { rebuildImportReportsBatch } from '../jobs/rebuild-reports.js';
import { recoverBrandImports } from '../jobs/recover.js';
import { cancelImportRun, pauseImportRun, resumeImportRun } from '../jobs/run-control.js';
import { saveImportMappings } from '../jobs/save-mappings.js';
import { bindImportSourceAccount, sourceAccountKey } from '../jobs/source-account.js';
import {
  createImportTicketInventory,
  importTicketInventoryManifest,
} from '../jobs/ticket-inventory.js';
import { decodedZohoCredentials, saveZohoAccessToken } from '../jobs/zoho-credentials.js';
import {
  attachmentPreview,
  attachmentReviewBinding,
} from '../preflight/attachment-availability.js';
import { validateContactIdentityPlan } from '../preflight/contact-identity-plan.js';
import { previewImportedContact } from '../preflight/contact-plan.js';
import { previewImportedContactSource } from '../preflight/contact-source-plan.js';
import { previewImportedCustom } from '../preflight/custom-values.js';
import { validateImportFieldPlan } from '../preflight/field-plan-state.js';
import { validateImportIdentityPlan } from '../preflight/identity-plan-state.js';
import { validateImportInvitationPlan } from '../preflight/invitation-plan-state.js';
import { validateImportMappingTarget } from '../preflight/mapping-targets.js';
import { previewImportedOrganization } from '../preflight/organization-plan.js';
import { validateImportRecordPage } from '../preflight/record-page.js';
import { validateImportReferences } from '../preflight/record-references.js';
import { previewImportedTicket } from '../preflight/ticket-preview.js';
import { validateImportTicketRouting } from '../preflight/ticket-routing.js';
import { purgeImportStagingBatch } from '../retention.js';
import { type TicketLoad, ticketLoadSchema } from './contracts.js';
import { fieldLoadSchema } from './field-contracts.js';
import { ImportWriter } from './import-writer.js';
import { articleLoadSchema, categoryLoadSchema, sectionLoadSchema } from './knowledge-contracts.js';
import { contactLoadSchema, organizationLoadSchema } from './profile-contracts.js';
import { resolveImportedCustom } from './resolve-custom-fields.js';
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

  it('stores original email identity and sent-time provenance, repeats without writes and retains unknown mail dates on correction', async () => {
    const input = request('original-mail-metadata');
    const original = input.messages[0];
    if (!original) throw new Error('Missing original mail message');
    original.email = {
      messageId: '<original.7001@source.example.test>',
      from: 'customer@example.test',
      to: ['support@example.test'],
      cc: ['copy@example.test'],
      sentAt: '2013-11-01T09:30:00.000Z',
    };
    original.sourceDetails = {
      mailSubject: 'Original mail subject',
      mailDate: 'Fri, 01 Nov 2013 15:00:00 +0530',
      mailReturnPath: '<bounce@example.test>',
    };
    input.messages = [original];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const [stored] = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, loaded.ticketId));
    if (!stored) throw new Error('Missing stored mail metadata');
    expect(stored).toMatchObject({
      externalMessageId: original.email.messageId,
      createdAt: new Date(original.createdAt),
      email: {
        from: { address: 'customer@example.test' },
        to: [{ address: 'support@example.test' }],
        cc: [{ address: 'copy@example.test' }],
        date: original.email.sentAt,
      },
      importDetails: original.sourceDetails,
    });
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id=${loaded.ticketId}`,
    );
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'unchanged',
    });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id=${loaded.ticketId}`,
      ),
    ).toEqual(before);
    original.email.sentAt = null;
    original.sourceDetails.mailDate = 'Unknown source time';
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const [corrected] = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.id, stored.id));
    expect(corrected).toMatchObject({
      externalMessageId: original.email.messageId,
      createdAt: stored.createdAt,
      email: { date: null },
      importDetails: { mailDate: 'Unknown source time' },
    });
    const newWebhookEvents = [
      'ticket.assigned',
      'ticket.status_changed',
      'ticket.merged',
      'message.created',
      'contact.updated',
      'contact.merged',
      'account.created',
      'account.updated',
    ];
    expect(
      (await owner.db.select().from(outbox)).filter((row) => newWebhookEvents.includes(row.event)),
    ).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('keeps source-only author names on history, repeats without message writes and never attaches a staff identity', async () => {
    const input = request('source-only-author');
    input.messages = [
      {
        externalId: 'source-only-message',
        ticketExternalId: input.record.externalId,
        authorKind: 'system',
        authorExternalId: 'staff',
        authorName: 'Original source author',
        sourceDetails: {
          status: 'FAILED',
          channel: 'EMAIL',
          authorKind: 'customer',
          authorType: 'END_USER',
        },
        via: 'zoho:EMAIL:out:FAILED',
        public: false,
        bodyText: 'Original private history',
        attachments: [],
        createdAt: '2019-01-02T00:00:00Z',
      },
    ];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const [message] = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, loaded.ticketId));
    if (!message) throw new Error('Missing source-only author message');
    expect(message).toMatchObject({
      authorType: 'system',
      authorId: null,
      authorDisplay: 'Original source author',
      importDetails: {
        status: 'FAILED',
        channel: 'EMAIL',
        authorKind: 'customer',
        authorType: 'END_USER',
        via: 'zoho:EMAIL:out:FAILED',
      },
      kind: 'note',
      bodyText: 'Original private history',
      createdAt: new Date('2019-01-02T00:00:00Z'),
    });
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id=${loaded.ticketId}`,
    );
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input))).toMatchObject({
      outcome: 'unchanged',
    });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id=${loaded.ticketId}`,
      ),
    ).toEqual(before);
    const source = input.messages[0];
    if (!source) throw new Error('Missing source-only author input');
    source.authorName = 'Corrected original name';
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      (await owner.db.select().from(ticketMessages).where(eq(ticketMessages.id, message.id)))[0],
    ).toMatchObject({
      authorId: null,
      authorDisplay: 'Corrected original name',
      createdAt: message.createdAt,
    });
  });

  async function stagedTicketScenario(
    externalId: string,
    attachmentUrl = 'https://vendor.example/history.pdf',
    attachmentMime = 'application/pdf',
    attachmentExternalId = `file-${externalId}`,
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
      externalId: attachmentExternalId,
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
  }, 300000);
  beforeEach(async () => {
    // This suite owns both containers; every case starts with the same independent fixture.
    await owner.db.execute(sql`TRUNCATE TABLE ${brands}, ${users} CASCADE`);
    await redis.flushdb();
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
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await redis?.quit();
    await redisContainer?.stop();
    await postgres?.stop();
  });

  it('omits a ticket deleted mid-extraction with its staged thread, preserving unrelated same-ID taxonomy', async () => {
    const scope = { brandId: BRAND, runId: RUN };
    await owner.db.update(importRuns).set({ status: 'extracting' }).where(eq(importRuns.id, RUN));
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'extracting' }),
    );
    if (!claim) throw new Error('Expected extraction claim');
    const record = request('42').record;
    await withSystem(app.db, BRAND, (tx) =>
      storeImportPage(tx, claim, 'ticket', {
        records: [{ entity: 'ticket', payload: record }],
        cursor: null,
      }),
    );
    await owner.db.insert(importRecords).values({
      ...scope,
      entity: 'section',
      externalId: 'taxonomy',
      parentExternalId: '42',
      payload: {},
      payloadHash: 'a'.repeat(64),
    });
    await withSystem(app.db, BRAND, async (tx) => {
      await tx.insert(importLog).values({
        ...scope,
        entity: 'ticket',
        externalId: '42',
        level: 'warning',
        message: 'import.record-unavailable',
      });
      await discardUnavailableTicket(tx, claim, '42');
      await storeImportPage(tx, claim, 'message', {
        records: request('42').messages.map((payload) => ({ entity: 'message', payload })),
        cursor: null,
      });
    });
    expect((await owner.db.select().from(importRecords)).map((row) => row.entity)).toEqual([
      'section',
    ]);
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, RUN)))[0]?.counts,
    ).toMatchObject({ extracted: { ticket: 0, message: 0 } });
  });

  it('retains a received page across process contexts and pause, fences a stale worker and purges snapshots on completion', async () => {
    const scope = { brandId: BRAND, runId: RUN };
    await owner.db.update(importRuns).set({ status: 'extracting' }).where(eq(importRuns.id, RUN));
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'extracting' }),
    );
    if (!claim) throw new Error('Expected extraction claim');
    const url = 'https://demo.zendesk.com/api/v2/tickets/1/comments.json?page=1';
    const response = {
      status: 200,
      body: Buffer.from('{"comments":[{"id":1},{"id":2}]}'),
      headers: { 'content-type': 'application/json', 'set-cookie': 'never-store-this' },
      url,
      redirects: [],
    };
    await importExtractionPageCache(app.db, claim, 'import.cache').write(url, response);
    await withSystem(app.db, BRAND, (tx) => pauseImportRun(tx, scope));
    expect(await owner.db.select().from(importPages)).toHaveLength(1);
    await expect(
      importExtractionPageCache(app.db, claim, 'import.stale').read(url),
    ).rejects.toMatchObject({ name: 'ImportClaimLost' });
    await withSystem(app.db, BRAND, (tx) => resumeImportRun(tx, scope));
    const resumed = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'extracting' }),
    );
    if (!resumed) throw new Error('Expected resumed claim');
    const cache = importExtractionPageCache(app.db, resumed, 'import.resumed');
    expect((await cache.read(url))?.body).toEqual(response.body);
    expect(
      await cache.write(url, { ...response, body: Buffer.from('{"comments":[{"id":2}]}') }),
    ).toMatchObject({ body: response.body, headers: { 'content-type': 'application/json' } });
    expect(JSON.stringify((await owner.db.select().from(importPages))[0]?.response)).not.toContain(
      'never-store-this',
    );
    await withSystem(app.db, BRAND, (tx) => completeExtraction(tx, resumed));
    expect(await owner.db.select().from(importPages)).toEqual([]);
  });

  it('drops each snapshot once its checkpoint commits unless a slot or the whole run still reads it', async () => {
    await owner.db.update(importRuns).set({ status: 'extracting' }).where(eq(importRuns.id, RUN));
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId: RUN, phase: 'extracting' }),
    );
    if (!claim) throw new Error('Expected extraction claim');
    const cache = importExtractionPageCache(app.db, claim, 'import.retention');
    const pages = {
      stream: '/api/v2/incremental/tickets/cursor.json',
      first: '/api/v2/tickets/1/comments.json',
      lookup: '/api/v2/users/7.json',
      second: '/api/v2/tickets/2/comments.json',
    };
    const url = (name: keyof typeof pages) => `https://demo.zendesk.com${pages[name]}`;
    const store = (name: keyof typeof pages, scope?: ImportSnapshotScope) =>
      cache.write(
        url(name),
        { status: 200, body: Buffer.from('{}'), headers: {}, url: url(name), redirects: [] },
        scope,
      );
    const commit = (cursor: { step: number } | null) =>
      withSystem(app.db, BRAND, (tx) =>
        storeImportPage(tx, claim, 'group', { records: [], cursor }),
      );
    const names = new Map(
      Object.keys(pages).map((name) => [hashImportValue(url(name as keyof typeof pages)), name]),
    );
    const retained = async () =>
      (
        await owner.db
          .select({
            hash: importPages.requestHash,
            slot: importPages.slot,
            run: importPages.runScoped,
          })
          .from(importPages)
      )
        .map(({ hash, ...row }) => ({ name: names.get(hash), ...row }))
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const slot = { slot: 'zendesk.comments' };

    await store('stream', RUN_SNAPSHOT);
    await store('first', slot);
    await store('lookup');
    await commit({ step: 1 });
    expect(await retained()).toEqual([
      { name: 'first', slot: 'zendesk.comments', run: false },
      { name: 'stream', slot: null, run: true },
    ]);
    // Until the next checkpoint commits, a killed worker can still resume inside the first page.
    await store('second', slot);
    expect(await retained()).toEqual([
      { name: 'first', slot: null, run: false },
      { name: 'second', slot: 'zendesk.comments', run: false },
      { name: 'stream', slot: null, run: true },
    ]);
    await commit({ step: 2 });
    await cache.read(url('stream'), { slot: 'zendesk.audits' });
    expect(await retained()).toEqual([
      { name: 'second', slot: 'zendesk.comments', run: false },
      { name: 'stream', slot: null, run: true },
    ]);
    await commit(null);
    expect(await retained()).toEqual([{ name: 'stream', slot: null, run: true }]);
  });

  it('quietly satisfies an activated response SLA and pauses then resumes resolution after vendor deltas', async () => {
    const input = request('activated-delta');
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const target = { firstResponseMinutes: 60, resolutionMinutes: 480 };
    await owner.db.insert(slaPolicies).values({
      brandId: BRAND,
      name: 'Live support',
      timeMode: 'calendar',
      conditions: [],
      targets: { low: target, medium: target, high: target, urgent: target },
      escalation: [],
    });
    const sla = new SlaService(new SlaRepository());
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        sla.activateImported(tx, { brandId: BRAND, ticketId: loaded.ticketId, at: new Date() }),
      ),
    ).toBe(true);
    const events = await owner.db.execute(
      sql`SELECT id,xmin::text AS revision FROM outbox ORDER BY id`,
    );
    const paused = uuidv7();
    await owner.db.insert(ticketStatuses).values({
      id: paused,
      brandId: BRAND,
      name: 'Waiting',
      systemState: 'on_hold',
      pausesSla: true,
      color: 'info',
    });
    input.record.status = 'pending';
    input.resolved.statusId = paused;
    input.messages.push({
      externalId: 'new-vendor-reply',
      ticketExternalId: input.record.externalId,
      authorExternalId: 'oldagent',
      authorKind: 'agent',
      public: true,
      bodyText: 'Historical agent answer',
      createdAt: '2020-01-01T00:00:00Z',
      attachments: [],
    });
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const clocks = await owner.db
      .select()
      .from(ticketSlaClocks)
      .where(eq(ticketSlaClocks.ticketId, loaded.ticketId));
    expect(clocks).toHaveLength(2);
    expect(clocks.find((clock) => clock.kind === 'first_response')).toMatchObject({
      satisfiedAt: expect.any(Date),
      dueAt: null,
      breachedAt: null,
    });
    expect(clocks.find((clock) => clock.kind === 'resolution')).toMatchObject({
      pausedAt: expect.any(Date),
      dueAt: null,
      breachedAt: null,
    });
    input.record.status = 'open';
    input.resolved.statusId = STATUS;
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      (
        await owner.db
          .select()
          .from(ticketSlaClocks)
          .where(
            and(
              eq(ticketSlaClocks.ticketId, loaded.ticketId),
              eq(ticketSlaClocks.kind, 'resolution'),
            ),
          )
      )[0],
    ).toMatchObject({ pausedAt: null, dueAt: expect.any(Date), breachedAt: null });
    const response = clocks.find((clock) => clock.kind === 'first_response');
    if (!response) throw new Error('Missing response clock');
    const startedAt = new Date();
    await owner.db
      .update(ticketSlaClocks)
      .set({ isCurrent: false })
      .where(eq(ticketSlaClocks.id, response.id));
    const nextId = uuidv7();
    await owner.db.insert(ticketSlaClocks).values({
      ...response,
      id: nextId,
      kind: 'next_response',
      cycle: 1,
      isCurrent: true,
      startedAt,
      checkpointAt: startedAt,
      satisfiedAt: null,
      pausedAt: null,
      dueAt: new Date(startedAt.getTime() + 3600000),
    });
    await owner.db.update(tickets).set({ slaCycle: 1 }).where(eq(tickets.id, loaded.ticketId));
    input.record.subject = 'Changed after a staff reopen';
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      (await owner.db.select().from(ticketSlaClocks).where(eq(ticketSlaClocks.id, nextId)))[0]
        ?.satisfiedAt,
    ).toBeNull();
    input.messages.push({
      externalId: 'reply-after-reopen',
      ticketExternalId: input.record.externalId,
      authorExternalId: 'oldagent',
      authorKind: 'agent',
      public: true,
      bodyText: 'Answer after reopen',
      createdAt: new Date().toISOString(),
      attachments: [],
    });
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      (await owner.db.select().from(ticketSlaClocks).where(eq(ticketSlaClocks.id, nextId)))[0]
        ?.satisfiedAt,
    ).toBeInstanceOf(Date);
    expect(
      await owner.db.execute(sql`SELECT id,xmin::text AS revision FROM outbox ORDER BY id`),
    ).toEqual(events);
  });

  it('warns before retention can erase old imported closed history and binds review to the retention policy', async () => {
    const record = request('retention-risk').record;
    await owner.db
      .update(ticketStatuses)
      .set({ systemState: 'closed' })
      .where(eq(ticketStatuses.id, STATUS));
    await owner.db.insert(importMappings).values([
      {
        brandId: BRAND,
        runId: RUN,
        kind: 'status',
        externalValue: 'open',
        target: { statusId: STATUS },
      },
      {
        brandId: BRAND,
        runId: RUN,
        kind: 'group',
        externalValue: '',
        target: { departmentId: DEPARTMENT, teamId: null },
      },
      {
        brandId: BRAND,
        runId: RUN,
        kind: 'priority',
        externalValue: '',
        target: { priority: 'medium' },
      },
      {
        brandId: BRAND,
        runId: RUN,
        kind: 'channel',
        externalValue: '',
        target: { channel: 'email' },
      },
    ]);
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: RUN,
      entity: 'ticket',
      externalId: record.externalId,
      payload: record,
      payloadHash: hashImportValue(record),
    });
    const scope = { brandId: BRAND, runId: RUN, source: 'zendesk' as const };
    const validate = () => withSystem(app.db, BRAND, (tx) => validateImportRecordPage(tx, scope));
    expect(await validate()).toMatchObject({ warningCount: 0, warnings: [] });
    const before = await withSystem(app.db, BRAND, (tx) =>
      importDestinationFingerprint(tx, { brandId: BRAND, runId: RUN }),
    );
    await owner.db.insert(retentionSettings).values({ brandId: BRAND, closedTicketDays: 365 });
    expect(await validate()).toMatchObject({
      warningCount: 1,
      warnings: [
        { entity: 'ticket', externalId: record.externalId, code: 'retention-closed-history' },
      ],
    });
    const after = await withSystem(app.db, BRAND, (tx) =>
      importDestinationFingerprint(tx, { brandId: BRAND, runId: RUN }),
    );
    expect(after).not.toBe(before);
    await owner.db
      .update(retentionSettings)
      .set({ lastRunAt: new Date(), lastRunCounts: { closedTickets: 1 } })
      .where(eq(retentionSettings.brandId, BRAND));
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        importDestinationFingerprint(tx, { brandId: BRAND, runId: RUN }),
      ),
    ).toBe(after);
    await owner.db
      .update(ticketStatuses)
      .set({ systemState: 'open' })
      .where(eq(ticketStatuses.id, STATUS));
    expect(await validate()).toMatchObject({ warningCount: 0, warnings: [] });
    expect(await owner.db.select().from(tickets)).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
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
    // M14-08: an import records its arrival on its own row, and nothing ran after it.
    expect(history.find((event) => event.action === 'ticket.imported')?.to?.arrival).toEqual({
      entry: 'import',
      entryId: input.runId,
      departmentId: input.resolved.departmentId,
      reason: 'import_mapping',
    });
    expect(history.some((event) => event.action === 'ticket.created')).toBe(false);
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
    expect(run?.counts).toEqual({
      loaded: { ticket: 1, message: 2, attachment: 1, csat: 1 },
      reportTicketsChanged: true,
    });
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
    expect(ticket?.statusChangedAt.toISOString()).toBe('2019-01-03T00:00:00.000Z');
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

  it('drains a large expired inventory in bounded batches before deleting its source file', async () => {
    const inventoryBrand = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: inventoryBrand, name: 'Inventory retention', prefix: 'INV' });
    try {
      const runId = uuidv7();
      const fileId = uuidv7();
      const revision = uuidv7();
      const now = new Date('2030-01-01T00:00:00Z');
      const sourceKey = `brands/${inventoryBrand}/imports/${runId}/files/${fileId}/sealed-source`;
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: inventoryBrand,
        source: 'freshdesk',
        status: 'completed',
        startedBy: USER,
        finishedAt: new Date('2029-01-01T00:00:00Z'),
      });
      await owner.db.insert(importFiles).values({
        id: fileId,
        brandId: inventoryBrand,
        runId,
        revision,
        fileName: 'archive.csv',
        format: 'csv',
        entity: 'ticket',
        size: 12,
        uploadKey: `brands/${inventoryBrand}/imports/${runId}/files/${fileId}/upload`,
        sourceKey,
        sha256: 'a'.repeat(64),
        status: 'ready',
      });
      await owner.db.insert(importTicketInventory).values(
        Array.from({ length: 51 }, (_, index) => ({
          brandId: inventoryBrand,
          runId,
          fileId,
          revision,
          sourceHash: 'a'.repeat(64),
          externalId: String(index + 1),
          location: 'archived',
          line: index + 2,
        })),
      );
      const purge = () =>
        withSystem(app.db, inventoryBrand, (tx) =>
          purgeImportStagingBatch(tx, { brandId: inventoryBrand, now, limit: 7 }),
        );
      expect(await purge()).toBe(7);
      expect(
        await owner.db
          .select({ id: importTicketInventory.id })
          .from(importTicketInventory)
          .where(eq(importTicketInventory.fileId, fileId)),
      ).toHaveLength(44);
      expect(
        await owner.db
          .select({ id: importFiles.id })
          .from(importFiles)
          .where(eq(importFiles.id, fileId)),
      ).toHaveLength(1);
      let finished = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const removed = await purge();
        expect(removed).toBeLessThanOrEqual(7);
        if (
          !(
            await owner.db
              .select({ id: importFiles.id })
              .from(importFiles)
              .where(eq(importFiles.id, fileId))
          ).length
        ) {
          finished = true;
          break;
        }
      }
      expect(finished).toBe(true);
      expect(
        await owner.db
          .select({ id: importTicketInventory.id })
          .from(importTicketInventory)
          .where(eq(importTicketInventory.fileId, fileId)),
      ).toEqual([]);
      const events = await owner.db
        .select()
        .from(outbox)
        .where(and(eq(outbox.brandId, inventoryBrand), eq(outbox.event, 'media.objects.purge')));
      expect(
        events.filter(
          (row) => Array.isArray(row.payload.keys) && row.payload.keys.includes(sourceKey),
        ),
      ).toHaveLength(1);
      expect(
        await owner.db
          .select({ id: importRuns.id })
          .from(importRuns)
          .where(eq(importRuns.id, runId)),
      ).toHaveLength(1);
    } finally {
      await owner.db.delete(brands).where(eq(brands.id, inventoryBrand));
    }
  });

  it('preserves an unscored imported answer, excludes it from live-survey selection and makes replay a no-op', async () => {
    const input = request('unscored-rating');
    input.csat = [
      {
        externalId: 'modern-response',
        ticketExternalId: 'unscored-rating',
        rating: null,
        ratedAt: '2019-01-04T10:00:00Z',
        sourceDetails: {
          ratingUnmapped: true,
          originalAnswers: [{ question_id: 'Q_1', question_text: 'Support rating', value: 7 }],
        },
      },
    ];
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const rows = await owner.db
      .select()
      .from(csatResponses)
      .where(eq(csatResponses.ticketId, loaded.ticketId));
    expect(rows).toMatchObject([
      {
        rating: null,
        ratedAt: new Date('2019-01-04T10:00:00Z'),
        importedDetails: input.csat[0]?.sourceDetails,
      },
    ]);
    const repository = new CsatRepository();
    expect(
      await withSystem(app.db, BRAND, (tx) => repository.latestForTicket(tx, loaded.ticketId)),
    ).toBeUndefined();
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        repository.latestImportedForTicket(tx, loaded.ticketId),
      ),
    ).toMatchObject({ id: rows[0]?.id, rating: null });
    const revisions = () =>
      owner.db.execute(
        sql`SELECT id,xmin::text AS revision FROM csat_responses WHERE ticket_id=${loaded.ticketId}`,
      );
    const before = await revisions();
    const historyRevisions = () =>
      owner.db.execute(
        sql`SELECT id,xmin::text AS revision FROM ticket_activity WHERE id=${rows[0]?.id}`,
      );
    const historyBefore = await historyRevisions();
    const [event] = await owner.db
      .select()
      .from(ticketActivity)
      .where(eq(ticketActivity.id, rows[0]?.id ?? ''));
    expect(event).toMatchObject({
      ticketId: loaded.ticketId,
      action: 'ticket.imported.event',
      createdAt: new Date('2019-01-04T10:00:00Z'),
      to: {
        csat: {
          state: 'imported_unscored',
          rating: null,
          link: null,
          originalAnswers: input.csat[0]?.sourceDetails?.originalAnswers,
        },
      },
    });
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(await revisions()).toEqual(before);
    expect(await historyRevisions()).toEqual(historyBefore);
    await expect(
      owner.db
        .update(csatResponses)
        .set({ importedDetails: {} })
        .where(eq(csatResponses.ticketId, loaded.ticketId)),
    ).rejects.toThrow();
    await expect(
      owner.db
        .update(csatResponses)
        .set({
          importedExternalId: null,
          importedSource: null,
          ratedVia: null,
          closedAt: new Date('2019-01-03T00:00:00Z'),
        })
        .where(eq(csatResponses.ticketId, loaded.ticketId)),
    ).rejects.toThrow();
  });

  it('excludes unscored source answers from the contact satisfaction denominator', async () => {
    const contactId = uuidv7();
    await owner.db
      .insert(contacts)
      .values({ id: contactId, brandId: BRAND, name: 'Historical response customer' });
    const input = request('unscored-contact-stats');
    input.resolved.contactId = contactId;
    input.authors.customer = { kind: 'contact', id: contactId };
    input.csat = [
      {
        externalId: 'unscored-stats',
        ticketExternalId: input.record.externalId,
        rating: null,
        ratedAt: '2019-01-04T10:00:00Z',
        sourceDetails: { ratingUnmapped: true },
      },
      {
        externalId: 'scored-stats',
        ticketExternalId: input.record.externalId,
        rating: 5,
        ratedAt: '2019-01-05T10:00:00Z',
      },
    ];
    await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const stats = await withSystem(app.db, BRAND, (tx) =>
      new DbTicketStatsProvider().forContacts(tx, BRAND, [contactId]),
    );
    expect(stats.get(contactId)?.csat).toBe(100);
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
        externalId: 'historical-unresolved-customer',
        ticketExternalId: 'reported-history',
        authorKind: 'system',
        authorName: 'Original customer without a stable source ID',
        sourceDetails: { authorKind: 'customer' },
        public: true,
        bodyText: 'Customer clarification',
        createdAt: '2018-01-01T13:00:00Z',
        attachments: [],
      },
      {
        externalId: 'historical-unresolved-author',
        ticketExternalId: 'reported-history',
        authorKind: 'system',
        authorName: 'Unresolved original author',
        public: true,
        bodyText: 'Historical clarification',
        createdAt: '2018-01-01T14:00:00Z',
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
    await owner.db.insert(customFieldDefs).values({
      brandId: OTHER_BRAND,
      target: 'ticket',
      key: 'foreign_field',
      label: 'Foreign field',
      type: 'text',
    });
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

  function zendeskThreadContext(fake: FakeZendesk, signal = new AbortController().signal) {
    return {
      credentials: { auth: 'oauth' as const, subdomain: 'demo', accessToken: 'synthetic-token' },
      signal,
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
  }

  function zendeskThreads(
    ticketIds: number[],
    bodies: Record<number, string> = {},
  ): ZendeskFixture {
    const comment = (id: number, author: number) => ({
      id,
      author_id: author,
      public: true,
      created_at: '2020-01-01T10:00:00Z',
      html_body: `<p>${bodies[id] ?? `Comment ${id}`}</p>`,
      attachments: [],
    });
    return {
      tickets: ticketIds.map((id) => ({ id, updated_at: '2020-01-02T10:00:00Z' })),
      users: [
        { id: 201, role: 'end-user', updated_at: '2020-01-02T10:00:00Z' },
        { id: 301, role: 'agent', updated_at: '2020-01-02T10:00:00Z' },
      ],
      comments: Object.fromEntries(
        ticketIds.map((id) => [String(id), [comment(id * 10 + 1, 201), comment(id * 10 + 2, 301)]]),
      ),
    };
  }

  async function startZendeskThreadRun() {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'extracting',
      startedBy: USER,
      options: { entities: ['message'] },
    });
    return runId;
  }

  /** Observes the database between pages: the worker has committed each yielded page by then. */
  function afterEachCommit(
    connector: Connector<ZendeskCredentials>,
    observe: () => Promise<void>,
  ): Connector<ZendeskCredentials> {
    return {
      source: connector.source,
      credentialsSchema: connector.credentialsSchema,
      entities: connector.entities,
      test: (context) => connector.test(context),
      defaultMappings: (sample) => connector.defaultMappings(sample),
      fetchAttachment: (context, ref) => connector.fetchAttachment(context, ref),
      async *extract(context, entity, cursor, since) {
        for await (const page of connector.extract(context, entity, cursor, since)) {
          yield page;
          await observe();
        }
      },
    };
  }

  const snapshotCount = async (runId: string) =>
    (await owner.db.select().from(importPages).where(eq(importPages.runId, runId))).length;

  it('holds only the ticket stream and the comment page being walked across many Zendesk threads', async () => {
    const ticketIds = Array.from({ length: 12 }, (_, index) => 3001 + index);
    const fake = new FakeZendesk(zendeskThreads(ticketIds), {
      authorization: 'Bearer synthetic-token',
      now: Date.parse('2026-10-14T00:00:00Z') / 1000,
    });
    await fake.server.start();
    try {
      const runId = await startZendeskThreadRun();
      const counts: number[] = [];
      const connector = afterEachCommit(
        new ZendeskConnector({ apiRoot: fake.server.root }),
        async () => {
          counts.push(await snapshotCount(runId));
        },
      );
      expect(
        await runImportExtraction({
          db: app.db,
          connector,
          context: zendeskThreadContext(fake),
          scope: { brandId: BRAND, runId },
          jobId: `zendesk.${runId}`,
        }),
      ).toEqual({ state: 'awaiting_mapping' });
      expect(
        await owner.db.select().from(importRecords).where(eq(importRecords.runId, runId)),
      ).toHaveLength(24);
      expect(counts.length).toBeGreaterThan(24);
      expect(Math.max(...counts)).toBe(2);
      expect(await snapshotCount(runId)).toBe(0);
    } finally {
      await fake.server.close();
    }
  });

  it('resumes a worker killed inside a Zendesk comment page from the pages it had already read', async () => {
    const ticketIds = [3001, 3002, 3003];
    const fake = new FakeZendesk(zendeskThreads(ticketIds), {
      authorization: 'Bearer synthetic-token',
      now: Date.parse('2026-10-14T00:00:00Z') / 1000,
    });
    await fake.server.start();
    try {
      const runId = await startZendeskThreadRun();
      const deps = (signal?: AbortSignal) => ({
        db: app.db,
        connector: new ZendeskConnector({ apiRoot: fake.server.root }),
        context: zendeskThreadContext(fake, signal),
        scope: { brandId: BRAND, runId },
        jobId: `zendesk.${runId}`,
      });
      // The first agent comment is on ticket 3001; the worker dies resolving its author.
      const lookup = fake.server.holdNextRequest('/api/v2/users/301.json');
      const worker = new AbortController();
      const killed = runImportExtraction(deps(worker.signal));
      await vi.waitFor(() => expect(lookup.waiting).toBe(true));
      worker.abort();
      lookup.release();
      expect(await killed).toEqual({ state: 'deferred', retryAfterMs: 1000 });
      expect(await snapshotCount(runId)).toBe(2);

      fake.replaceFixture(
        zendeskThreads([...ticketIds, 3004], { 30012: 'Edited after the crash' }),
      );
      expect(await runImportExtraction(deps())).toEqual({ state: 'awaiting_mapping' });
      const messages = await owner.db
        .select()
        .from(importRecords)
        .where(and(eq(importRecords.runId, runId), eq(importRecords.entity, 'message')));
      expect(messages.map((row) => row.externalId).sort()).toEqual([
        '30011',
        '30012',
        '30021',
        '30022',
        '30031',
        '30032',
      ]);
      expect(messages.find((row) => row.externalId === '30012')?.payload).toMatchObject({
        bodyHtml: '<p>Comment 30012</p>',
      });
      const reads = (path: string) => fake.server.calls.filter((call) => call.path === path);
      expect(reads('/api/v2/incremental/tickets/cursor.json')).toHaveLength(1);
      expect(reads('/api/v2/tickets/3001/comments.json')).toHaveLength(1);
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

  it('persists constant-size continuation cycle detection across worker deferrals instead of forgetting previously visited cursors', async () => {
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
      yield { records: [], cursor: { after: cursor?.after === 'a' ? 'b' : 'a' } };
      throw new RateLimited(1000);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await runImportExtraction(harness.deps)).toEqual({
        state: 'deferred',
        retryAfterMs: 1000,
      });
      const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      expect(run?.cursors.group).toMatchObject({
        cycle: { anchor: expect.any(String), power: 2, distance: attempt },
      });
      expect(JSON.stringify(run?.cursors.group).length).toBeLessThan(250);
      await owner.db
        .update(importRuns)
        .set({ counts: { ...run?.counts, retryAt: '2000-01-01T00:00:00.000Z' } })
        .where(eq(importRuns.id, runId));
    }
    expect(await runImportExtraction(harness.deps)).toEqual({ state: 'failed' });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run).toMatchObject({ error: 'invalid-response', credentialsEncrypted: null });
  });

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

  it('refuses article loading that would discard declared source files without a prepared asset manifest', async () => {
    const scope = { brandId: BRAND, runId: RUN, source: 'zendesk' as const };
    await withSystem(app.db, BRAND, (tx) =>
      writer.category(
        tx,
        categoryLoadSchema.parse({
          ...scope,
          record: { externalId: 'file-category', names: { en: 'Source files' } },
        }),
      ),
    );
    await withSystem(app.db, BRAND, (tx) =>
      writer.section(
        tx,
        sectionLoadSchema.parse({
          ...scope,
          record: {
            externalId: 'file-section',
            parentExternalId: 'file-category',
            names: { en: 'Original documents' },
          },
        }),
      ),
    );
    const input = articleLoadSchema.parse({
      ...scope,
      preparedBodyHtml: '<p>Original body</p>',
      record: {
        externalId: 'file-article',
        sectionExternalId: 'file-section',
        locale: 'en',
        title: 'Original article',
        bodyHtml: '<p>Original body</p>',
        draft: true,
        internal: true,
        createdAt: '2013-11-01T00:00:00Z',
        updatedAt: '2020-01-01T00:00:00Z',
        attachments: [
          {
            externalId: 'original-file',
            fileName: 'manual.pdf',
            url: 'https://vendor.invalid/manual.pdf',
          },
        ],
      },
    });
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.article(tx, input)),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(await owner.db.select().from(hcArticles)).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
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

  it.each([
    { change: 'signed-url', accepted: true },
    { change: 'refresh-page', accepted: true },
    { change: 'file-name', accepted: false },
    { change: 'bundle-path', accepted: false },
  ])(
    'matches independently extracted attachments after $change without accepting another file',
    async ({ change, accepted }) => {
      // The Freshdesk reference import exposed URL rotation between independent entity reads.
      const scenario = await mappedHistoryScenario(`attachment-${change}`);
      const [attachment] = await owner.db
        .select()
        .from(importRecords)
        .where(
          and(
            eq(importRecords.runId, scenario.input.runId),
            eq(importRecords.entity, 'attachment'),
          ),
        );
      if (!attachment) throw new Error('Missing staged attachment');
      const payload = { ...attachment.payload };
      if (change === 'signed-url')
        payload.url = 'https://vendor.example/history.pdf?signature=renewed';
      if (change === 'refresh-page') payload.sourcePage = 2;
      if (change === 'file-name') payload.fileName = 'different.pdf';
      if (change === 'bundle-path') {
        delete payload.url;
        payload.bundlePath = 'attachments/different.pdf';
      }
      await owner.db
        .update(importRecords)
        .set({ payload, payloadHash: hashImportValue(payload) })
        .where(eq(importRecords.id, attachment.id));
      const loading = withSystem(app.db, BRAND, (tx) =>
        loadAssembledStagedTicket(tx, { claim: scenario.claim, recordId: scenario.recordId }),
      );
      if (accepted) {
        const loaded = await loading;
        expect(loaded).toMatchObject({ state: 'loaded', messages: 2 });
        expect(
          await owner.db
            .select()
            .from(attachments)
            .where(eq(attachments.ticketId, loaded.ticketId)),
        ).toMatchObject([{ originalName: 'history.pdf', status: 'pending', origin: 'import' }]);
      } else {
        await expect(loading).rejects.toMatchObject({ code: 'mapping-invalid' });
        expect(await owner.db.select().from(tickets)).toEqual([]);
      }
      expect(await owner.db.select().from(outbox)).toEqual([]);
    },
  );

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
        parentExternalId: importRecordParent(record),
        payload: record.payload,
        payloadHash: hashImportValue(record.payload),
      });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing knowledge batch claim');
    return { claim, runId, records };
  }

  async function articleAssetCheckpoint(prefix: string) {
    const scenario = await stagedKnowledgeBatch(prefix);
    const [row] = await owner.db
      .select()
      .from(importRecords)
      .where(
        and(
          eq(importRecords.runId, scenario.runId),
          eq(importRecords.externalId, `${prefix}-primary`),
        ),
      );
    if (!row) throw new Error('Missing staged article');
    const record = importArticleSchema.parse({
      ...row.payload,
      attachments: [
        {
          externalId: 'native-manual',
          fileName: 'original.pdf',
          url: 'https://vendor.invalid/original.pdf',
        },
      ],
    });
    await owner.db
      .update(importRecords)
      .set({ payload: record, payloadHash: hashImportValue(record) })
      .where(eq(importRecords.id, row.id));
    const input = { claim: scenario.claim, recordId: row.id, record };
    const snapshot = await withSystem(app.db, BRAND, (tx) => readArticlePreparation(tx, input));
    const request = snapshot.requests[0];
    if (!request) throw new Error('Missing article asset request');
    return { ...scenario, input, snapshot, request };
  }

  it('resumes article asset outcomes without forgetting committed failures and refuses stale source content', async () => {
    const scenario = await articleAssetCheckpoint('asset-outcome');
    const state = {
      ...scenario.snapshot.preparation,
      outcomes: [
        {
          key: scenario.request.key,
          state: 'unavailable' as const,
          reason: 'source-unavailable' as const,
        },
      ],
    };
    await withSystem(app.db, BRAND, (tx) => saveArticlePreparation(tx, scenario.input, state));
    const resumed = await withSystem(app.db, BRAND, (tx) =>
      readArticlePreparation(tx, JSON.parse(JSON.stringify(scenario.input))),
    );
    expect(resumed.preparation).toEqual(state);
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        saveArticlePreparation(tx, scenario.input, { ...state, outcomes: [] }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        readArticlePreparation(tx, {
          ...scenario.input,
          record: { ...scenario.input.record, title: 'Changed caller data' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    const changed = { ...scenario.input.record, bodyHtml: '<p>Changed staged source</p>' };
    await owner.db
      .update(importRecords)
      .set({ payload: changed, payloadHash: hashImportValue(changed) })
      .where(eq(importRecords.id, scenario.input.recordId));
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        readArticlePreparation(tx, { ...scenario.input, record: changed }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
  });

  it('fences article assets by source account and cannot seal a processing candidate as a ready file', async () => {
    const scenario = await articleAssetCheckpoint('asset-proof');
    const mediaId = uuidv7(),
      assetId = uuidv7(),
      foreignId = uuidv7();
    await owner.db.insert(hcMedia).values({
      id: mediaId,
      brandId: BRAND,
      importedByRunId: scenario.runId,
      kind: 'file',
      s3Key: `brands/${BRAND}/help-center/${mediaId}/original`,
      originalName: 'original.pdf',
      mime: 'application/pdf',
      size: 123,
      status: 'processing',
    });
    const asset = {
      brandId: BRAND,
      source: 'zendesk' as const,
      parentExternalId: scenario.input.record.externalId,
      locale: 'en' as const,
      assetExternalId: scenario.request.identity.externalId,
      usage: 'download' as const,
      payloadHash: importArticleAssetMetadataHash(scenario.request),
      contentHash: 'c'.repeat(64),
      mediaId,
    };
    await owner.db.insert(hcImportAssets).values([
      { ...asset, id: assetId, sourceAccountKey: scenario.snapshot.accountKey },
      { ...asset, id: foreignId, sourceAccountKey: 'f'.repeat(64) },
    ]);
    const state = {
      ...scenario.snapshot.preparation,
      outcomes: [{ key: scenario.request.key, state: 'processing' as const, assetId }],
    };
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        saveArticlePreparation(tx, scenario.input, {
          ...state,
          outcomes: [{ ...state.outcomes[0]!, assetId: foreignId }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    await withSystem(app.db, BRAND, (tx) => saveArticlePreparation(tx, scenario.input, state));
    const ready = {
      ...state,
      outcomes: [{ key: scenario.request.key, state: 'prepared' as const, assetId }],
      bodyHash: hashImportValue('<p>Prepared</p>'),
    };
    await expect(
      withSystem(app.db, BRAND, (tx) => saveArticlePreparation(tx, scenario.input, ready)),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    await owner.db
      .update(hcMedia)
      .set({ status: 'ready', scanStatus: 'clean', processedAt: new Date() })
      .where(eq(hcMedia.id, mediaId));
    await withSystem(app.db, BRAND, (tx) => saveArticlePreparation(tx, scenario.input, ready));
    expect(
      (await withSystem(app.db, BRAND, (tx) => readArticlePreparation(tx, scenario.input)))
        .preparation,
    ).toEqual(ready);
    await expect(
      withSystem(app.db, BRAND, (tx) => saveArticlePreparation(tx, scenario.input, state)),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
  });

  it('prepares a vendor article file across continuations, refuses altered HTML and binds the scanned file with its article', async () => {
    const scenario = await articleAssetCheckpoint('asset-pipeline');
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const directory = await mkdtemp(path.join(tmpdir(), 'helpdock-article-assets-'));
    try {
      const bytes = Buffer.from('%PDF-1.7\nOriginal knowledge attachment');
      const url = fake.addAttachment('native-manual', bytes);
      const record = importArticleSchema.parse({
        ...scenario.input.record,
        attachments: [
          {
            externalId: 'native-manual',
            fileName: 'original.pdf',
            contentType: 'application/pdf',
            size: bytes.length,
            url,
          },
        ],
      });
      await owner.db
        .update(importRecords)
        .set({ payload: record, payloadHash: hashImportValue(record) })
        .where(eq(importRecords.id, scenario.input.recordId));
      const input = { ...scenario.input, record };
      const storage = new FakeStorage(directory);
      const connection = downloadHarness(fake, storage);
      const prepare = () =>
        createImportArticlePreparer({
          db: app.db,
          storage,
          resolve: async (scope) => {
            expect(importRunRefSchema.parse(scope)).toEqual({
              brandId: BRAND,
              runId: scenario.runId,
            });
            return connection;
          },
          mediaJobState: async () => 'waiting',
        });
      await expect(prepare()(input)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
      const [asset] = await owner.db
        .select()
        .from(hcImportAssets)
        .where(eq(hcImportAssets.parentExternalId, record.externalId));
      if (!asset) throw new Error('Missing prepared asset');
      expect(asset.articleId).toBeNull();
      const media = createHcMediaProcessor(storage, { scan: async () => 'clean' });
      await withSystem(app.db, BRAND, (tx) =>
        media.run({
          tx,
          payload: { brandId: BRAND, mediaId: asset.mediaId },
          log: silentJobLogger,
        }),
      );
      // Reconstruct the preparer to prove that no in-memory state is needed after processing.
      await expect(prepare()(input)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
      const html = await prepare()(input);
      if (typeof html !== 'string')
        throw new Error('Legacy source unexpectedly gained a published snapshot');
      expect(html).toContain(`/assets/${asset.id}`);
      expect(html).not.toContain(fake.server.root);
      const batch = (body: string) =>
        runImportLoadBatch(
          {
            db: app.db,
            jobId: 'import.article.asset-test',
            prepareArticle: async ({ record: next }) =>
              next.externalId === record.externalId ? body : next.bodyHtml,
          },
          { claim: scenario.claim },
        );
      await expect(batch(`${html}<p>Unreviewed content</p>`)).rejects.toMatchObject({
        code: 'mapping-invalid',
      });
      expect(await owner.db.select().from(hcArticles)).toEqual([]);
      expect(await batch(html)).toMatchObject({ state: 'records_loaded' });
      const [bound] = await owner.db
        .select()
        .from(hcImportAssets)
        .where(eq(hcImportAssets.id, asset.id));
      expect(bound?.articleId).toBeTruthy();
      const revisions = await owner.db.execute(
        sql`SELECT id, xmin::text FROM hc_import_assets WHERE id = ${asset.id}::uuid`,
      );
      expect(await batch(html)).toMatchObject({ state: 'records_loaded', processed: 0 });
      expect(
        await owner.db.execute(
          sql`SELECT id, xmin::text FROM hc_import_assets WHERE id = ${asset.id}::uuid`,
        ),
      ).toEqual(revisions);
      expect((await owner.db.select().from(outbox)).map((entry) => entry.event)).toEqual([
        'help_center.media_uploaded',
      ]);
    } finally {
      await fake.server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves separate working and published article bodies and files without exposing an unpublished edit through public reads', async () => {
    const scenario = await articleAssetCheckpoint('article-two-copies');
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const directory = await mkdtemp(path.join(tmpdir(), 'helpdock-article-two-copies-'));
    try {
      const workingUrl = fake.addAttachment(
        'working-manual',
        Buffer.from('%PDF-1.7\nUnpublished draft attachment'),
      );
      const publishedUrl = fake.addAttachment(
        'published-manual',
        Buffer.from('%PDF-1.7\nPublished original attachment'),
      );
      const record = importArticleSchema.parse({
        ...scenario.input.record,
        draft: false,
        internal: false,
        bodyHtml: '<p>Unpublished staff edit</p>',
        attachments: [{ externalId: 'working-manual', fileName: 'draft.pdf', url: workingUrl }],
        published: {
          title: 'Original published title',
          description: 'p'.repeat(300),
          bodyHtml: '<p>Published original answer</p>',
          publishedAt: null,
          attachments: [
            { externalId: 'published-manual', fileName: 'public.pdf', url: publishedUrl },
          ],
        },
      });
      await owner.db
        .update(importRecords)
        .set({ payload: record, payloadHash: hashImportValue(record) })
        .where(eq(importRecords.id, scenario.input.recordId));
      const input = { ...scenario.input, record },
        storage = new FakeStorage(directory);
      const prepare = createImportArticlePreparer({
        db: app.db,
        storage,
        resolve: async () => downloadHarness(fake, storage),
        mediaJobState: async () => 'waiting',
      });
      await expect(prepare(input)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
      await expect(prepare(input)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
      const assets = await owner.db
        .select()
        .from(hcImportAssets)
        .where(eq(hcImportAssets.parentExternalId, record.externalId));
      expect(assets).toHaveLength(2);
      for (const asset of assets)
        await withSystem(app.db, BRAND, (tx) =>
          createHcMediaProcessor(storage, { scan: async () => 'clean' }).run({
            tx,
            payload: { brandId: BRAND, mediaId: asset.mediaId },
            log: silentJobLogger,
          }),
        );
      await expect(prepare(input)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
      await expect(prepare(input)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
      const prepared = preparedImportArticleSchema.parse(await prepare(input));
      const draftAsset = assets.find((asset) => asset.assetExternalId === 'working-manual');
      const publicAsset = assets.find((asset) => asset.assetExternalId === 'published-manual');
      if (!draftAsset || !publicAsset) throw new Error('Missing per-copy media');
      expect(prepared.bodyHtml).toContain(draftAsset.id);
      expect(prepared.publishedBodyHtml).toContain(publicAsset.id);
      expect(prepared.publishedBodyHtml).not.toContain(draftAsset.id);
      expect(prepared.publishedBodyHtml).not.toContain('Unpublished');
      expect(
        await runImportLoadBatch(
          {
            db: app.db,
            jobId: 'import.article.two-copies',
            prepareArticle: async ({ record: next }) =>
              next.externalId === record.externalId ? prepared : next.bodyHtml,
          },
          { claim: scenario.claim },
        ),
      ).toMatchObject({ state: 'records_loaded' });
      const [version] = await owner.db
        .select()
        .from(hcArticleVersions)
        .where(and(eq(hcArticleVersions.locale, 'en'), eq(hcArticleVersions.title, record.title)));
      expect(version).toMatchObject({
        status: 'published',
        bodyHtml: `<p>Unpublished staff edit</p><p><a href="/api/help-center/brands/${BRAND}/assets/${draftAsset.id}" rel="noopener noreferrer">draft.pdf</a></p>`,
        publishedBodyHtml: `<p>Published original answer</p><p><a href="/api/help-center/brands/${BRAND}/assets/${publicAsset.id}" rel="noopener noreferrer">public.pdf</a></p>`,
        publishedTitle: 'Original published title',
        publishedAt: null,
        importedPublishedDescription: 'p'.repeat(300),
      });
      if (!version) throw new Error('Missing imported version');
      const publicRows = await withSystem(app.db, BRAND, (tx) =>
        tx.execute(
          sql`WITH ${readableVersions('public')} SELECT body_html FROM readable WHERE article_id = ${version.articleId}::uuid AND locale = 'en'`,
        ),
      );
      expect(publicRows).toEqual([{ body_html: version.publishedBodyHtml }]);
      expect(JSON.stringify(publicRows)).not.toContain('Unpublished');
    } finally {
      await fake.server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('prepares relative images for both article copies, keeps unavailable private gallery images explicit and never publishes draft image bytes', async () => {
    const scenario = await articleAssetCheckpoint('relative-article-images');
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const server = new VendorServer((url, authorization) => {
      if (authorization) return { status: 403 };
      if (['/working.png', '/public.png'].includes(url.pathname))
        return { status: 200, bytes: png, headers: { 'content-type': 'image/png' } };
      return { status: 403 };
    });
    await server.start();
    const directory = await mkdtemp(path.join(tmpdir(), 'helpdock-relative-article-images-'));
    try {
      const record = importArticleSchema.parse({
        ...scenario.input.record,
        draft: false,
        internal: false,
        attachments: [],
        assetOrigin: server.root,
        bodyHtml: '<p>Unpublished image edit</p><img src="/working.png"><img src="/private.png">',
        published: {
          title: 'Published original images',
          bodyHtml: '<p>Published original answer</p><img src="/public.png">',
          publishedAt: null,
          assetOrigin: server.root,
        },
      });
      await owner.db
        .update(importRecords)
        .set({ payload: record, payloadHash: hashImportValue(record) })
        .where(eq(importRecords.id, scenario.input.recordId));
      const input = { ...scenario.input, record },
        storage = new FakeStorage(directory);
      const connection = createZendeskImportConnection({
        credentials: { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' },
        downloadHosts: [],
        allowCidrs: [],
        log: async () => {},
        limiter: new ImportRateLimiter({ capacity: 100, perMinute: 1000 }),
        transport: {
          apiRoot: server.root,
          policy: {
            allowedPorts: [Number(new URL(server.root).port)],
            allowCidrs: ['127.0.0.1/32'],
          },
        },
      });
      let prepared: z.infer<typeof preparedImportArticleSchema> | undefined;
      for (let attempt = 0; attempt < 20 && !prepared; attempt++) {
        try {
          // Each attempt constructs a new preparer to exercise persisted continuation state.
          prepared = preparedImportArticleSchema.parse(
            await createImportArticlePreparer({
              db: app.db,
              storage,
              resolve: async () => connection,
              mediaJobState: async () => 'waiting',
            })(input),
          );
        } catch (error) {
          if (!(error instanceof ImportArticleAssetsPending)) throw error;
          const processing = await owner.db
            .select()
            .from(hcMedia)
            .where(
              and(
                eq(hcMedia.brandId, BRAND),
                eq(hcMedia.importedByRunId, scenario.runId),
                eq(hcMedia.status, 'processing'),
              ),
            );
          for (const media of processing)
            await withSystem(app.db, BRAND, (tx) =>
              createHcMediaProcessor(storage, { scan: async () => 'clean' }).run({
                tx,
                payload: { brandId: BRAND, mediaId: media.id },
                log: silentJobLogger,
              }),
            );
        }
      }
      if (!prepared) throw new Error('Relative image preparation did not complete');
      const assets = await owner.db
        .select()
        .from(hcImportAssets)
        .where(eq(hcImportAssets.parentExternalId, record.externalId));
      expect(assets).toHaveLength(2);
      const working = assets.find(
        (asset) =>
          asset.assetExternalId === `inline:${hashImportValue(`${server.root}/working.png`)}`,
      );
      const published = assets.find(
        (asset) =>
          asset.assetExternalId === `inline:${hashImportValue(`${server.root}/public.png`)}`,
      );
      if (!working || !published) throw new Error('Missing copy-specific image ownership');
      expect(prepared.bodyHtml).toContain(working.mediaId);
      expect(prepared.bodyHtml).toContain('File unavailable during import');
      expect(prepared.publishedBodyHtml).toContain(published.mediaId);
      expect(prepared.publishedBodyHtml).not.toContain(working.mediaId);
      expect(JSON.stringify(prepared)).not.toContain(server.root);
      for (const asset of assets) {
        const [media] = await owner.db.select().from(hcMedia).where(eq(hcMedia.id, asset.mediaId));
        if (!media?.webpKey) throw new Error('Missing converted image');
        expect(await sharp(await storage.read(media.webpKey)).metadata()).toMatchObject({
          format: 'webp',
          width: 8,
          height: 8,
        });
      }
      expect(
        await owner.db
          .select()
          .from(importLog)
          .where(
            and(
              eq(importLog.runId, scenario.runId),
              eq(importLog.message, 'import.article.asset-unavailable'),
            ),
          ),
      ).toHaveLength(1);
      expect(server.calls).toHaveLength(3);
      expect(server.calls.every((call) => !call.authenticated)).toBe(true);
      const sealed = prepared;
      expect(
        await runImportLoadBatch(
          {
            db: app.db,
            jobId: 'import.article.relative-images',
            prepareArticle: async ({ record: next }) =>
              next.externalId === record.externalId ? sealed : next.bodyHtml,
          },
          { claim: scenario.claim },
        ),
      ).toMatchObject({ state: 'records_loaded' });
      const [version] = await owner.db
        .select()
        .from(hcArticleVersions)
        .where(and(eq(hcArticleVersions.locale, 'en'), eq(hcArticleVersions.title, record.title)));
      if (!version) throw new Error('Missing image article version');
      const publicRows = await withSystem(app.db, BRAND, (tx) =>
        tx.execute(
          sql`WITH ${readableVersions('public')} SELECT body_html FROM readable WHERE article_id = ${version.articleId}::uuid AND locale = 'en'`,
        ),
      );
      expect(publicRows).toEqual([{ body_html: prepared.publishedBodyHtml }]);
      expect(JSON.stringify(publicRows)).not.toContain('Unpublished');
      expect(
        (await owner.db.select().from(outbox)).every((event) =>
          ['help_center.media_uploaded', 'media.objects.purge'].includes(event.event),
        ),
      ).toBe(true);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retries an unbound rejected article asset in a new run without changing its source identity or reusing a broken media attempt', async () => {
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const directory = await mkdtemp(path.join(tmpdir(), 'helpdock-article-retry-'));
    try {
      const storage = new FakeStorage(directory),
        bytes = Buffer.from('%PDF-1.7\nOriginal source bytes');
      const url = fake.addAttachment('native-manual', bytes);
      const prepare = createImportArticlePreparer({
        db: app.db,
        storage,
        resolve: async () => downloadHarness(fake, storage),
        mediaJobState: async () => 'failed',
      });
      async function stagedAttempt() {
        const attempt = await articleAssetCheckpoint('asset-retry');
        const record = importArticleSchema.parse({
          ...attempt.input.record,
          attachments: [
            {
              externalId: 'native-manual',
              fileName: 'original.pdf',
              contentType: 'application/pdf',
              size: bytes.length,
              url,
            },
          ],
        });
        await owner.db
          .update(importRecords)
          .set({ payload: record, payloadHash: hashImportValue(record) })
          .where(eq(importRecords.id, attempt.input.recordId));
        return { ...attempt.input, record };
      }
      const first = await stagedAttempt();
      await expect(prepare(first)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
      const [original] = await owner.db
        .select()
        .from(hcImportAssets)
        .where(eq(hcImportAssets.parentExternalId, first.record.externalId));
      if (!original) throw new Error('Missing original asset');
      await expect(
        withSystem(app.db, BRAND, (tx) =>
          createHcMediaProcessor(storage, { scan: async () => 'error' }).run({
            tx,
            payload: { brandId: BRAND, mediaId: original.mediaId },
            log: silentJobLogger,
          }),
        ),
      ).rejects.toMatchObject({ name: 'HcFileScanUnavailable' });
      await markImportedHcMediaFailed(app.db, { brandId: BRAND, mediaId: original.mediaId });
      await expect(prepare(first)).rejects.toMatchObject({ code: 'target-unavailable' });
      await owner.db
        .update(importRuns)
        .set({ status: 'failed', claimToken: null, claimedAt: null })
        .where(eq(importRuns.id, first.claim.runId));
      const retry = await stagedAttempt();
      await expect(prepare(retry)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
      const [replaced] = await owner.db
        .select()
        .from(hcImportAssets)
        .where(eq(hcImportAssets.id, original.id));
      if (!replaced) throw new Error('Missing retried asset');
      expect(replaced).toMatchObject({
        id: original.id,
        contentHash: original.contentHash,
        payloadHash: original.payloadHash,
        sourceAccountKey: original.sourceAccountKey,
        parentExternalId: original.parentExternalId,
        articleId: null,
      });
      expect(replaced.mediaId).not.toBe(original.mediaId);
      expect(
        await withSystem(app.db, BRAND, (tx) =>
          createHcMediaProcessor(storage, { scan: async () => 'clean' }).run({
            tx,
            payload: { brandId: BRAND, mediaId: replaced.mediaId },
            log: silentJobLogger,
          }),
        ),
      ).toEqual({ status: 'ready' });
      await expect(prepare(retry)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
      expect(await prepare(retry)).toContain(`/assets/${original.id}`);
    } finally {
      await fake.server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['en', 'ar'] as const)(
    'keeps a durable %s availability message and warning when a source article file is gone',
    async (locale) => {
      const scenario = await articleAssetCheckpoint(`asset-missing-${locale}`);
      const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
      await fake.server.start();
      const directory = await mkdtemp(path.join(tmpdir(), 'helpdock-article-missing-'));
      try {
        const url = `${fake.server.root}/attachments/token/missing/file`;
        const record = importArticleSchema.parse({
          ...scenario.input.record,
          locale,
          bodyHtml: `<p><a href="${url}">Historical manual</a></p>`,
          attachments: [{ externalId: 'missing-manual', fileName: '<original>.pdf', url }],
        });
        await owner.db
          .update(importRecords)
          .set({ payload: record, payloadHash: hashImportValue(record) })
          .where(eq(importRecords.id, scenario.input.recordId));
        const input = { ...scenario.input, record },
          storage = new FakeStorage(directory);
        const prepare = createImportArticlePreparer({
          db: app.db,
          storage,
          resolve: async () => downloadHarness(fake, storage),
          mediaJobState: async () => undefined,
        });
        await expect(prepare(input)).rejects.toBeInstanceOf(ImportArticleAssetsPending);
        const html = await prepare(input);
        if (typeof html !== 'string')
          throw new Error('Legacy source unexpectedly gained a published snapshot');
        expect(html).toContain(
          locale === 'en' ? 'File unavailable during import' : 'ملف غير متاح عند الاستيراد',
        );
        expect(html).toContain('&lt;original&gt;.pdf');
        expect(html).not.toContain(fake.server.root);
        expect(html).toContain('Historical manual');
        expect(await prepare(input)).toBe(html);
        expect(await owner.db.select().from(hcMedia)).toEqual([]);
        expect(await owner.db.select().from(outbox)).toEqual([]);
        expect(
          await owner.db
            .select({ message: importLog.message })
            .from(importLog)
            .where(eq(importLog.runId, scenario.runId)),
        ).toEqual([{ message: 'import.article.asset-unavailable' }]);
      } finally {
        await fake.server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('retains article assets during paused imports and while referenced, then purges only old importing media through the outbox', async () => {
    const scenario = await stagedKnowledgeBatch('asset-retention');
    await owner.db.update(importRuns).set({ status: 'completed' }).where(eq(importRuns.id, RUN));
    expect(
      await runImportLoadBatch(
        {
          db: app.db,
          jobId: 'import.assets.retention',
          prepareArticle: async ({ record }) => record.bodyHtml,
        },
        { claim: scenario.claim },
      ),
    ).toMatchObject({ state: 'records_loaded' });
    const [article] = await owner.db.select().from(hcArticles);
    if (!article) throw new Error('Missing retained article');
    const old = new Date('2000-01-01T00:00:00Z');
    const mediaId = uuidv7(),
      nativeId = uuidv7(),
      recentId = uuidv7();
    await owner.db.insert(hcMedia).values([
      {
        id: mediaId,
        brandId: BRAND,
        s3Key: `brands/${BRAND}/help-center/${mediaId}/original`,
        originalName: 'manual.pdf',
        mime: 'application/pdf',
        size: 100,
        kind: 'file',
        importedByRunId: scenario.runId,
        status: 'ready',
        createdAt: old,
      },
      {
        id: nativeId,
        brandId: BRAND,
        s3Key: `brands/${BRAND}/help-center/${nativeId}/original`,
        originalName: 'native.png',
        mime: 'image/png',
        size: 100,
        createdAt: old,
      },
      {
        id: recentId,
        brandId: BRAND,
        s3Key: `brands/${BRAND}/help-center/${recentId}/original`,
        originalName: 'recent.pdf',
        mime: 'application/pdf',
        size: 100,
        kind: 'file',
        importedByRunId: scenario.runId,
      },
    ]);
    const [asset] = await owner.db
      .insert(hcImportAssets)
      .values({
        brandId: BRAND,
        source: 'zendesk',
        sourceAccountKey: 'c'.repeat(64),
        parentExternalId: 'asset-retention-primary',
        assetExternalId: 'manual',
        locale: 'en',
        usage: 'download',
        payloadHash: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        mediaId,
        articleId: article.id,
        createdAt: old,
      })
      .returning();
    if (!asset) throw new Error('Missing retained file');
    const purge = () =>
      withSystem(app.db, BRAND, (tx) =>
        purgeImportedArticleAssetsBatch(tx, {
          brandId: BRAND,
          cutoff: new Date('2001-01-01T00:00:00Z'),
          limit: 10,
        }),
      );
    await owner.db
      .update(importRuns)
      .set({ status: 'paused', pausedFrom: 'loading', claimToken: null, claimedAt: null })
      .where(eq(importRuns.id, scenario.runId));
    expect(await purge()).toBe(0);
    await owner.db
      .update(importRuns)
      .set({ status: 'completed', pausedFrom: null })
      .where(eq(importRuns.id, scenario.runId));
    await owner.db
      .update(hcArticleVersions)
      .set({
        bodyHtml: `<p><a href="/api/help-center/brands/${BRAND}/assets/${asset.id}">Manual</a></p>`,
      })
      .where(and(eq(hcArticleVersions.articleId, article.id), eq(hcArticleVersions.locale, 'en')));
    expect(await purge()).toBe(0);
    await owner.db
      .update(hcArticleVersions)
      .set({ bodyHtml: '<p>File removed by editor</p>', publishedBodyHtml: null })
      .where(eq(hcArticleVersions.articleId, article.id));
    expect(await purge()).toBe(2);
    expect(
      (await owner.db.select({ id: hcMedia.id }).from(hcMedia)).map((row) => row.id).sort(),
    ).toEqual([nativeId, recentId].sort());
    expect(await owner.db.select().from(hcImportAssets)).toEqual([]);
    const [event] = await owner.db.select().from(outbox);
    expect(event).toMatchObject({
      event: 'media.objects.purge',
      payload: {
        keys: [
          `brands/${BRAND}/help-center/${mediaId}/original`,
          `brands/${BRAND}/help-center/${mediaId}/webp`,
        ],
      },
    });
    expect(await purge()).toBe(0);
  });

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

  it('binds a sealed inventory to its account, revision and content hash and reads distinct IDs in byte order', async () => {
    const brandId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Inventory manifest', prefix: 'IMA' });
    try {
      const runId = uuidv7();
      const fileId = uuidv7();
      const revision = uuidv7();
      await owner.db
        .insert(importRuns)
        .values({ id: runId, brandId, source: 'freshdesk', status: 'connecting', startedBy: USER });
      const accountKey = await withSystem(app.db, brandId, (tx) =>
        bindImportSourceAccount(tx, { brandId, runId, verifiedAccount: 'original-account' }),
      );
      await owner.db.insert(importFiles).values({
        id: fileId,
        brandId,
        runId,
        revision,
        fileName: 'archive.csv',
        format: 'csv',
        entity: 'ticket',
        size: 12,
        uploadKey: `brands/${brandId}/imports/${runId}/files/${fileId}/upload`,
        sourceKey: `brands/${brandId}/imports/${runId}/files/${fileId}/sealed-source`,
        sha256: 'a'.repeat(64),
        status: 'ready',
        recordCount: 2,
        inventoryMapping: { idColumn: 'Ticket ID', location: 'archived' },
        inventoryValidation: { kind: 'ticket-inventory', sourceRows: 3, records: 2, duplicates: 1 },
      });
      const row = {
        brandId,
        runId,
        fileId,
        revision,
        sourceHash: 'a'.repeat(64),
        location: 'archived',
        line: 2,
      };
      await owner.db.insert(importTicketInventory).values([
        { ...row, externalId: '10' },
        { ...row, externalId: '2' },
        { ...row, externalId: '1', sourceHash: 'b'.repeat(64) },
        { ...row, externalId: '3', revision: uuidv7() },
      ]);
      const complete = await createImportTicketInventory(
        { db: app.db },
        { brandId, runId },
        'complete',
      );
      expect(await complete.next(null)).toEqual({ externalId: '10', location: 'archived' });
      expect(await complete.next('10')).toEqual({ externalId: '2', location: 'archived' });
      expect(await complete.next('2')).toBeNull();
      const archives = await createImportTicketInventory(
        { db: app.db },
        { brandId, runId },
        'archives',
      );
      expect(archives.fingerprint).not.toBe(complete.fingerprint);
      const [originalFile] = await owner.db
        .select()
        .from(importFiles)
        .where(eq(importFiles.id, fileId));
      if (!originalFile) throw new Error('Missing inventory fixture');
      const overlappingFileId = uuidv7();
      await owner.db.insert(importFiles).values({
        ...originalFile,
        id: overlappingFileId,
        uploadKey: `brands/${brandId}/imports/${runId}/files/${overlappingFileId}/upload`,
        sourceKey: `brands/${brandId}/imports/${runId}/files/${overlappingFileId}/sealed-source`,
        inventoryMapping: { idColumn: 'Ticket ID', location: 'active' },
        recordCount: 1,
        inventoryValidation: {
          kind: 'ticket-inventory',
          sourceRows: 1,
          records: 1,
          duplicates: 0,
        },
      });
      await owner.db
        .insert(importTicketInventory)
        .values({ ...row, fileId: overlappingFileId, externalId: '10', location: 'active' });
      await expect(
        withSystem(app.db, brandId, (tx) =>
          importTicketInventoryManifest(tx, { brandId, runId }, 'complete'),
        ),
      ).rejects.toMatchObject({ code: 'invalid-response' });
      await owner.db
        .update(importFiles)
        .set({ inventoryMapping: { idColumn: 'Ticket ID', location: 'archived' } })
        .where(eq(importFiles.id, overlappingFileId));
      // The file's declared location and every prepared row must agree as well.
      await expect(
        withSystem(app.db, brandId, (tx) =>
          importTicketInventoryManifest(tx, { brandId, runId }, 'complete'),
        ),
      ).rejects.toMatchObject({ code: 'invalid-response' });
      await owner.db
        .update(importTicketInventory)
        .set({ location: 'archived' })
        .where(eq(importTicketInventory.fileId, overlappingFileId));
      const overlapping = await createImportTicketInventory(
        { db: app.db },
        { brandId, runId },
        'complete',
      );
      expect(await overlapping.next(null)).toEqual({ externalId: '10', location: 'archived' });
      expect(await overlapping.next('10')).toEqual({ externalId: '2', location: 'archived' });
      expect(await overlapping.next('2')).toBeNull();
      await owner.db.delete(importFiles).where(eq(importFiles.id, overlappingFileId));
      await expect(
        withSystem(app.db, brandId, (tx) =>
          bindImportSourceAccount(tx, { brandId, runId, verifiedAccount: 'different-account' }),
        ),
      ).rejects.toMatchObject({ code: 'mapping-invalid' });
      expect(
        (
          await owner.db
            .select({ key: importRuns.sourceAccountKey })
            .from(importRuns)
            .where(eq(importRuns.id, runId))
        )[0]?.key,
      ).toBe(accountKey);
      await owner.db
        .delete(importTicketInventory)
        .where(
          and(eq(importTicketInventory.fileId, fileId), eq(importTicketInventory.externalId, '2')),
        );
      await expect(
        withSystem(app.db, brandId, (tx) =>
          importTicketInventoryManifest(tx, { brandId, runId }, 'complete'),
        ),
      ).rejects.toMatchObject({ code: 'invalid-response' });
    } finally {
      await owner.db.delete(brands).where(eq(brands.id, brandId));
    }
  });

  async function boundAccountRun(
    account: string,
    brandId = BRAND,
    source: 'zendesk' | 'freshdesk' = 'zendesk',
  ) {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: brandId,
      source,
      status: 'connecting',
      startedBy: USER,
    });
    const key = await withSystem(app.db, brandId, (tx) =>
      bindImportSourceAccount(tx, { brandId: brandId, runId, verifiedAccount: account }),
    );
    await owner.db.update(importRuns).set({ status: 'loading' }).where(eq(importRuns.id, runId));
    return { runId, key };
  }

  /** The queue job that delivers the run's pending request, as the outbox bridge would build it. */
  async function deliveredJob(name: string, runId: string, id: string) {
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    const pending = run?.counts.pendingWorkId;
    const workId = typeof pending === 'string' ? pending : uuidv7();
    if (workId !== pending)
      await withSystem(app.db, BRAND, (tx) =>
        markPendingImportWork(tx, {
          brandId: BRAND,
          runId,
          workId,
          dueAt: new Date().toISOString(),
        }),
      );
    return { name, id, data: { brandId: BRAND, runId, workId } };
  }

  async function changedArticleAnchor(
    scenario: 'same-account' | 'foreign-account' | 'foreign-brand' | 'foreign-vendor',
  ) {
    const priorBrand = scenario === 'foreign-brand' ? OTHER_BRAND : BRAND;
    const priorAccount = scenario === 'foreign-account' ? 'other-anchor-account' : 'anchor-account';
    const priorSource =
      scenario === 'foreign-vendor' ? ('freshdesk' as const) : ('zendesk' as const);
    const priorRun = await boundAccountRun(priorAccount, priorBrand, priorSource);
    const priorScope = { brandId: priorBrand, runId: priorRun.runId, source: priorSource };
    const category = { externalId: 'anchor-category', names: { en: 'History' } };
    const section = {
      externalId: 'anchor-section',
      parentExternalId: category.externalId,
      names: { en: 'Answers' },
    };
    await withSystem(app.db, priorBrand, (tx) =>
      writer.category(tx, categoryLoadSchema.parse({ ...priorScope, record: category })),
    );
    await withSystem(app.db, priorBrand, (tx) =>
      writer.section(tx, sectionLoadSchema.parse({ ...priorScope, record: section })),
    );
    const original = importArticleSchema.parse({
      externalId: 'anchor-ar',
      sectionExternalId: section.externalId,
      locale: 'ar',
      title: 'الإجابة الأصلية',
      bodyHtml: '<p>السجل الأصلي</p>',
      draft: true,
      internal: true,
      createdAt: '2018-01-01T00:00:00Z',
      updatedAt: '2019-01-01T00:00:00Z',
    });
    const prior = await withSystem(app.db, priorBrand, (tx) =>
      writer.article(
        tx,
        articleLoadSchema.parse({
          ...priorScope,
          record: original,
          preparedBodyHtml: original.bodyHtml,
        }),
      ),
    );
    await owner.db
      .update(importRuns)
      .set({ status: 'completed' })
      .where(eq(importRuns.id, priorRun.runId));
    const current = await boundAccountRun('anchor-account');
    const scope = { brandId: BRAND, runId: current.runId, source: 'zendesk' as const };
    if (scenario === 'same-account')
      await owner.db
        .update(importRuns)
        .set({ mode: 'delta', parentRunId: priorRun.runId })
        .where(eq(importRuns.id, current.runId));
    else {
      await withSystem(app.db, BRAND, (tx) =>
        writer.category(tx, categoryLoadSchema.parse({ ...scope, record: category })),
      );
      await withSystem(app.db, BRAND, (tx) =>
        writer.section(tx, sectionLoadSchema.parse({ ...scope, record: section })),
      );
    }
    const english = importArticleSchema.parse({
      ...original,
      externalId: 'anchor-en',
      locale: 'en',
      title: 'New English translation',
      bodyHtml: '<p>New translation</p>',
      createdAt: '2019-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    });
    const arabic = importArticleSchema.parse({ ...original, translationOf: english.externalId });
    for (const payload of [english, arabic]) {
      const record = importRecordSchema.parse({ entity: 'article', payload });
      await owner.db.insert(importRecords).values({
        brandId: BRAND,
        runId: current.runId,
        entity: 'article',
        externalId: payload.externalId,
        parentExternalId: importRecordParent(record),
        payload,
        payloadHash: hashImportValue(payload),
      });
    }
    return { prior, scope, english, arabic, currentKey: current.key };
  }

  it('reuses an imported article when a delta adds a new translation anchor, then repeats without writing or publishing anything', async () => {
    const fixture = await changedArticleAnchor('same-account');
    for (const payload of [fixture.english, fixture.arabic])
      expect(
        await withSystem(app.db, BRAND, (tx) =>
          validateImportReferences(tx, fixture.scope, { entity: 'article', payload }),
        ),
      ).toEqual([]);
    for (const record of [fixture.english, fixture.arabic])
      expect(
        await withSystem(app.db, BRAND, (tx) =>
          writer.article(
            tx,
            articleLoadSchema.parse({
              ...fixture.scope,
              record,
              preparedBodyHtml: record.bodyHtml,
            }),
          ),
        ),
      ).toMatchObject({ id: fixture.prior.id });
    expect(await owner.db.select().from(hcArticles)).toHaveLength(1);
    const versions = await owner.db
      .select()
      .from(hcArticleVersions)
      .where(eq(hcArticleVersions.articleId, fixture.prior.id));
    expect(versions.map((row) => row.locale).sort()).toEqual(['ar', 'en']);
    expect(versions.find((row) => row.locale === 'ar')?.bodyHtml).toBe(fixture.arabic.bodyHtml);
    expect(versions.find((row) => row.locale === 'ar')?.createdAt.toISOString()).toBe(
      '2018-01-01T00:00:00.000Z',
    );
    expect(versions.find((row) => row.locale === 'ar')?.updatedAt.toISOString()).toBe(
      '2019-01-01T00:00:00.000Z',
    );
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM hc_article_versions ORDER BY id`,
    );
    const articleRevisions = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM hc_articles ORDER BY id`,
    );
    const receipts = await owner.db.execute(
      sql`SELECT external_id, helpdock_id, xmin::text AS revision FROM import_external_ids WHERE entity = 'article' ORDER BY external_id`,
    );
    for (const record of [fixture.english, fixture.arabic])
      expect(
        await withSystem(app.db, BRAND, (tx) =>
          writer.article(
            tx,
            articleLoadSchema.parse({
              ...fixture.scope,
              record,
              preparedBodyHtml: record.bodyHtml,
            }),
          ),
        ),
      ).toMatchObject({ id: fixture.prior.id, outcome: 'unchanged' });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM hc_article_versions ORDER BY id`,
      ),
    ).toEqual(before);
    expect(
      await owner.db.execute(sql`SELECT id, xmin::text AS revision FROM hc_articles ORDER BY id`),
    ).toEqual(articleRevisions);
    expect(
      await owner.db.execute(
        sql`SELECT external_id, helpdock_id, xmin::text AS revision FROM import_external_ids WHERE entity = 'article' ORDER BY external_id`,
      ),
    ).toEqual(receipts);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('rejects an occupied unowned language during both dry run and loading after resolving the prior sibling', async () => {
    const fixture = await changedArticleAnchor('same-account');
    await owner.db.insert(hcArticleVersions).values({
      brandId: BRAND,
      articleId: fixture.prior.id,
      locale: 'en',
      title: 'Manually written English',
      bodyHtml: '<p>Keep this manual content</p>',
    });
    const before = await owner.db.execute(
      sql`SELECT id, body_html, xmin::text AS revision FROM hc_article_versions ORDER BY id`,
    );
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        validateImportReferences(tx, fixture.scope, {
          entity: 'article',
          payload: fixture.english,
        }),
      ),
    ).toMatchObject([{ code: 'reference-invalid' }]);
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.article(
          tx,
          articleLoadSchema.parse({
            ...fixture.scope,
            record: fixture.english,
            preparedBodyHtml: fixture.english.bodyHtml,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(
      await owner.db.execute(
        sql`SELECT id, body_html, xmin::text AS revision FROM hc_article_versions ORDER BY id`,
      ),
    ).toEqual(before);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('refuses a deleted sibling destination instead of recreating its article under a new translation anchor', async () => {
    const fixture = await changedArticleAnchor('same-account');
    await owner.db.delete(hcArticles).where(eq(hcArticles.id, fixture.prior.id));
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        validateImportReferences(tx, fixture.scope, {
          entity: 'article',
          payload: fixture.english,
        }),
      ),
    ).toMatchObject([{ code: 'reference-invalid' }]);
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        writer.article(
          tx,
          articleLoadSchema.parse({
            ...fixture.scope,
            record: fixture.english,
            preparedBodyHtml: fixture.english.bodyHtml,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    expect(await owner.db.select().from(hcArticles)).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it.each(['foreign-account', 'foreign-brand', 'foreign-vendor'] as const)(
    'does not adopt a staged sibling receipt from a %s',
    async (scenario) => {
      const fixture = await changedArticleAnchor(scenario);
      const before = await owner.db.execute(
        sql`SELECT id, body_html, xmin::text AS revision FROM hc_article_versions WHERE article_id = ${fixture.prior.id}::uuid ORDER BY id`,
      );
      const created = await withSystem(app.db, BRAND, (tx) =>
        writer.article(
          tx,
          articleLoadSchema.parse({
            ...fixture.scope,
            record: fixture.english,
            preparedBodyHtml: fixture.english.bodyHtml,
          }),
        ),
      );
      expect(created.id).not.toBe(fixture.prior.id);
      expect(
        await owner.db.execute(
          sql`SELECT id, body_html, xmin::text AS revision FROM hc_article_versions WHERE article_id = ${fixture.prior.id}::uuid ORDER BY id`,
        ),
      ).toEqual(before);
      expect(await owner.db.select().from(outbox)).toEqual([]);
    },
  );

  it.each([
    'same-language',
    'different-section',
    'skipped',
    'corrupt-hash',
    'redirected-staging-target',
    'ambiguous',
  ] as const)(
    'refuses a %s prior sibling before adopting its destination in dry run or loading',
    async (scenario) => {
      const fixture = await changedArticleAnchor('same-account');
      const predicate = and(
        eq(importRecords.runId, fixture.scope.runId),
        eq(importRecords.externalId, fixture.arabic.externalId),
      );
      if (scenario === 'same-language' || scenario === 'different-section') {
        const payload = {
          ...fixture.arabic,
          ...(scenario === 'same-language'
            ? { locale: 'en' }
            : { sectionExternalId: 'different-section' }),
        };
        const native = importRecordSchema.parse({ entity: 'article', payload });
        await owner.db
          .update(importRecords)
          .set({
            payload: native.payload,
            payloadHash: hashImportValue(native.payload),
            parentExternalId: importRecordParent(native),
          })
          .where(predicate);
      } else if (scenario === 'skipped')
        await owner.db.update(importRecords).set({ status: 'skipped' }).where(predicate);
      else if (scenario === 'corrupt-hash')
        await owner.db
          .update(importRecords)
          .set({ payloadHash: '0'.repeat(64) })
          .where(predicate);
      else if (scenario === 'redirected-staging-target')
        await owner.db.update(importRecords).set({ helpdockId: uuidv7() }).where(predicate);
      else {
        const payload = { ...fixture.arabic, externalId: 'second-owned-sibling' };
        const native = importRecordSchema.parse({ entity: 'article', payload });
        await owner.db.insert(importRecords).values({
          brandId: BRAND,
          runId: fixture.scope.runId,
          entity: 'article',
          externalId: payload.externalId,
          parentExternalId: importRecordParent(native),
          payload,
          payloadHash: hashImportValue(payload),
        });
        await owner.db.insert(importExternalIds).values({
          brandId: BRAND,
          source: 'zendesk',
          sourceAccountKey: fixture.currentKey,
          entity: 'article',
          externalId: payload.externalId,
          helpdockId: fixture.prior.id,
          payloadHash: hashImportValue(payload),
        });
      }
      const before = await owner.db.execute(
        sql`SELECT id, body_html, xmin::text AS revision FROM hc_article_versions ORDER BY id`,
      );
      expect(
        await withSystem(app.db, BRAND, (tx) =>
          validateImportReferences(tx, fixture.scope, {
            entity: 'article',
            payload: fixture.english,
          }),
        ),
      ).toMatchObject([{ code: 'reference-invalid' }]);
      await expect(
        withSystem(app.db, BRAND, (tx) =>
          writer.article(
            tx,
            articleLoadSchema.parse({
              ...fixture.scope,
              record: fixture.english,
              preparedBodyHtml: fixture.english.bodyHtml,
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'mapping-invalid' });
      expect(
        await owner.db.execute(
          sql`SELECT id, body_html, xmin::text AS revision FROM hc_article_versions ORDER BY id`,
        ),
      ).toEqual(before);
      expect(await owner.db.select().from(outbox)).toEqual([]);
    },
  );

  it('separates identical ticket, message, contact, satisfaction and attachment IDs across accounts and reuses the original namespace on repeats', async () => {
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
      input.csat = [
        {
          externalId: 'namespace-csat',
          ticketExternalId: input.record.externalId,
          rating: 5,
          ratedAt: '2019-01-03T00:00:00Z',
        },
      ];
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
    const answers = await owner.db
      .select()
      .from(csatResponses)
      .where(
        and(
          eq(csatResponses.brandId, BRAND),
          eq(csatResponses.importedExternalId, 'namespace-csat'),
        ),
      );
    expect(new Set(answers.map((answer) => answer.importSourceAccountKey))).toEqual(
      new Set([one.key, two.key]),
    );
    expect(answers).toHaveLength(2);
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
      expect(jobs[0]?.data).toEqual({ brandId: BRAND, runId: run.runId, workId: eventId });
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

  it('reuses an encrypted Zoho token after a runtime restart and cannot restore credentials after cancellation', async () => {
    const fake = new FakeZoho(structuredClone(zohoCoreFixture));
    await fake.start();
    try {
      const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 33).toString('base64') });
      const credentials = {
        region: 'us' as const,
        orgId: fake.fixture.orgId,
        clientId: fake.fixture.clientId,
        clientSecret: fake.fixture.clientSecret,
        refreshToken: fake.fixture.refreshToken,
      };
      const runId = uuidv7(),
        scope = { brandId: BRAND, runId };
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: BRAND,
        source: 'zohodesk',
        status: 'connecting',
        startedBy: USER,
        options: { entities: ['user'] },
        credentialsEncrypted: encryptSecret(JSON.stringify(credentials), keyring),
      });
      await withSystem(app.db, BRAND, (tx) =>
        bindImportSourceAccount(tx, { ...scope, verifiedAccount: `us:${credentials.orgId}` }),
      );
      await owner.db.update(importRuns).set({ status: 'loading' }).where(eq(importRuns.id, runId));
      const claim = await withSystem(app.db, BRAND, (tx) =>
        claimImportRun(tx, { ...scope, phase: 'loading' }),
      );
      if (!claim) throw new Error('Missing Zoho worker claim');
      const deps = { db: app.db, keyring, allowCidrs: [] };
      const transport = {
        apiRoot: fake.root,
        policy: {
          allowedPorts: [Number(new URL(fake.root).port)],
          allowCidrs: ['127.0.0.1/32'],
          lookup: async () => [{ address: '127.0.0.1', family: 4 as const }],
        },
      };
      const first = await createImportConnectorRuntime(deps, transport)(scope);
      const reader = first.connector.extract(first.context, 'user', null)[Symbol.asyncIterator]();
      const firstPage = await reader.next();
      await reader.return?.();
      expect(firstPage.value?.records[0]?.entity).toBe('user');
      const [stored] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      if (!stored?.credentialsEncrypted) throw new Error('Missing encrypted token snapshot');
      const cached = decodedZohoCredentials(
        JSON.parse(decryptSecret(stored.credentialsEncrypted, keyring)),
      );
      if (!cached.accessToken) throw new Error('Missing saved access token');
      expect(cached.credentials).toEqual(credentials);
      expect(stored.credentialsEncrypted).not.toContain(credentials.refreshToken);
      expect(stored.credentialsEncrypted).not.toContain(cached.accessToken.value);
      const restarted = await createImportConnectorRuntime(deps, transport)(scope);
      const resumedReader = restarted.connector
        .extract(restarted.context, 'user', null)
        [Symbol.asyncIterator]();
      expect((await resumedReader.next()).value?.records[0]?.entity).toBe('user');
      await resumedReader.return?.();
      expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(1);
      expect(await withSystem(app.db, BRAND, (tx) => cancelImportRun(tx, scope))).toBe(true);
      await expect(
        saveZohoAccessToken(deps, { claim, credentials, accessToken: cached.accessToken }),
      ).rejects.toBeInstanceOf(ImportClaimLost);
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]
          ?.credentialsEncrypted,
      ).toBeNull();
      await expect(createImportConnectorRuntime(deps, transport)(scope)).rejects.toMatchObject({
        code: 'credentials-refused',
      });
    } finally {
      await fake.close();
    }
  });

  it('consumes staged history through real Redis phase jobs to terminal credential purge', async () => {
    const scenario = await mappedHistoryScenario('queued-history');
    const key = sourceAccountKey({ source: 'zendesk', verifiedAccount: 'demo' });
    const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 14).toString('base64') });
    await owner.db
      .update(importRuns)
      .set({
        sourceAccountKey: key,
        claimToken: null,
        claimedAt: null,
        credentialsEncrypted: encryptSecret(
          JSON.stringify({ auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' }),
          keyring,
        ),
        counts: { retryFailures: 2 },
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
      resolve: createImportConnectorRuntime(
        { db: app.db, keyring, allowCidrs: [] },
        {
          apiRoot: fake.server.root,
          policy: {
            allowedPorts: [Number(new URL(fake.server.root).port)],
            allowCidrs: ['127.0.0.1/32'],
          },
        },
      ),
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
      ).toMatchObject({
        credentialsEncrypted: null,
        claimToken: null,
        counts: { retryFailures: 0 },
      });
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
      await processor(await deliveredJob('import.attachments', run.runId, 'rate-limited-fixture'));
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
      const job = await deliveredJob('import.attachments', run.runId, 'opaque-failure-fixture');
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

  it.each(['loading', 'dry_run'] as const)(
    'recovers expired %s claims once and fences the old worker without touching fresh or paused runs',
    async (phase) => {
      const recoveryBrand = uuidv7();
      await owner.db.insert(brands).values({
        id: recoveryBrand,
        name: 'Recovery',
        prefix: phase === 'dry_run' ? 'RCD' : 'RCR',
      });
      const expired = await boundAccountRun('recovery-expired', recoveryBrand);
      await owner.db
        .update(importRuns)
        .set({ status: phase })
        .where(eq(importRuns.id, expired.runId));
      const claim = await withSystem(app.db, recoveryBrand, (tx) =>
        claimImportRun(tx, { brandId: recoveryBrand, runId: expired.runId, phase }),
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
        await withSystem(app.db, recoveryBrand, (tx) =>
          recoverBrandImports(tx, recoveryBrand, now),
        ),
      ).toBe(1);
      expect(
        await withSystem(app.db, recoveryBrand, (tx) =>
          recoverBrandImports(tx, recoveryBrand, now),
        ),
      ).toBe(0);
      await expect(
        withSystem(app.db, recoveryBrand, (tx) => renewImportClaim(tx, claim)),
      ).rejects.toThrow('import.claim-lost');
      const events = await owner.db.select().from(outbox);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({
        runId: expired.runId,
        step: phase === 'dry_run' ? 'dry_run' : 'load',
      });
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, expired.runId)))[0]
          ?.counts,
      ).toMatchObject({ pendingWorkId: events[0]?.id });
      const replacement = await withSystem(app.db, recoveryBrand, (tx) =>
        claimImportRun(tx, { brandId: recoveryBrand, runId: expired.runId, phase }),
      );
      if (!replacement) throw new Error('Missing replacement recovery claim');
      expect(replacement.token).not.toBe(claim.token);
      expect(
        await withSystem(app.db, recoveryBrand, (tx) =>
          recoverBrandImports(tx, recoveryBrand, new Date(now.getTime() + 61000)),
        ),
      ).toBe(0);
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, paused.runId)))[0]
          ?.status,
      ).toBe('paused');
      await owner.db.delete(outbox).where(sql`${outbox.payload}->>'runId' = ${expired.runId}`);
    },
  );

  describe('recovery and the phase handoff', () => {
    const runEvents = (runId: string) =>
      owner.db
        .select()
        .from(outbox)
        .where(sql`${outbox.payload}->>'runId' = ${runId}`)
        .orderBy(outbox.id);
    const storedCounts = async (runId: string) =>
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.counts;
    const refusingProcessor = () =>
      createImportProcessor({
        db: app.db,
        storage: {} as never,
        resolve: async () => {
          throw new Error('A request without the claim must not reach the vendor');
        },
      });
    const loadJob = (brandId: string, runId: string, workId: string) => ({
      name: 'import.load',
      id: `import.load.${runId}.${workId}`,
      data: { brandId, runId, workId },
    });

    it('leaves a handoff to its queued request and revives the run only once the queue lost it', async () => {
      const brandId = uuidv7();
      await owner.db.insert(brands).values({ id: brandId, name: 'Handoff', prefix: 'HFR' });
      const { runId } = await boundAccountRun('handoff-recovery', brandId);
      const recover = (at: Date) =>
        withSystem(app.db, brandId, (tx) => recoverBrandImports(tx, brandId, at));
      const leaseLater = (from: Date) => new Date(from.getTime() + IMPORT_CLAIM_TIMEOUT_MS + 1000);
      try {
        const claim = await withSystem(app.db, brandId, (tx) =>
          claimImportRun(tx, { brandId, runId, phase: 'loading' }),
        );
        if (!claim) throw new Error('Missing handoff claim');
        await withSystem(app.db, brandId, (tx) => continueImportWork(tx, { claim, step: 'load' }));
        const [handoff] = await runEvents(runId);
        if (!handoff) throw new Error('Missing handoff request');
        const handedOffAt = new Date();

        expect(await recover(handedOffAt)).toBe(0);
        expect(await recover(leaseLater(handedOffAt))).toBe(0);
        await owner.db
          .update(outbox)
          .set({ publishedAt: handedOffAt })
          .where(eq(outbox.id, handoff.id));
        expect(await recover(new Date(handedOffAt.getTime() + 60000))).toBe(0);
        expect(await runEvents(runId)).toHaveLength(1);

        expect(await recover(leaseLater(handedOffAt))).toBe(1);
        const [, revived] = await runEvents(runId);
        if (!revived) throw new Error('Missing recovery request');
        expect(await storedCounts(runId)).toMatchObject({ pendingWorkId: revived.id });

        await refusingProcessor()(loadJob(brandId, runId, handoff.id));
        expect(await runEvents(runId)).toHaveLength(2);
        expect(
          (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0],
        ).toMatchObject({ claimToken: null, counts: { pendingWorkId: revived.id } });
      } finally {
        await owner.db.delete(outbox).where(sql`${outbox.payload}->>'runId' = ${runId}`);
      }
    });

    it('keeps one pending request while a run waits for another run of its brand', async () => {
      const brandId = uuidv7();
      await owner.db.insert(brands).values({ id: brandId, name: 'Busy brand', prefix: 'BSY' });
      const holder = await boundAccountRun('busy-holder', brandId);
      const { runId } = await boundAccountRun('busy-waiting', brandId);
      try {
        const held = await withSystem(app.db, brandId, (tx) =>
          claimImportRun(tx, { brandId, runId: holder.runId, phase: 'loading' }),
        );
        if (!held) throw new Error('Missing holder claim');
        const first = await withSystem(app.db, brandId, (tx) =>
          enqueueImportWork(tx, { brandId, runId, step: 'load' }),
        );
        const processor = refusingProcessor();

        await processor(loadJob(brandId, runId, first));
        const [, retry] = await runEvents(runId);
        if (!retry) throw new Error('Missing busy retry request');
        expect(retry.payload).toMatchObject({ step: 'load', notBefore: expect.any(String) });
        expect(await storedCounts(runId)).toMatchObject({ pendingWorkId: retry.id });

        await processor(loadJob(brandId, runId, first));
        expect(await runEvents(runId)).toHaveLength(2);
        expect(
          await withSystem(app.db, brandId, (tx) =>
            recoverBrandImports(tx, brandId, new Date(Date.now() + 60000)),
          ),
        ).toBe(0);
        expect(await runEvents(runId)).toHaveLength(2);
      } finally {
        await owner.db
          .delete(outbox)
          .where(sql`${outbox.payload}->>'runId' IN (${runId}, ${holder.runId})`);
      }
    });
  });

  it('retries transient vendor outages twice, preserves the budget across 429, then purges credentials on the third outage', async () => {
    const run = await boundAccountRun('vendor-outage-budget');
    await owner.db
      .update(importRuns)
      .set({ credentialsEncrypted: 'synthetic-envelope' })
      .where(eq(importRuns.id, run.runId));
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-outage-'));
    let error: Error = new ConnectorError('vendor-unavailable', 503);
    try {
      const processor = createImportProcessor({
        db: app.db,
        storage: new FakeStorage(dir),
        resolve: async () => {
          throw error;
        },
      });
      const job = () => deliveredJob('import.attachments', run.runId, 'vendor-outage-fixture');
      const expireRetry = async () => {
        const [stored] = await owner.db
          .select()
          .from(importRuns)
          .where(eq(importRuns.id, run.runId));
        const { retryAt: _retryAt, ...counts } = stored?.counts ?? {};
        await owner.db.update(importRuns).set({ counts }).where(eq(importRuns.id, run.runId));
        await owner.db.delete(outbox).where(sql`${outbox.payload}->>'runId' = ${run.runId}`);
      };
      await processor(await job());
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, run.runId)))[0],
      ).toMatchObject({
        status: 'loading',
        credentialsEncrypted: 'synthetic-envelope',
        counts: { retryFailures: 1 },
      });
      await expireRetry();
      error = new RateLimited(60000);
      await processor(await job());
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, run.runId)))[0]?.counts
          .retryFailures,
      ).toBe(1);
      await expireRetry();
      error = new ConnectorError('vendor-unavailable', 503);
      await processor(await job());
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, run.runId)))[0]?.counts
          .retryFailures,
      ).toBe(2);
      await expireRetry();
      await processor(await job());
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, run.runId)))[0],
      ).toMatchObject({
        status: 'failed',
        error: 'vendor-unavailable',
        credentialsEncrypted: null,
        counts: { retryFailures: 3 },
      });
      expect(
        (await owner.db.select().from(importLog).where(eq(importLog.runId, run.runId))).map(
          (row) => row.level,
        ),
      ).toEqual(['warning', 'warning', 'warning', 'error']);
      expect(await owner.db.select().from(outbox)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unrepresentable vendor retry deadline without leaving credentials or a held claim', async () => {
    const run = await boundAccountRun('invalid-vendor-delay');
    await owner.db
      .update(importRuns)
      .set({ credentialsEncrypted: 'synthetic-envelope' })
      .where(eq(importRuns.id, run.runId));
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-delay-'));
    try {
      const processor = createImportProcessor({
        db: app.db,
        storage: new FakeStorage(dir),
        resolve: async () => {
          throw new RateLimited(Number.MAX_SAFE_INTEGER);
        },
      });
      await processor(await deliveredJob('import.attachments', run.runId, 'invalid-delay-fixture'));
      expect(
        (await owner.db.select().from(importRuns).where(eq(importRuns.id, run.runId)))[0],
      ).toMatchObject({
        status: 'failed',
        error: 'invalid-response',
        credentialsEncrypted: null,
        claimToken: null,
      });
      expect(await owner.db.select().from(outbox)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    return { claim, ticketId: loaded.ticketId, runId, brandId, input };
  }

  it.each([
    'foreign-account',
    'foreign-brand',
    'foreign-vendor',
    'deleted-ticket',
    'missing-answer',
    'stale-claim',
    'bundled-parent',
  ] as const)(
    'refuses an independent satisfaction delta with %s without advancing its checkpoint',
    async (failure) => {
      const scenario = await stagedTicketScenario(`csat-denied-${failure}`);
      const first = await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
      await owner.db
        .update(importRuns)
        .set({ status: 'completed', claimToken: null, claimedAt: null })
        .where(eq(importRuns.id, scenario.claim.runId));
      const runId = uuidv7();
      const brandId = failure === 'foreign-brand' ? OTHER_BRAND : BRAND;
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId,
        source: failure === 'foreign-vendor' ? 'freshdesk' : 'zendesk',
        sourceAccountKey: failure === 'foreign-account' ? 'a'.repeat(64) : '0'.repeat(64),
        status: 'loading',
        startedBy: USER,
      });
      const original = scenario.input.csat[0];
      if (!original) throw new Error('Missing rejected rating fixture');
      const rating = { ...original, rating: 1 };
      const recordId = uuidv7();
      await owner.db.insert(importRecords).values({
        id: recordId,
        brandId,
        runId,
        entity: 'csat',
        externalId: rating.externalId,
        parentExternalId: rating.ticketExternalId,
        payload: rating,
        payloadHash: hashImportValue(rating),
      });
      if (failure === 'deleted-ticket')
        await owner.db
          .update(tickets)
          .set({ deletedAt: new Date() })
          .where(eq(tickets.id, first.ticketId));
      if (failure === 'missing-answer')
        await owner.db.delete(csatResponses).where(eq(csatResponses.ticketId, first.ticketId));
      if (failure === 'bundled-parent')
        await owner.db.insert(importRecords).values({
          brandId,
          runId,
          entity: 'ticket',
          externalId: scenario.input.record.externalId,
          payload: scenario.input.record,
          payloadHash: hashImportValue(scenario.input.record),
          status: 'loaded',
          helpdockId: first.ticketId,
        });
      const claim = await withSystem(app.db, brandId, (tx) =>
        claimImportRun(tx, { brandId, runId, phase: 'loading' }),
      );
      if (!claim) throw new Error('Missing rejected delta claim');
      if (failure === 'stale-claim')
        await owner.db
          .update(importRuns)
          .set({ status: 'paused', pausedFrom: 'loading', claimToken: null, claimedAt: null })
          .where(eq(importRuns.id, runId));
      if (
        ['foreign-account', 'foreign-brand', 'foreign-vendor', 'deleted-ticket'].includes(failure)
      ) {
        expect(
          await withSystem(app.db, brandId, (tx) =>
            validateImportReferences(
              tx,
              { brandId, runId, source: failure === 'foreign-vendor' ? 'freshdesk' : 'zendesk' },
              { entity: 'csat', payload: rating },
            ),
          ),
        ).not.toEqual([]);
      }
      const pending = runImportLoadBatch(
        { db: app.db, jobId: `rejected-${failure}` },
        { claim, batchSize: 1 },
      );
      if (failure === 'stale-claim')
        await expect(pending).resolves.toMatchObject({ state: 'stopped', processed: 0 });
      else
        await expect(pending).rejects.toMatchObject({
          code: failure === 'bundled-parent' ? 'mapping-invalid' : 'target-unavailable',
        });
      expect(
        (await owner.db.select().from(importRecords).where(eq(importRecords.id, recordId)))[0],
      ).toMatchObject({ status: 'staged', helpdockId: null });
      expect(
        await owner.db
          .select()
          .from(csatResponses)
          .where(eq(csatResponses.ticketId, first.ticketId)),
      ).toHaveLength(failure === 'missing-answer' ? 0 : 1);
    },
  );

  it('loads a rescanned satisfaction delta without a staged parent and later reapplies a reverted answer', async () => {
    const scenario = await stagedTicketScenario('csat-only-delta');
    const first = await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
    await owner.db
      .update(importRuns)
      .set({ status: 'completed', claimToken: null, claimedAt: null })
      .where(eq(importRuns.id, scenario.claim.runId));
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      mode: 'delta',
      parentRunId: scenario.claim.runId,
      status: 'loading',
      startedBy: USER,
      options: { rebuildAllReports: true },
    });
    const original = scenario.input.csat[0];
    if (!original) throw new Error('Missing rating fixture');
    const rating = { ...original, rating: 1, comment: 'Corrected historical answer' };
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId,
      entity: 'csat',
      externalId: rating.externalId,
      parentExternalId: rating.ticketExternalId,
      payload: rating,
      payloadHash: hashImportValue(rating),
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'loading' }),
    );
    if (!claim) throw new Error('Missing CSAT delta claim');
    const [stagedAnswer] = await owner.db
      .select()
      .from(importRecords)
      .where(and(eq(importRecords.runId, runId), eq(importRecords.entity, 'csat')));
    if (!stagedAnswer) throw new Error('Missing staged answer');
    const parentReceipts = () =>
      owner.db
        .select({ hash: importExternalIds.payloadHash })
        .from(importExternalIds)
        .where(
          and(
            eq(importExternalIds.brandId, BRAND),
            eq(importExternalIds.entity, 'ticket'),
            eq(importExternalIds.helpdockId, first.ticketId),
          ),
        );
    const receiptBefore = await parentReceipts();
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await loadStagedCsat(tx, { claim, recordId: stagedAnswer.id });
        throw new Error('CSAT worker stopped before commit');
      }),
    ).rejects.toThrow('CSAT worker stopped before commit');
    expect(await parentReceipts()).toEqual(receiptBefore);
    expect(
      (await owner.db.select().from(importRecords).where(eq(importRecords.id, stagedAnswer.id)))[0],
    ).toMatchObject({ status: 'staged', helpdockId: null });
    expect(
      await owner.db.select().from(csatResponses).where(eq(csatResponses.ticketId, first.ticketId)),
    ).toMatchObject([{ rating: original.rating, comment: null }]);
    const ticketRevision = () =>
      owner.db.execute(
        sql`SELECT xmin::text AS revision FROM tickets WHERE id = ${first.ticketId}`,
      );
    const before = await ticketRevision();
    expect(
      await runImportLoadBatch({ db: app.db, jobId: 'csat-only-delta' }, { claim, batchSize: 1 }),
    ).toMatchObject({ state: 'more', processed: 1 });
    expect(
      await owner.db.select().from(csatResponses).where(eq(csatResponses.ticketId, first.ticketId)),
    ).toMatchObject([
      { rating: 1, comment: 'Corrected historical answer', ratedAt: new Date(original.ratedAt) },
    ]);
    const [checkpoint] = await owner.db
      .select()
      .from(importRecords)
      .where(and(eq(importRecords.runId, runId), eq(importRecords.entity, 'csat')));
    if (!checkpoint) throw new Error('Missing answer checkpoint');
    const answerRevisions = () =>
      owner.db.execute(
        sql`SELECT id,xmin::text AS revision FROM csat_responses WHERE ticket_id=${first.ticketId}`,
      );
    const answerBefore = await answerRevisions();
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        loadStagedCsat(tx, { claim, recordId: checkpoint.id }),
      ),
    ).toMatchObject({ state: 'already_loaded' });
    expect(await answerRevisions()).toEqual(answerBefore);
    await expect(
      withSystem(app.db, BRAND, async (tx) => {
        await tx.delete(csatResponses).where(eq(csatResponses.ticketId, first.ticketId));
        return loadStagedCsat(tx, { claim, recordId: checkpoint.id });
      }),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    expect(await answerRevisions()).toEqual(answerBefore);
    expect(await ticketRevision()).toEqual(before);
    await owner.db
      .update(importRuns)
      .set({ status: 'finishing', claimToken: null, claimedAt: null })
      .where(eq(importRuns.id, runId));
    const finishing = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'finishing' }),
    );
    if (!finishing) throw new Error('Missing CSAT finish claim');
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        rebuildImportReportsBatch(tx, finishing, new Date('2019-03-05T12:00:00Z')),
      ),
    ).toMatchObject({ state: 'more', progress: { from: '2019-01-01' } });
    const restoredRunId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: restoredRunId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'loading',
      startedBy: USER,
    });
    expect(
      await withSystem(app.db, BRAND, (tx) =>
        writer.ticket(tx, { ...scenario.input, runId: restoredRunId }),
      ),
    ).toMatchObject({ outcome: 'updated' });
    expect(
      await owner.db.select().from(csatResponses).where(eq(csatResponses.ticketId, first.ticketId)),
    ).toMatchObject([{ rating: original.rating, comment: null }]);
  });

  it.each(['unchanged', 'changed'] as const)(
    '%s repeated import rebuilds reports only when history changes',
    async (change) => {
      const scenario = await historicalReportScenario(change === 'changed' ? 'XPC' : 'XPU');
      const now = new Date('2019-03-05T12:00:00Z');
      while (
        (
          await withSystem(app.db, scenario.brandId, (tx) =>
            rebuildImportReportsBatch(tx, scenario.claim, now),
          )
        ).state === 'more'
      ) {}
      const revisions = () =>
        owner.db.execute(sql`
      SELECT day, xmin::text AS revision FROM report_daily
      WHERE brand_id = ${scenario.brandId} ORDER BY day
    `);
      const before = await revisions();
      expect(before.length).toBeGreaterThan(0);
      const runId = uuidv7();
      await owner.db.insert(importRuns).values({
        id: runId,
        brandId: scenario.brandId,
        source: 'zendesk',
        status: 'loading',
        startedBy: USER,
        options: { rebuildAllReports: true },
      });
      const input = {
        ...scenario.input,
        runId,
        record: {
          ...scenario.input.record,
          ...(change === 'changed' ? { subject: 'Corrected historical subject' } : {}),
        },
      };
      const recordId = uuidv7();
      await owner.db.insert(importRecords).values([
        {
          id: recordId,
          brandId: scenario.brandId,
          runId,
          entity: 'ticket',
          externalId: input.record.externalId,
          payload: input.record,
          payloadHash: hashImportValue(input.record),
        },
        ...input.messages.map((message) => ({
          brandId: scenario.brandId,
          runId,
          entity: 'message' as const,
          externalId: message.externalId,
          parentExternalId: input.record.externalId,
          payload: message,
          payloadHash: hashImportValue(message),
        })),
      ]);
      const claim = await withSystem(app.db, scenario.brandId, (tx) =>
        claimImportRun(tx, { brandId: scenario.brandId, runId, phase: 'loading' }),
      );
      if (!claim) throw new Error('Missing repeat loading claim');
      expect(
        await withSystem(app.db, scenario.brandId, (tx) =>
          loadStagedTicket(tx, { claim, recordId, input }),
        ),
      ).toMatchObject({ outcome: change === 'changed' ? 'updated' : 'unchanged' });
      await owner.db
        .update(importRuns)
        .set({ status: 'finishing', claimToken: null, claimedAt: null })
        .where(eq(importRuns.id, runId));
      const finishing = await withSystem(app.db, scenario.brandId, (tx) =>
        claimImportRun(tx, { brandId: scenario.brandId, runId, phase: 'finishing' }),
      );
      if (!finishing) throw new Error('Missing repeat finish claim');
      const reports = await withSystem(app.db, scenario.brandId, (tx) =>
        rebuildImportReportsBatch(tx, finishing, now),
      );
      if (change === 'changed') {
        expect(reports).toMatchObject({ state: 'more', progress: { from: '2019-01-01' } });
        expect(await revisions()).not.toEqual(before);
      } else {
        expect(reports).toMatchObject({
          state: 'reports_complete',
          progress: { from: null, next: null },
        });
        expect(await revisions()).toEqual(before);
      }
    },
  );

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

  it('pages imported article targets and reindexes published en/ar versions without scheduling embeddings', async () => {
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
    expect(embeddings).toBe(0);
    await deliver();
    expect(embeddings).toBe(0);
    expect(
      await owner.db
        .select()
        .from(hcSearchDocuments)
        .where(eq(hcSearchDocuments.articleId, original.id)),
    ).toEqual(indexed);
    await setEmbeddingDims(owner.db, 3);
    await updateEmbeddingSpace(owner.db, {
      status: 'reindexing',
      targetProvider: 'openai-compatible',
      targetModel: 'migration-model',
      targetDims: 3,
      columnDims: 3,
    });
    const providerInputs: string[][] = [];
    const ai: Pick<Ai, 'embed'> = {
      embed: async ({ texts }) => {
        providerInputs.push([...texts]);
        return { vectors: texts.map(() => [1, 0, 0]), model: 'migration-model', dims: 3 };
      },
    };
    try {
      expect(
        await embedPending({ db: app.db, ai, brandId: BRAND, jobId: 'stale-import-embedding' }),
      ).toBe(0);
      expect(await reembedChunks({ db: app.db, ai, jobId: 'stale-import-reembedding' })).toEqual({
        embedded: 0,
        ready: true,
      });
      expect(providerInputs).toEqual([]);
      const repository = new HelpCenterRepository();
      await withSystem(app.db, BRAND, async (tx) => {
        const version = await repository.version(tx, original.id, 'en');
        if (!version) throw new Error('Missing imported English version');
        expect(version.importEmbeddingDeferred).toBe(true);
        await publishVersion(tx, repository, {
          version,
          actor: { type: 'staff', id: USER },
          now: new Date('2026-10-18T00:00:00Z'),
        });
      });
      const [publication] = await owner.db
        .select()
        .from(outbox)
        .where(eq(outbox.event, 'help_center.article_changed'));
      if (!publication) throw new Error('Missing explicit publication');
      const handler = createArticleKnowledgeHandlers({
        addEmbed: async () => {
          embeddings++;
        },
      }).article;
      await withSystem(app.db, BRAND, (tx) =>
        handler({
          tx,
          brandId: BRAND,
          event: publication.event,
          payload: publication.payload,
          outboxId: publication.id,
          log: silentJobLogger,
        }),
      );
      expect(embeddings).toBe(1);
      expect(
        await embedPending({ db: app.db, ai, brandId: BRAND, jobId: 'explicit-staff-publication' }),
      ).toBeGreaterThan(0);
      expect(providerInputs).toHaveLength(1);
      const versions = await owner.db
        .select()
        .from(hcArticleVersions)
        .where(eq(hcArticleVersions.articleId, original.id));
      expect(versions.find((version) => version.locale === 'en')?.importEmbeddingDeferred).toBe(
        false,
      );
      expect(versions.find((version) => version.locale === 'ar')?.importEmbeddingDeferred).toBe(
        true,
      );
      const [source] = await owner.db
        .select()
        .from(importRecords)
        .where(
          and(
            eq(importRecords.runId, scenario.runId),
            eq(importRecords.externalId, 'published-completion-primary'),
          ),
        );
      if (!source) throw new Error('Missing imported English source');
      const native = importRecordSchema.parse({ entity: source.entity, payload: source.payload });
      if (native.entity !== 'article') throw new Error('Expected imported article');
      const repeatRunId = uuidv7();
      await owner.db.insert(importRuns).values({
        id: repeatRunId,
        brandId: BRAND,
        source: 'zendesk',
        status: 'loading',
        startedBy: USER,
      });
      const repeat = {
        brandId: BRAND,
        runId: repeatRunId,
        source: 'zendesk' as const,
        record: native.payload,
        preparedBodyHtml: native.payload.bodyHtml,
      };
      expect(await withSystem(app.db, BRAND, (tx) => writer.article(tx, repeat))).toMatchObject({
        outcome: 'unchanged',
      });
      expect(
        (await withSystem(app.db, BRAND, (tx) => repository.version(tx, original.id, 'en')))
          ?.importEmbeddingDeferred,
      ).toBe(false);
      expect(
        await withSystem(app.db, BRAND, (tx) =>
          writer.article(tx, {
            ...repeat,
            record: { ...native.payload, title: 'Changed source publication' },
          }),
        ),
      ).toMatchObject({ outcome: 'updated' });
      expect(
        (await withSystem(app.db, BRAND, (tx) => repository.version(tx, original.id, 'en')))
          ?.importEmbeddingDeferred,
      ).toBe(true);
      expect(
        await embedPending({ db: app.db, ai, brandId: BRAND, jobId: 'changed-source-embedding' }),
      ).toBe(0);
      expect(providerInputs).toHaveLength(1);
    } finally {
      await updateEmbeddingSpace(owner.db, {
        status: 'unconfigured',
        activeModel: null,
        activeDims: null,
        targetProvider: null,
        targetModel: null,
        targetDims: null,
        startedAt: null,
        finishedAt: null,
        lastError: null,
      });
    }
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
        parentExternalId: importRecordParent(record),
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
    await withSystem(app.db, BRAND, async (tx) => {
      await writer.category(
        tx,
        categoryLoadSchema.parse({
          ...scope,
          record: { externalId: 'kb-category', names: { en: 'Knowledge' } },
        }),
      );
      await writer.section(
        tx,
        sectionLoadSchema.parse({
          ...scope,
          record: {
            externalId: 'kb-section',
            parentExternalId: 'kb-category',
            names: { en: 'Answers' },
          },
        }),
      );
    });
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
      `/api/help-center/brands/${BRAND}/media/${'-'.repeat(36)}`,
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
    await owner.db.insert(contactIdentities).values({
      brandId: BRAND,
      contactId: CONTACT,
      kind: 'email',
      value: 'local@example.com',
      verified: true,
      source: 'agent',
    });
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

  it('previews chronological ticket history, notes, source authors and file metadata without URLs or writes', async () => {
    const scenario = await stagedTicketScenario(
      'preview-history',
      'https://vendor.example/file?token=secret-file',
    );
    const root = {
      ...scenario.input.record,
      sourceUrl: 'https://vendor.example/tickets/42?token=secret-root',
    };
    await owner.db
      .update(importRecords)
      .set({ payload: root, payloadHash: hashImportValue(root) })
      .where(eq(importRecords.id, scenario.recordId));
    const agent = {
      externalId: 'oldagent',
      kind: 'agent',
      name: 'Historical agent',
      active: false,
    };
    const contact = {
      externalId: 'customer',
      name: 'Historical customer',
      emails: [],
      phones: [],
      custom: {},
    };
    await owner.db.insert(importRecords).values([
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        entity: 'user',
        externalId: agent.externalId,
        payload: agent,
        payloadHash: hashImportValue(agent),
      },
      {
        brandId: BRAND,
        runId: scenario.input.runId,
        entity: 'contact',
        externalId: contact.externalId,
        payload: contact,
        payloadHash: hashImportValue(contact),
      },
    ]);
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM import_records WHERE run_id = ${scenario.input.runId} ORDER BY id`,
    );
    const ticketRevisions = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM tickets ORDER BY id`,
    );
    const scope = {
      brandId: BRAND,
      runId: scenario.input.runId,
      externalId: root.externalId,
      limit: 1,
    };
    const first = await withSystem(app.db, BRAND, (tx) => previewImportedTicket(tx, scope));
    expect(first).toMatchObject({
      ticket: { number: '900', subject: 'Original ticket' },
      messageCount: 2,
      nextOffset: 1,
      messages: [
        {
          externalId: 'm-preview-history-1',
          sourceAuthorName: 'Historical customer',
          public: true,
          createdAt: '2019-01-01T00:00:00Z',
          bodyText: 'Hello',
        },
      ],
    });
    expect(JSON.stringify(first)).not.toMatch(/tracker\.invalid|secret-root|<script\b/i);
    const second = await withSystem(app.db, BRAND, (tx) =>
      previewImportedTicket(tx, { ...scope, offset: 1 }),
    );
    expect(second).toMatchObject({
      messageCount: 2,
      nextOffset: null,
      messages: [
        {
          sourceAuthorName: 'Historical agent',
          public: false,
          bodyText: 'Private note',
          attachments: [{ fileName: 'history.pdf', contentType: 'application/pdf' }],
        },
      ],
    });
    expect(JSON.stringify(second)).not.toContain('secret-file');
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM import_records WHERE run_id = ${scenario.input.runId} ORDER BY id`,
      ),
    ).toEqual(before);
    expect(
      await owner.db.execute(sql`SELECT id, xmin::text AS revision FROM tickets ORDER BY id`),
    ).toEqual(ticketRevisions);
    await expect(
      withSystem(app.db, OTHER_BRAND, (tx) =>
        previewImportedTicket(tx, { ...scope, brandId: OTHER_BRAND }),
      ),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
    await withSystem(app.db, BRAND, (tx) =>
      pauseImportRun(tx, { brandId: BRAND, runId: scenario.input.runId }),
    );
    expect(await withSystem(app.db, BRAND, (tx) => previewImportedTicket(tx, scope))).toEqual(
      first,
    );
    await withSystem(app.db, BRAND, (tx) =>
      resumeImportRun(tx, { brandId: BRAND, runId: scenario.input.runId }),
    );
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, scenario.input));
    const stored = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, loaded.ticketId))
      .orderBy(ticketMessages.seq);
    expect(
      stored.map((message) => ({
        bodyHtml: message.bodyHtml,
        bodyText: message.bodyText,
        public: message.kind === 'public',
        createdAt: message.createdAt.toISOString(),
      })),
    ).toEqual(
      [...first.messages, ...second.messages].map((message) => ({
        bodyHtml: message.bodyHtml,
        bodyText: message.bodyText,
        public: message.public,
        createdAt: new Date(message.createdAt).toISOString(),
      })),
    );
  });

  it('keeps oversized preview messages complete while continuing later history on another page', async () => {
    const scenario = await stagedTicketScenario('large-preview');
    const message = scenario.input.messages.find((message) => message.public);
    if (!message) throw new Error('Missing public preview message');
    const { bodyHtml: _html, ...source } = message;
    const bodyText = '<'.repeat(1024 * 1024);
    const payload = { ...source, bodyText };
    await owner.db
      .update(importRecords)
      .set({ payload, payloadHash: hashImportValue(payload) })
      .where(
        and(
          eq(importRecords.runId, scenario.input.runId),
          eq(importRecords.entity, 'message'),
          eq(importRecords.externalId, message.externalId),
        ),
      );
    const scope = {
      brandId: BRAND,
      runId: scenario.input.runId,
      externalId: scenario.input.record.externalId,
      limit: 50,
    };
    const first = await withSystem(app.db, BRAND, (tx) => previewImportedTicket(tx, scope));
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]?.bodyText).toBe(bodyText);
    expect(Buffer.byteLength(JSON.stringify(first.messages))).toBeGreaterThan(4 * 1024 * 1024);
    expect(first.nextOffset).toBe(1);
    const second = await withSystem(app.db, BRAND, (tx) =>
      previewImportedTicket(tx, { ...scope, offset: 1 }),
    );
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.public).toBe(false);
    expect(second.nextOffset).toBeNull();
    expect(
      (await withSystem(app.db, BRAND, (tx) => previewImportedTicket(tx, { ...scope, offset: 2 })))
        .messages,
    ).toEqual([]);
  });

  it('blocks missing required ticket values in preflight just as the loader does', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    const departmentId = uuidv7();
    const statusId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Required ticket preflight', prefix: 'RTV' });
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
    const input = request('required-value-preflight');
    input.brandId = brandId;
    input.runId = runId;
    input.messages = [];
    input.authors = {};
    input.resolved = {
      ...input.resolved,
      departmentId,
      statusId,
      assigneeId: null,
      contactId: null,
    };
    await owner.db.insert(customFieldDefs).values({
      brandId,
      target: 'ticket',
      key: 'required_reference',
      label: 'Reference',
      type: 'text',
      required: true,
    });
    await owner.db.insert(importRecords).values({
      brandId,
      runId,
      entity: 'ticket',
      externalId: input.record.externalId,
      payload: input.record,
      payloadHash: hashImportValue(input.record),
    });
    const mappings = [
      { kind: 'status', externalValue: 'open', target: { statusId } },
      { kind: 'group', externalValue: '', target: { departmentId, teamId: null } },
      { kind: 'priority', externalValue: '', target: { priority: 'high' } },
      { kind: 'channel', externalValue: '', target: { channel: 'email' } },
    ].map((mapping) => importMappingSchema.parse(mapping));
    await owner.db
      .insert(importMappings)
      .values(mappings.map((mapping) => ({ brandId, runId, ...mapping })));
    await expect(
      withSystem(app.db, brandId, (tx) => writer.ticket(tx, input)),
    ).rejects.toMatchObject({ name: 'ZodError' });
    const preview = await withSystem(app.db, brandId, (tx) =>
      validateImportRecordPage(tx, { brandId, runId, source: 'zendesk' }),
    );
    expect(preview.issues).toEqual([
      { entity: 'ticket', externalId: input.record.externalId, code: 'mapping-invalid' },
    ]);
    expect(preview.issueCount).toBe(1);
    expect(await owner.db.select().from(tickets).where(eq(tickets.brandId, brandId))).toEqual([]);
    expect(await owner.db.select().from(outbox).where(eq(outbox.brandId, brandId))).toEqual([]);
  });

  it.each([
    { entity: 'category', scenario: 'cycle', code: 'reference-cycle' },
    { entity: 'category', scenario: 'alias-self', code: 'reference-cycle' },
    { entity: 'section', scenario: 'alias-self', code: 'reference-cycle' },
    { entity: 'section', scenario: 'cycle', code: 'reference-cycle' },
    { entity: 'section', scenario: 'category-mismatch', code: 'reference-parent-mismatch' },
    { entity: 'section', scenario: 'missing-target', code: 'reference-invalid' },
    { entity: 'category', scenario: 'missing-ancestor', code: 'reference-missing' },
    { entity: 'category', scenario: 'foreign-account', code: 'reference-missing' },
    { entity: 'category', scenario: 'staged-override', code: null },
    { entity: 'section', scenario: 'staged-override', code: null },
    { entity: 'section', scenario: 'staged-category-alias', code: null },
  ] as const)(
    'checks $entity $scenario across staged and existing knowledge without preflight writes',
    async ({ entity, scenario, code }) => {
      const bound = await boundAccountRun(`mixed-${entity}-${scenario}`);
      const scope = { brandId: BRAND, runId: bound.runId, source: 'zendesk' as const };
      const categoryId = uuidv7();
      const otherCategoryId = uuidv7();
      const rootId = entity === 'category' ? categoryId : uuidv7();
      const parentId = scenario === 'alias-self' ? rootId : uuidv7();
      const prefix = `mixed-${entity}-${scenario}`;
      await owner.db.insert(hcCategories).values([
        { id: categoryId, brandId: BRAND, slug: `${prefix}-root`, names: { en: 'Root' } },
        { id: otherCategoryId, brandId: BRAND, slug: `${prefix}-other`, names: { en: 'Other' } },
        ...(entity === 'category' && scenario !== 'alias-self'
          ? [
              {
                id: parentId,
                brandId: BRAND,
                slug: `${prefix}-parent`,
                names: { en: 'Parent' },
                importedParentExternalId: scenario === 'missing-ancestor' ? 'missing' : 'root',
              },
            ]
          : []),
      ]);
      if (entity === 'section')
        await owner.db.insert(hcSections).values([
          {
            id: rootId,
            brandId: BRAND,
            categoryId,
            slug: `${prefix}-root-section`,
            names: { en: 'Root' },
          },
          ...(scenario === 'missing-target' || scenario === 'alias-self'
            ? []
            : [
                {
                  id: parentId,
                  brandId: BRAND,
                  categoryId: scenario === 'category-mismatch' ? otherCategoryId : categoryId,
                  slug: `${prefix}-parent-section`,
                  names: { en: 'Parent' },
                  importedParentSectionExternalId: [
                    'cycle',
                    'staged-override',
                    'staged-category-alias',
                  ].includes(scenario)
                    ? 'root'
                    : null,
                },
              ]),
        ]);
      await owner.db.insert(importExternalIds).values(
        [
          { entity, externalId: 'root', helpdockId: rootId },
          { entity, externalId: 'parent', helpdockId: parentId },
          ...(entity === 'section'
            ? [
                { entity: 'category' as const, externalId: 'category', helpdockId: categoryId },
                ...(scenario === 'staged-category-alias'
                  ? [
                      {
                        entity: 'category' as const,
                        externalId: 'category-alias',
                        helpdockId: categoryId,
                      },
                    ]
                  : []),
              ]
            : []),
        ].map((identity) => ({
          ...identity,
          brandId: BRAND,
          source: 'zendesk' as const,
          sourceAccountKey:
            scenario === 'foreign-account' && identity.externalId === 'parent'
              ? 'f'.repeat(64)
              : bound.key,
          payloadHash: 'a'.repeat(64),
        })),
      );
      const native = importRecordSchema.parse(
        entity === 'category'
          ? {
              entity,
              payload: { externalId: 'root', parentExternalId: 'parent', names: { en: 'Root' } },
            }
          : {
              entity,
              payload: {
                externalId: 'root',
                parentExternalId: 'category',
                parentSectionExternalId: 'parent',
                names: { en: 'Root' },
              },
            },
      );
      await owner.db.insert(importRecords).values({
        brandId: BRAND,
        runId: bound.runId,
        entity,
        externalId: 'root',
        parentExternalId: importRecordParent(native),
        payload: native.payload,
        payloadHash: hashImportValue(native.payload),
      });
      const override =
        code === null
          ? importRecordSchema.parse(
              entity === 'category'
                ? { entity, payload: { externalId: 'parent', names: { en: 'Parent' } } }
                : {
                    entity,
                    payload: {
                      externalId: 'parent',
                      parentExternalId:
                        scenario === 'staged-category-alias' ? 'category-alias' : 'category',
                      names: { en: 'Parent' },
                    },
                  },
            )
          : null;
      if (override)
        await owner.db.insert(importRecords).values({
          brandId: BRAND,
          runId: bound.runId,
          entity,
          externalId: 'parent',
          parentExternalId: importRecordParent(override),
          payload: override.payload,
          payloadHash: hashImportValue(override.payload),
        });
      const before = await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM hc_categories WHERE brand_id = ${BRAND} ORDER BY id`,
      );
      const sectionsBefore = await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM hc_sections WHERE brand_id = ${BRAND} ORDER BY id`,
      );
      const issues = await withSystem(app.db, BRAND, (tx) =>
        validateImportReferences(tx, scope, native),
      );
      if (code) expect(issues).toMatchObject([{ code }]);
      else expect(issues).toEqual([]);
      expect(
        await withSystem(app.db, BRAND, (tx) => validateImportRecordPage(tx, scope)),
      ).toMatchObject({
        checked: override ? 2 : 1,
        issueCount: code ? 1 : 0,
        issues: code ? [{ entity, externalId: 'root', code }] : [],
      });
      if (scenario === 'alias-self')
        await expect(
          withSystem(app.db, BRAND, (tx) =>
            entity === 'category'
              ? writer.category(tx, categoryLoadSchema.parse({ ...scope, record: native.payload }))
              : writer.section(tx, sectionLoadSchema.parse({ ...scope, record: native.payload })),
          ),
        ).rejects.toMatchObject({ code: 'mapping-invalid' });

      expect(
        await owner.db.execute(
          sql`SELECT id, xmin::text AS revision FROM hc_categories WHERE brand_id = ${BRAND} ORDER BY id`,
        ),
      ).toEqual(before);
      expect(
        await owner.db.execute(
          sql`SELECT id, xmin::text AS revision FROM hc_sections WHERE brand_id = ${BRAND} ORDER BY id`,
        ),
      ).toEqual(sectionsBefore);
      if (override) {
        for (const source of [override, native])
          await withSystem(app.db, BRAND, (tx) =>
            entity === 'category'
              ? writer.category(tx, categoryLoadSchema.parse({ ...scope, record: source.payload }))
              : writer.section(tx, sectionLoadSchema.parse({ ...scope, record: source.payload })),
          );
      }
      expect(await owner.db.select().from(outbox)).toEqual([]);
    },
  );

  it.each([
    { scenario: 'wrong-section', code: 'reference-parent-mismatch' },
    { scenario: 'missing-target', code: 'reference-invalid' },
    { scenario: 'redirected-identity', code: 'reference-invalid' },
    { scenario: 'occupied-locale', code: 'reference-invalid' },
    { scenario: 'new-translation', code: null },
    { scenario: 'existing-translation', code: null },
    { scenario: 'staged-different-locale', code: null },
    { scenario: 'staged-locale-duplicate', code: 'reference-invalid' },
  ] as const)(
    'checks mixed article translation $scenario without overwriting unrelated history',
    async ({ scenario, code }) => {
      const bound = await boundAccountRun(`mixed-article-${scenario}`);
      const scope = { brandId: BRAND, runId: bound.runId, source: 'zendesk' as const };
      const categoryId = uuidv7();
      const sectionId = uuidv7();
      const otherSectionId = uuidv7();
      const articleId = uuidv7();
      const redirectedId = uuidv7();
      const prefix = `mixed-article-${scenario}`;
      await owner.db.insert(hcCategories).values({
        id: categoryId,
        brandId: BRAND,
        slug: `${prefix}-category`,
        names: { en: 'Docs' },
      });
      await owner.db.insert(hcSections).values([
        {
          id: sectionId,
          brandId: BRAND,
          categoryId,
          slug: `${prefix}-section`,
          names: { en: 'Section' },
        },
        {
          id: otherSectionId,
          brandId: BRAND,
          categoryId,
          slug: `${prefix}-other`,
          names: { en: 'Other' },
        },
      ]);
      if (scenario !== 'missing-target') {
        await owner.db.insert(hcArticles).values({
          id: articleId,
          brandId: BRAND,
          sectionId: scenario === 'wrong-section' ? otherSectionId : sectionId,
          slug: `${prefix}-primary`,
        });
        await owner.db.insert(hcArticleVersions).values({
          brandId: BRAND,
          articleId,
          locale: 'en',
          title: 'English',
          bodyHtml: '<p>Existing English</p>',
        });
        if (scenario === 'occupied-locale' || scenario === 'existing-translation')
          await owner.db.insert(hcArticleVersions).values({
            brandId: BRAND,
            articleId,
            locale: 'ar',
            title: 'العربية',
            bodyHtml: '<p>Existing Arabic</p>',
          });
      }
      if (scenario === 'redirected-identity')
        await owner.db
          .insert(hcArticles)
          .values({ id: redirectedId, brandId: BRAND, sectionId, slug: `${prefix}-redirected` });
      await owner.db.insert(importExternalIds).values(
        [
          { entity: 'section' as const, externalId: 'section', helpdockId: sectionId },
          { entity: 'article' as const, externalId: 'primary', helpdockId: articleId },
          ...(['redirected-identity', 'existing-translation'].includes(scenario)
            ? [
                {
                  entity: 'article' as const,
                  externalId: 'translation',
                  helpdockId: scenario === 'redirected-identity' ? redirectedId : articleId,
                },
              ]
            : []),
        ].map((identity) => ({
          ...identity,
          brandId: BRAND,
          source: 'zendesk' as const,
          sourceAccountKey: bound.key,
          payloadHash: 'a'.repeat(64),
        })),
      );
      const native = {
        entity: 'article' as const,
        payload: importArticleSchema.parse({
          externalId: 'translation',
          sectionExternalId: 'section',
          translationOf: 'primary',
          locale: 'ar',
          title: 'العنوان',
          bodyHtml: '<p>Imported Arabic</p>',
          draft: true,
          internal: true,
          createdAt: '2019-01-01T00:00:00Z',
          updatedAt: '2019-01-02T00:00:00Z',
        }),
      };
      await owner.db.insert(importRecords).values({
        brandId: BRAND,
        runId: bound.runId,
        entity: 'article',
        externalId: native.payload.externalId,
        parentExternalId: importRecordParent(native),
        payload: native.payload,
        payloadHash: hashImportValue(native.payload),
      });
      if (scenario === 'staged-different-locale' || scenario === 'staged-locale-duplicate') {
        const primary = {
          ...native.payload,
          externalId: 'primary',
          translationOf: undefined,
          locale: scenario === 'staged-locale-duplicate' ? ('ar' as const) : ('en' as const),
        };
        const { translationOf: _translation, ...source } = primary;
        await owner.db.insert(importRecords).values({
          brandId: BRAND,
          runId: bound.runId,
          entity: 'article',
          externalId: 'primary',
          parentExternalId: 'section',
          payload: source,
          payloadHash: hashImportValue(source),
        });
      }
      const before = await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM hc_article_versions WHERE brand_id = ${BRAND} ORDER BY id`,
      );
      const issues = await withSystem(app.db, BRAND, (tx) =>
        validateImportReferences(tx, scope, native),
      );
      if (code) expect(issues).toMatchObject([{ code }]);
      else expect(issues).toEqual([]);
      expect(
        await owner.db.execute(
          sql`SELECT id, xmin::text AS revision FROM hc_article_versions WHERE brand_id = ${BRAND} ORDER BY id`,
        ),
      ).toEqual(before);
      if (!code) {
        const loaded = await withSystem(app.db, BRAND, (tx) =>
          writer.article(
            tx,
            articleLoadSchema.parse({
              ...scope,
              record: native.payload,
              preparedBodyHtml: native.payload.bodyHtml,
            }),
          ),
        );
        expect(loaded.id).toBe(articleId);
        const versions = await owner.db
          .select()
          .from(hcArticleVersions)
          .where(eq(hcArticleVersions.articleId, articleId));
        expect(versions.find((version) => version.locale === 'en')?.bodyHtml).toBe(
          '<p>Existing English</p>',
        );
        expect(versions.find((version) => version.locale === 'ar')).toMatchObject({
          bodyHtml: '<p>Imported Arabic</p>',
          visibility: 'internal',
          status: 'draft',
        });
      }
      expect(await owner.db.select().from(outbox)).toEqual([]);
    },
  );

  it('hashes paged destination revisions, isolates tenant/account changes and detects inserts, updates and deletions', async () => {
    const brandId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Destination snapshots', prefix: 'DST' });
    const run = await boundAccountRun('destination-snapshot', brandId);
    const scope = { brandId, runId: run.runId };
    const snapshot = () =>
      withSystem(app.db, brandId, (tx) => importDestinationFingerprint(tx, scope));
    const original = await snapshot();
    expect(await snapshot()).toBe(original);
    await expect(
      withSystem(app.db, OTHER_BRAND, (tx) => importDestinationFingerprint(tx, scope)),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    const inserted = await owner.db
      .insert(contacts)
      .values(Array.from({ length: 501 }, (_, index) => ({ brandId, name: `Local ${index}` })))
      .returning({ id: contacts.id });
    const first = inserted[0];
    const last = inserted[500];
    if (!first || !last) throw new Error('Missing destination page fixtures');
    const withContacts = await snapshot();
    expect(withContacts).not.toBe(original);
    await owner.db
      .update(contacts)
      .set({ name: 'Changed local name' })
      .where(eq(contacts.id, last.id));
    const updated = await snapshot();
    expect(updated).not.toBe(withContacts);
    const foreignId = uuidv7();
    await owner.db
      .insert(contacts)
      .values({ id: foreignId, brandId: OTHER_BRAND, name: 'Other tenant' });
    expect(await snapshot()).toBe(updated);
    await owner.db.delete(contacts).where(eq(contacts.id, last.id));
    expect(await snapshot()).not.toBe(updated);
    await owner.db.delete(contacts).where(eq(contacts.id, foreignId));
    const beforeLedger = await snapshot();
    await owner.db.insert(importExternalIds).values(
      Array.from({ length: 501 }, (_, index) => ({
        brandId,
        source: 'zendesk' as const,
        sourceAccountKey: run.key,
        entity: 'contact' as const,
        externalId: `source-${index}`,
        helpdockId: first.id,
        payloadHash: 'a'.repeat(64),
      })),
    );
    const withLedger = await snapshot();
    expect(withLedger).not.toBe(beforeLedger);
    await owner.db
      .update(importExternalIds)
      .set({ payloadHash: 'b'.repeat(64) })
      .where(
        and(eq(importExternalIds.brandId, brandId), eq(importExternalIds.externalId, 'source-99')),
      );
    const changedLedger = await snapshot();
    expect(changedLedger).not.toBe(withLedger);
    await owner.db.insert(importExternalIds).values({
      brandId,
      source: 'zendesk',
      sourceAccountKey: 'f'.repeat(64),
      entity: 'contact',
      externalId: 'unrelated-account',
      helpdockId: first.id,
      payloadHash: 'a'.repeat(64),
    });
    expect(await snapshot()).toBe(changedLedger);
    const userId = uuidv7();
    await owner.db.insert(users).values({
      id: userId,
      email: `snapshot-${userId}@example.test`,
      name: 'Invitable person',
      status: 'active',
    });
    const withStaff = await snapshot();
    expect(withStaff).not.toBe(changedLedger);
    await owner.db.update(users).set({ status: 'deactivated' }).where(eq(users.id, userId));
    expect(await snapshot()).not.toBe(withStaff);
    await owner.db.update(users).set({ status: 'active' }).where(eq(users.id, userId));
    expect(await snapshot()).not.toBe(withStaff);
    const beforeBrand = await snapshot();
    await owner.db.update(brands).set({ timezone: 'Europe/Paris' }).where(eq(brands.id, brandId));
    expect(await snapshot()).not.toBe(beforeBrand);
    await owner.db.update(brands).set({ timezone: 'UTC' }).where(eq(brands.id, brandId));
    expect(await snapshot()).not.toBe(beforeBrand);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('invalidates completed validation when destination matching changes after the record scan', async () => {
    const brandId = uuidv7();
    await owner.db.insert(brands).values({ id: brandId, name: 'Dry run freshness', prefix: 'DRF' });
    const bound = await boundAccountRun('dry-run-freshness', brandId);
    const runId = bound.runId;
    await owner.db
      .update(importRuns)
      .set({ status: 'dry_run', credentialsEncrypted: 'retained-fixture' })
      .where(eq(importRuns.id, runId));
    const contactId = uuidv7();
    await owner.db.insert(contacts).values({ id: contactId, brandId, name: 'Reviewed local name' });
    await owner.db.insert(contactIdentities).values({
      brandId,
      contactId,
      kind: 'email',
      value: 'freshness@example.test',
      source: 'agent',
      verified: false,
    });
    const native = importRecordSchema.parse({
      entity: 'contact',
      payload: {
        externalId: 'person',
        name: 'Source person',
        emails: ['freshness@example.test'],
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
    const claim = await withSystem(app.db, brandId, (tx) =>
      claimImportRun(tx, { brandId, runId, phase: 'dry_run' }),
    );
    if (!claim) throw new Error('Missing freshness claim');
    const deps = {
      db: app.db,
      jobId: 'dry-run-freshness',
      resolve: async () =>
        createZendeskImportConnection({
          credentials: { auth: 'oauth' as const, subdomain: 'demo', accessToken: 'synthetic' },
          downloadHosts: [],
          allowCidrs: [],
          limiter: new ImportRateLimiter({ capacity: 10, perMinute: 1000 }),
          log: async () => {},
        }),
    };
    for (let index = 0; index < 3; index++)
      expect(await runImportDryRunBatch(deps, claim)).toEqual({ state: 'more' });
    await owner.db
      .update(contacts)
      .set({ name: 'Changed after review' })
      .where(eq(contacts.id, contactId));
    expect(await runImportDryRunBatch(deps, claim)).toEqual({ state: 'invalidated' });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run).toMatchObject({
      status: 'awaiting_mapping',
      claimToken: null,
      dryRunReport: { phase: 'invalidated' },
      credentialsEncrypted: 'retained-fixture',
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
    const [contact] = await owner.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact?.name).toBe('Changed after review');
    expect(
      await owner.db
        .select()
        .from(contactIdentities)
        .where(eq(contactIdentities.contactId, contactId)),
    ).toMatchObject([{ verified: false }]);
  });

  it('resumes dry-run record checkpoints after pause without duplicating counts or writing profiles', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db.insert(brands).values({ id: brandId, name: 'Dry run resume', prefix: 'DRR' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', status: 'dry_run', startedBy: USER });
    for (const externalId of ['a', 'b']) {
      const record = contactLoadSchema.parse({
        brandId,
        runId,
        source: 'zendesk',
        custom: {},
        accountId: null,
        record: {
          externalId,
          name: 'Source person',
          emails: [],
          phones: ['invalid-one', 'invalid-two'],
          custom: {},
        },
      }).record;
      await owner.db.insert(importRecords).values({
        brandId,
        runId,
        entity: 'contact',
        externalId,
        payload: record,
        payloadHash: hashImportValue(record),
      });
    }
    const scope = { brandId, runId };
    const claim = await withSystem(app.db, brandId, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'dry_run' }),
    );
    if (!claim) throw new Error('Missing dry-run claim');
    const deps = { db: app.db, jobId: 'dry-run-resume' };
    expect(await runImportDryRunRecordBatch(deps, { claim, batchSize: 1 })).toEqual({
      state: 'more',
    });
    expect(
      (await owner.db.select().from(importRuns).where(eq(importRuns.id, runId)))[0]?.dryRunReport,
    ).toMatchObject({ recordWarningCount: 1, refusedPhones: 2 });
    await withSystem(app.db, brandId, (tx) => pauseImportRun(tx, scope));
    expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({ state: 'stopped' });
    await withSystem(app.db, brandId, (tx) => resumeImportRun(tx, scope));
    const resumed = await withSystem(app.db, brandId, (tx) =>
      claimImportRun(tx, { ...scope, phase: 'dry_run' }),
    );
    if (!resumed) throw new Error('Missing resumed dry-run claim');
    expect(await runImportDryRunRecordBatch(deps, { claim: resumed, batchSize: 1 })).toEqual({
      state: 'records_checked',
    });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run?.dryRunReport).toMatchObject({
      phase: 'records_checked',
      checked: 2,
      issueCount: 0,
      issues: [],
      recordWarningCount: 2,
      refusedPhones: 4,
      recordWarnings: ['a', 'b'].map((externalId) => ({
        entity: 'contact',
        externalId,
        code: 'phone-refused',
      })),
    });
    expect(run?.status).toBe('dry_run');
    expect(await runImportDryRunRecordBatch(deps, { claim: resumed })).toEqual({
      state: 'plans_checked',
    });
    const [repeated] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(repeated?.dryRunReport).toMatchObject({
      checked: 2,
      mappingsChecked: 0,
      planIssueCount: 0,
    });
    expect(await runImportDryRunRecordBatch(deps, { claim: resumed })).toEqual({
      state: 'identities_checked',
    });
    const [final] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(final?.dryRunReport).toMatchObject({
      checked: 2,
      identityIssueCount: 0,
      recordWarningCount: 2,
      refusedPhones: 4,
    });
    expect(await runImportDryRunRecordBatch(deps, { claim: resumed })).toEqual({
      state: 'identities_checked',
    });
    const [terminal] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(terminal?.dryRunReport).toEqual(final?.dryRunReport);
    expect(await owner.db.select().from(accounts).where(eq(accounts.brandId, brandId))).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('finds contact and company collisions across committed dry-run pages while permitting aliases to existing profiles', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db.insert(brands).values({ id: brandId, name: 'Identity plan', prefix: 'IPV' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', status: 'dry_run', startedBy: USER });
    for (const externalId of ['a', 'b']) {
      const company = organizationLoadSchema.parse({
        brandId,
        runId,
        source: 'zendesk',
        custom: {},
        record: { externalId, name: 'Company', domains: [' SHARED.TEST '], custom: {} },
      }).record;
      const person = contactLoadSchema.parse({
        brandId,
        runId,
        source: 'zendesk',
        custom: {},
        accountId: null,
        record: {
          externalId,
          name: 'Person',
          emails: ['PERSON@SHARED.TEST'],
          phones: [],
          custom: {},
        },
      }).record;
      await owner.db.insert(importRecords).values([
        {
          brandId,
          runId,
          entity: 'organization',
          externalId,
          payload: company,
          payloadHash: hashImportValue(company),
        },
        {
          brandId,
          runId,
          entity: 'contact',
          externalId,
          payload: person,
          payloadHash: hashImportValue(person),
        },
      ]);
    }
    const claim = await withSystem(app.db, brandId, (tx) =>
      claimImportRun(tx, { brandId, runId, phase: 'dry_run' }),
    );
    if (!claim) throw new Error('Missing identity plan claim');
    const deps = { db: app.db, jobId: 'dry-run-identities' };
    for (let page = 0; page < 3; page++)
      expect(await runImportDryRunRecordBatch(deps, { claim, batchSize: 1 })).toEqual({
        state: 'more',
      });
    expect(await runImportDryRunRecordBatch(deps, { claim, batchSize: 1 })).toEqual({
      state: 'records_checked',
    });
    expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({ state: 'plans_checked' });
    expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({
      state: 'identities_checked',
    });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run?.dryRunReport).toMatchObject({
      identityIssueCount: 4,
      identityIssues: [
        { entity: 'contact', externalId: 'a', code: 'contact-plan-ambiguous' },
        { entity: 'contact', externalId: 'b', code: 'contact-plan-ambiguous' },
        { entity: 'organization', externalId: 'a', code: 'organization-plan-ambiguous' },
        { entity: 'organization', externalId: 'b', code: 'organization-plan-ambiguous' },
      ],
    });
    const projections = await owner.db
      .select({ projection: importRecords.dryRunIdentity })
      .from(importRecords)
      .where(eq(importRecords.runId, runId));
    expect(projections).toHaveLength(4);
    expect(JSON.stringify(projections)).not.toMatch(/person@shared\.test|shared\.test/i);
    expect(await owner.db.select().from(accounts).where(eq(accounts.brandId, brandId))).toEqual([]);
    expect(await owner.db.select().from(contacts).where(eq(contacts.brandId, brandId))).toEqual([]);
    const accountId = uuidv7();
    const contactId = uuidv7();
    await owner.db
      .insert(accounts)
      .values({ id: accountId, brandId, name: 'Local company', domain: 'shared.test' });
    await owner.db.insert(contacts).values({ id: contactId, brandId, name: 'Local person' });
    await owner.db.insert(contactIdentities).values({
      brandId,
      contactId,
      kind: 'email',
      value: 'person@shared.test',
      source: 'agent',
      verified: false,
    });
    await owner.db.update(importRuns).set({ dryRunReport: null }).where(eq(importRuns.id, runId));
    expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({ state: 'records_checked' });
    expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({ state: 'plans_checked' });
    expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({
      state: 'identities_checked',
    });
    const [linked] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(linked?.dryRunReport).toMatchObject({
      checked: 4,
      identityIssueCount: 0,
      identityIssues: [],
    });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('invalidates old dry-run checkpoints that never persisted identity projections', async () => {
    const runId = uuidv7();
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      status: 'dry_run',
      startedBy: USER,
      dryRunReport: { version: 1, phase: 'plans_checked' },
      credentialsEncrypted: 'synthetic-retained-credentials',
    });
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'dry_run' }),
    );
    if (!claim) throw new Error('Missing old checkpoint claim');
    expect(
      await runImportDryRunBatch(
        {
          db: app.db,
          jobId: 'old-dry-run',
          resolve: async () => {
            throw new Error('Legacy checkpoints must invalidate before resolving credentials');
          },
        },
        claim,
      ),
    ).toEqual({ state: 'invalidated' });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run).toMatchObject({
      status: 'awaiting_mapping',
      dryRunReport: null,
      credentialsEncrypted: 'synthetic-retained-credentials',
      claimToken: null,
      claimedAt: null,
    });
  });

  it('counts all identity collision sources while returning at most one hundred samples', async () => {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', startedBy: USER });
    await owner.db.insert(importRecords).values(
      Array.from({ length: 102 }, (_, index) => {
        const payload = {
          externalId: `sample-${index}`,
          name: 'Company',
          domains: ['shared.test'],
          custom: {},
        };
        const payloadHash = hashImportValue(payload);
        return {
          brandId: BRAND,
          runId,
          entity: 'organization' as const,
          externalId: payload.externalId,
          payload,
          payloadHash,
          dryRunIdentity: {
            version: 1,
            inputHash: payloadHash,
            destination: `new:${payload.externalId}`,
            claims: [hashImportValue({ domain: 'shared.test' })],
          },
        };
      }),
    );
    const report = await withSystem(app.db, BRAND, (tx) =>
      validateImportIdentityPlan(tx, { brandId: BRAND, runId, source: 'zendesk' }),
    );
    expect(report.issueCount).toBe(102);
    expect(report.issues).toHaveLength(100);
    expect(new Set(report.issues.map((issue) => issue.externalId)).size).toBe(100);
    expect(report.issues.every((issue) => issue.code === 'organization-plan-ambiguous')).toBe(true);
    await expect(
      withSystem(app.db, BRAND, (tx) =>
        validateImportIdentityPlan(tx, { brandId: BRAND, runId, source: 'freshdesk' }),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
  });

  it('checkpoints mapping, field and invitation conflicts without provisioning or approving loading', async () => {
    const runId = uuidv7();
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', status: 'dry_run', startedBy: USER });
    const people = ['a', 'b', 'corrupt'].map((externalId) => ({
      externalId,
      kind: 'agent' as const,
      name: 'Source agent',
      active: true,
      email: externalId === 'b' ? 'DUPLICATE@PLAN.TEST' : 'duplicate@plan.test',
    }));
    const fields = ['one', 'two'].map((externalId) => ({
      externalId,
      target: 'ticket' as const,
      key: externalId,
      label: externalId,
      type: 'text' as const,
    }));
    await owner.db.insert(importRecords).values([
      ...people.map((payload) => ({
        brandId: BRAND,
        runId,
        entity: 'user' as const,
        externalId: payload.externalId,
        payload,
        payloadHash: payload.externalId === 'corrupt' ? 'e'.repeat(64) : hashImportValue(payload),
      })),
      ...fields.map((payload) => ({
        brandId: BRAND,
        runId,
        entity: 'field' as const,
        externalId: payload.externalId,
        payload,
        payloadHash: hashImportValue(payload),
      })),
    ]);
    const mappings = [
      ...people.map((person) =>
        importMappingSchema.parse({
          kind: 'agent',
          externalValue: person.externalId,
          target: { kind: 'invited', departmentIds: [DEPARTMENT] },
        }),
      ),
      ...fields.map((field) =>
        importMappingSchema.parse({
          kind: 'field',
          externalValue: field.externalId,
          target: {
            kind: 'create',
            definition: { target: 'ticket', key: 'plan_shared_key', label: 'Shared', type: 'text' },
          },
        }),
      ),
      importMappingSchema.parse({
        kind: 'status',
        externalValue: 'missing-status',
        target: { statusId: uuidv7() },
      }),
    ];
    await owner.db
      .insert(importMappings)
      .values(mappings.map((mapping) => ({ brandId: BRAND, runId, ...mapping })));
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM users ORDER BY id`,
    );
    const claim = await withSystem(app.db, BRAND, (tx) =>
      claimImportRun(tx, { brandId: BRAND, runId, phase: 'dry_run' }),
    );
    if (!claim) throw new Error('Missing mapping plan claim');
    const deps = { db: app.db, jobId: 'dry-run-plans' };
    expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({ state: 'records_checked' });
    expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({ state: 'plans_checked' });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run?.status).toBe('dry_run');
    expect(run?.dryRunReport).toMatchObject({
      mappingsChecked: 6,
      planIssueCount: 7,
      planIssues: expect.arrayContaining([
        { area: 'mapping', externalId: 'missing-status', code: 'target-missing' },
        { area: 'mapping', externalId: 'corrupt', code: 'mapping-invalid' },
        { area: 'field', externalId: 'one', code: 'field-key-conflict' },
        { area: 'field', externalId: 'two', code: 'field-key-conflict' },
        { area: 'invitation', externalId: 'a', code: 'invite-email-duplicate' },
        { area: 'invitation', externalId: 'b', code: 'invite-email-duplicate' },
        { area: 'invitation', externalId: 'corrupt', code: 'invite-source-invalid' },
      ]),
    });
    expect(JSON.stringify(run?.dryRunReport)).not.toContain('duplicate@plan.test');
    expect(
      await owner.db.execute(sql`SELECT id, xmin::text AS revision FROM users ORDER BY id`),
    ).toEqual(before);
    expect(
      await owner.db
        .select()
        .from(customFieldDefs)
        .where(eq(customFieldDefs.key, 'plan_shared_key')),
    ).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('invalidates a dry-run record checkpoint if staged inputs change between pages', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db.insert(brands).values({ id: brandId, name: 'Dry run drift', prefix: 'DRD' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', status: 'dry_run', startedBy: USER });
    const records = ['a', 'b'].map(
      (externalId) =>
        organizationLoadSchema.parse({
          brandId,
          runId,
          source: 'zendesk',
          custom: {},
          record: { externalId, name: 'Source company', domains: [], custom: {} },
        }).record,
    );
    await owner.db.insert(importRecords).values(
      records.map((record) => ({
        brandId,
        runId,
        entity: 'organization' as const,
        externalId: record.externalId,
        payload: record,
        payloadHash: hashImportValue(record),
      })),
    );
    const claim = await withSystem(app.db, brandId, (tx) =>
      claimImportRun(tx, { brandId, runId, phase: 'dry_run' }),
    );
    if (!claim) throw new Error('Missing drift claim');
    const deps = { db: app.db, jobId: 'dry-run-drift' };
    expect(await runImportDryRunRecordBatch(deps, { claim, batchSize: 1 })).toEqual({
      state: 'more',
    });
    const changed = { ...records[0], name: 'Changed company' };
    await owner.db
      .update(importRecords)
      .set({ payload: changed, payloadHash: hashImportValue(changed) })
      .where(and(eq(importRecords.runId, runId), eq(importRecords.externalId, 'a')));
    expect(await runImportDryRunRecordBatch(deps, { claim, batchSize: 1 })).toEqual({
      state: 'invalidated',
    });
    const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
    expect(run).toMatchObject({ status: 'awaiting_mapping', claimToken: null, claimedAt: null });
    expect(run?.dryRunReport).toMatchObject({ phase: 'invalidated', checked: 2 });
    expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({ state: 'stopped' });
    expect(await owner.db.select().from(accounts).where(eq(accounts.brandId, brandId))).toEqual([]);
  });

  it('paginates preflight across malformed staged rows without changing profiles or staging', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db.insert(brands).values({ id: brandId, name: 'Paged preflight', prefix: 'PPV' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', startedBy: USER });
    for (const externalId of ['a', 'b', 'c']) {
      const record = organizationLoadSchema.parse({
        brandId,
        runId,
        source: 'zendesk',
        custom: {},
        record: { externalId, name: 'Source company', domains: [], custom: {} },
      }).record;
      await owner.db.insert(importRecords).values({
        brandId,
        runId,
        entity: 'organization',
        externalId,
        payload: record,
        payloadHash: externalId === 'b' ? 'f'.repeat(64) : hashImportValue(record),
      });
    }
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM import_records WHERE run_id = ${runId} ORDER BY id`,
    );
    const scope = { brandId, runId, source: 'zendesk' as const, batchSize: 1 };
    const first = await withSystem(app.db, brandId, (tx) => validateImportRecordPage(tx, scope));
    expect(first).toEqual({
      identityPlans: expect.any(Array),
      warningCount: 0,
      warnings: [],
      refusedPhones: 0,
      checked: 1,
      issueCount: 0,
      issues: [],
      next: { entity: 'organization', externalId: 'a' },
    });
    const second = await withSystem(app.db, brandId, (tx) =>
      validateImportRecordPage(tx, { ...scope, after: first.next }),
    );
    expect(second).toEqual({
      identityPlans: expect.any(Array),
      warningCount: 0,
      warnings: [],
      refusedPhones: 0,
      checked: 1,
      issueCount: 1,
      issues: [{ entity: 'organization', externalId: 'b', code: 'mapping-invalid' }],
      next: { entity: 'organization', externalId: 'b' },
    });
    expect(
      await withSystem(app.db, brandId, (tx) =>
        validateImportRecordPage(tx, { ...scope, after: second.next }),
      ),
    ).toEqual({
      checked: 1,
      issueCount: 0,
      issues: [],
      next: null,
      identityPlans: expect.any(Array),
      warningCount: 0,
      warnings: [],
      refusedPhones: 0,
    });
    await expect(
      withSystem(app.db, brandId, (tx) =>
        validateImportRecordPage(tx, { ...scope, source: 'freshdesk' }),
      ),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM import_records WHERE run_id = ${runId} ORDER BY id`,
      ),
    ).toEqual(before);
    expect(await owner.db.select().from(accounts).where(eq(accounts.brandId, brandId))).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('retains missing-reference errors when contact profile planning also fails', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Reference preflight', prefix: 'RPV' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', startedBy: USER });
    const record = contactLoadSchema.parse({
      brandId,
      runId,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'person',
        name: 'Source person',
        emails: [],
        phones: [],
        organizationExternalId: 'missing-company',
        custom: {},
      },
    }).record;
    await owner.db.insert(importRecords).values({
      brandId,
      runId,
      entity: 'contact',
      externalId: record.externalId,
      payload: record,
      payloadHash: hashImportValue(record),
    });
    expect(
      await withSystem(app.db, brandId, (tx) =>
        validateImportRecordPage(tx, { brandId, runId, source: 'zendesk' }),
      ),
    ).toEqual({
      identityPlans: expect.any(Array),
      warningCount: 0,
      warnings: [],
      refusedPhones: 0,
      checked: 1,
      issueCount: 2,
      next: null,
      issues: [
        { entity: 'contact', externalId: 'person', code: 'reference-missing' },
        { entity: 'contact', externalId: 'person', code: 'target-unavailable' },
      ],
    });
    expect(await owner.db.select().from(contacts).where(eq(contacts.brandId, brandId))).toEqual([]);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('previews a contact with a proposed company without allocating IDs and rejects missing company references', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db.insert(brands).values({ id: brandId, name: 'Source plan', prefix: 'SPV' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', startedBy: USER });
    const organization = organizationLoadSchema.parse({
      brandId,
      runId,
      source: 'zendesk',
      record: {
        externalId: 'source-company',
        name: 'Proposed company',
        domains: ['planned.test'],
        custom: {},
      },
      custom: {},
    }).record;
    await owner.db.insert(importRecords).values({
      brandId,
      runId,
      entity: 'organization',
      externalId: organization.externalId,
      payload: organization,
      payloadHash: hashImportValue(organization),
    });
    const input = contactLoadSchema.parse({
      brandId,
      runId,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'source-person',
        name: 'Source person',
        emails: ['source@planned.test'],
        phones: [],
        organizationExternalId: organization.externalId,
        custom: {},
      },
    });
    const request = {
      brandId,
      runId,
      source: input.source,
      record: input.record,
      defaultCallingCode: '',
    };
    const preview = () =>
      withSystem(app.db, brandId, (tx) => previewImportedContactSource(tx, request));
    expect(await preview()).toMatchObject({
      action: 'create',
      contactId: null,
      accountId: null,
      organization: {
        action: 'create',
        accountId: null,
        externalId: organization.externalId,
        name: organization.name,
      },
    });
    expect(await owner.db.select().from(accounts).where(eq(accounts.brandId, brandId))).toEqual([]);
    expect(await owner.db.select().from(contacts).where(eq(contacts.brandId, brandId))).toEqual([]);
    const accountId = uuidv7();
    const localAccountId = uuidv7();
    const contactId = uuidv7();
    await owner.db.insert(accounts).values([
      { id: accountId, brandId, name: 'Linked company', domain: 'planned.test' },
      { id: localAccountId, brandId, name: 'Local company' },
    ]);
    await owner.db
      .insert(contacts)
      .values({ id: contactId, brandId, name: 'Local person', accountId: localAccountId });
    await owner.db.insert(contactIdentities).values({
      brandId,
      contactId,
      kind: 'email',
      value: 'source@planned.test',
      verified: false,
      source: 'agent',
    });
    const before = await owner.db.execute(
      sql`SELECT xmin::text AS revision FROM contacts WHERE id = ${contactId}`,
    );
    expect(await preview()).toMatchObject({
      action: 'link',
      contactId,
      accountId: localAccountId,
      sourceAccountId: accountId,
      name: 'Local person',
      organization: { action: 'link', accountId, name: 'Linked company' },
    });
    expect(
      await owner.db.execute(
        sql`SELECT xmin::text AS revision FROM contacts WHERE id = ${contactId}`,
      ),
    ).toEqual(before);
    await owner.db
      .delete(importRecords)
      .where(and(eq(importRecords.brandId, brandId), eq(importRecords.runId, runId)));
    await owner.db.insert(importExternalIds).values({
      brandId,
      source: 'zendesk',
      entity: 'organization',
      externalId: organization.externalId,
      helpdockId: accountId,
      payloadHash: hashImportValue(organization),
    });
    expect(await preview()).toMatchObject({
      accountId: localAccountId,
      sourceAccountId: accountId,
      organization: { action: 'reuse', accountId, name: 'Linked company' },
    });
    await owner.db
      .update(importRuns)
      .set({ sourceAccountKey: 'a'.repeat(64) })
      .where(eq(importRuns.id, runId));
    await expect(preview()).rejects.toMatchObject({ code: 'target-unavailable' });
    await expect(
      withSystem(app.db, brandId, (tx) =>
        previewImportedContactSource(tx, {
          ...request,
          record: { ...request.record, organizationExternalId: 'missing-company' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('plans organization creation and reuse through the same domain matching as loading without company writes', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Organization preview', prefix: 'OPV' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', startedBy: USER });
    const input = organizationLoadSchema.parse({
      brandId,
      runId,
      source: 'zendesk',
      record: {
        externalId: 'company-preview',
        name: 'Source company',
        domains: [' EXAMPLE.TEST ', 'example.test'],
        custom: {},
      },
      custom: {},
    });
    const preview = () =>
      withSystem(app.db, brandId, (tx) => previewImportedOrganization(tx, input));
    expect(await preview()).toEqual({
      action: 'create',
      accountId: null,
      name: 'Source company',
      sourceName: 'Source company',
      domains: ['example.test'],
    });
    expect(await owner.db.select().from(accounts).where(eq(accounts.brandId, brandId))).toEqual([]);
    const first = uuidv7();
    const second = uuidv7();
    await owner.db.insert(accounts).values([
      {
        id: first,
        brandId,
        name: 'Local company',
        domain: 'example.test',
        importedDetails: { domains: ['alias.test'], notes: null },
      },
      { id: second, brandId, name: 'Other company', domain: 'other.test' },
    ]);
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM accounts WHERE brand_id = ${brandId} ORDER BY id`,
    );
    expect(await preview()).toMatchObject({
      action: 'link',
      accountId: first,
      name: 'Local company',
      sourceName: 'Source company',
    });
    expect(
      await withSystem(app.db, brandId, (tx) =>
        previewImportedOrganization(tx, {
          ...input,
          record: { ...input.record, domains: ['alias.test'] },
        }),
      ),
    ).toMatchObject({ action: 'link', accountId: first });
    await expect(
      withSystem(app.db, brandId, (tx) =>
        previewImportedOrganization(tx, {
          ...input,
          record: { ...input.record, domains: ['example.test', 'other.test'] },
        }),
      ),
    ).rejects.toThrow('identity-ambiguous');
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM accounts WHERE brand_id = ${brandId} ORDER BY id`,
      ),
    ).toEqual(before);
    expect(await owner.db.select().from(outbox)).toEqual([]);
    await owner.db.update(importRuns).set({ status: 'loading' }).where(eq(importRuns.id, runId));
    expect(await withSystem(app.db, brandId, (tx) => writer.organization(tx, input))).toMatchObject(
      { id: first, outcome: 'linked' },
    );
    expect(await preview()).toMatchObject({
      action: 'unchanged',
      accountId: first,
      name: 'Local company',
    });
    expect(
      await withSystem(app.db, brandId, (tx) =>
        previewImportedOrganization(tx, {
          ...input,
          record: { ...input.record, notes: 'New source note' },
        }),
      ),
    ).toMatchObject({ action: 'update', accountId: first });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('blocks implicit merging of newly planned source contacts but permits shared existing identity targets', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Contact collision plan', prefix: 'CCP' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', startedBy: USER });
    const inputs = ['source-one', 'source-two'].map((externalId) =>
      contactLoadSchema.parse({
        brandId,
        runId,
        source: 'zendesk',
        record: {
          externalId,
          name: externalId,
          emails: ['same-person@example.test'],
          phones: [],
          custom: {},
        },
        accountId: null,
        custom: {},
      }),
    );
    const plans = async () => {
      const result = [];
      for (const input of inputs)
        result.push({
          externalId: input.record.externalId,
          ...(await withSystem(app.db, brandId, (tx) => previewImportedContact(tx, input))),
        });
      return result;
    };
    expect(validateContactIdentityPlan(await plans())).toEqual([
      { externalId: 'source-one', code: 'contact-plan-ambiguous' },
      { externalId: 'source-two', code: 'contact-plan-ambiguous' },
    ]);
    expect(await owner.db.select().from(contacts).where(eq(contacts.brandId, brandId))).toEqual([]);
    const contactId = uuidv7();
    await owner.db.insert(contacts).values({ id: contactId, brandId, name: 'Existing person' });
    await owner.db.insert(contactIdentities).values({
      brandId,
      contactId,
      kind: 'email',
      value: 'same-person@example.test',
      verified: false,
      source: 'agent',
    });
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM contacts WHERE brand_id = ${brandId}`,
    );
    const linked = await plans();
    expect(linked.every((plan) => plan.action === 'link' && plan.contactId === contactId)).toBe(
      true,
    );
    expect(validateContactIdentityPlan(linked)).toEqual([]);
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM contacts WHERE brand_id = ${brandId}`,
      ),
    ).toEqual(before);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('plans contact creation, reuse and ambiguity with loader matching while leaving profiles and verification unchanged', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Contact preview brand', prefix: 'CPL' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', startedBy: USER });
    const input = contactLoadSchema.parse({
      brandId,
      runId,
      source: 'zendesk',
      record: {
        externalId: 'contact-preview',
        name: 'Source person',
        emails: ['PERSON@EXAMPLE.TEST'],
        phones: ['not a phone'],
        custom: {},
      },
      accountId: null,
      custom: {},
    });
    const preview = () => withSystem(app.db, brandId, (tx) => previewImportedContact(tx, input));
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM contacts WHERE brand_id = ${brandId}`,
    );
    expect(await preview()).toEqual({
      action: 'create',
      contactId: null,
      accountId: null,
      sourceAccountId: null,
      name: 'Source person',
      sourceName: 'Source person',
      identifiers: [{ kind: 'email', value: 'person@example.test' }],
      refusedPhones: 1,
    });
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM contacts WHERE brand_id = ${brandId}`,
      ),
    ).toEqual(before);
    const first = uuidv7();
    const second = uuidv7();
    await owner.db.insert(contacts).values([
      { id: first, brandId, name: 'Local person' },
      { id: second, brandId, name: 'Different person' },
    ]);
    await owner.db.insert(contactIdentities).values([
      {
        brandId,
        contactId: first,
        kind: 'email',
        value: 'person@example.test',
        verified: false,
        source: 'agent',
      },
      {
        brandId,
        contactId: second,
        kind: 'email',
        value: 'second@example.test',
        verified: true,
        source: 'agent',
      },
    ]);
    const localCompany = uuidv7();
    const sourceCompany = uuidv7();
    await owner.db.insert(accounts).values([
      { id: localCompany, brandId, name: 'Local company' },
      { id: sourceCompany, brandId, name: 'Source company' },
    ]);
    await owner.db.update(contacts).set({ accountId: localCompany }).where(eq(contacts.id, first));
    const profiles = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM contacts WHERE brand_id = ${brandId} ORDER BY id`,
    );
    const identities = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM contact_identities WHERE brand_id = ${brandId} ORDER BY id`,
    );
    expect(await preview()).toMatchObject({
      action: 'link',
      contactId: first,
      name: 'Local person',
      sourceName: 'Source person',
    });
    expect(
      await withSystem(app.db, brandId, (tx) =>
        previewImportedContact(tx, { ...input, accountId: sourceCompany }),
      ),
    ).toMatchObject({
      action: 'link',
      contactId: first,
      accountId: localCompany,
      sourceAccountId: sourceCompany,
    });
    await expect(
      withSystem(app.db, brandId, (tx) =>
        previewImportedContact(tx, {
          ...input,
          record: { ...input.record, emails: ['person@example.test', 'second@example.test'] },
        }),
      ),
    ).rejects.toThrow('identity-ambiguous');
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM contacts WHERE brand_id = ${brandId} ORDER BY id`,
      ),
    ).toEqual(profiles);
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM contact_identities WHERE brand_id = ${brandId} ORDER BY id`,
      ),
    ).toEqual(identities);
    expect(await owner.db.select().from(outbox)).toEqual([]);
    await owner.db.update(importRuns).set({ status: 'loading' }).where(eq(importRuns.id, runId));
    expect(await withSystem(app.db, brandId, (tx) => writer.contact(tx, input))).toMatchObject({
      id: first,
      outcome: 'linked',
    });
    expect(await preview()).toMatchObject({ action: 'unchanged', contactId: first });
    const updated = { ...input, record: { ...input.record, description: 'New source detail' } };
    expect(
      await withSystem(app.db, brandId, (tx) => previewImportedContact(tx, updated)),
    ).toMatchObject({ action: 'update', contactId: first });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('previews mapped custom values before field creation using exactly the subsequent loader rules', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    await owner.db
      .insert(brands)
      .values({ id: brandId, name: 'Custom preview brand', prefix: 'CPV' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', startedBy: USER });
    const scope = { brandId, runId, source: 'zendesk' as const };
    const source = {
      externalId: 'amount-field',
      target: 'ticket' as const,
      key: 'vendor_amount',
      label: 'Amount',
      type: 'number' as const,
    };
    const ignored = {
      externalId: 'ignored-field',
      target: 'ticket' as const,
      key: 'vendor_ignored',
      label: 'Ignored',
      type: 'text' as const,
    };
    await owner.db.insert(importRecords).values(
      [source, ignored].map((payload) => ({
        brandId,
        runId,
        entity: 'field' as const,
        externalId: payload.externalId,
        payload,
        payloadHash: hashImportValue(payload),
      })),
    );
    const mapping = importMappingSchema.parse({
      kind: 'field',
      externalValue: source.externalId,
      target: {
        kind: 'create',
        definition: {
          target: 'ticket',
          key: 'amount',
          label: 'Amount',
          type: 'number',
          required: true,
        },
      },
    });
    if (mapping.kind !== 'field') throw new Error('Invalid field fixture');
    await owner.db.insert(importMappings).values([
      { brandId, runId, kind: 'field', externalValue: source.externalId, target: mapping.target },
      {
        brandId,
        runId,
        kind: 'field',
        externalValue: ignored.externalId,
        target: { kind: 'skip' },
      },
    ]);
    const request = {
      ...scope,
      target: 'ticket' as const,
      operation: 'create' as const,
      custom: { vendor_amount: '12.5', vendor_ignored: 'Original ignored value' },
    };
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM custom_field_defs WHERE brand_id = ${brandId}`,
    );
    const preview = await withSystem(app.db, brandId, (tx) => previewImportedCustom(tx, request));
    expect(preview).toEqual({ amount: 12.5 });
    await expect(
      withSystem(app.db, brandId, (tx) =>
        previewImportedCustom(tx, { ...request, custom: { vendor_amount: 'not a number' } }),
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
      withSystem(app.db, brandId, (tx) =>
        previewImportedCustom(tx, { ...request, custom: { unknown: 1 } }),
      ),
    ).rejects.toThrow('mapping-invalid');
    await expect(
      withSystem(app.db, brandId, (tx) => previewImportedCustom(tx, { ...request, custom: {} })),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(
      await withSystem(app.db, brandId, (tx) =>
        previewImportedCustom(tx, { ...request, operation: 'patch', custom: {} }),
      ),
    ).toEqual({});
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM custom_field_defs WHERE brand_id = ${brandId}`,
      ),
    ).toEqual(before);
    expect(await owner.db.select().from(outbox)).toEqual([]);
    await owner.db.update(importRuns).set({ status: 'loading' }).where(eq(importRuns.id, runId));
    await withSystem(app.db, brandId, (tx) =>
      writer.field(tx, { ...scope, record: source, mapping: mapping.target }),
    );
    expect(await withSystem(app.db, brandId, (tx) => resolveImportedCustom(tx, request))).toEqual(
      preview,
    );
    const afterCreation = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM custom_field_defs WHERE brand_id = ${brandId}`,
    );
    expect(await withSystem(app.db, brandId, (tx) => previewImportedCustom(tx, request))).toEqual(
      preview,
    );
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM custom_field_defs WHERE brand_id = ${brandId}`,
      ),
    ).toEqual(afterCreation);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('rejects duplicate planned invitation emails across batches while honoring only same-account reuse', async () => {
    const runId = uuidv7();
    const key = sourceAccountKey({ source: 'zendesk', verifiedAccount: 'invite-plan-account' });
    await owner.db.insert(importRuns).values({
      id: runId,
      brandId: BRAND,
      source: 'zendesk',
      startedBy: USER,
      sourceAccountKey: key,
    });
    const scope = { brandId: BRAND, runId, source: 'zendesk' as const };
    const people = Array.from({ length: 501 }, (_, index) => ({
      externalId: `invite-plan-${index}`,
      kind: 'agent' as const,
      active: true,
      name: `Agent ${index}`,
      email: index === 500 ? 'PLAN-0@EXAMPLE.TEST' : `plan-${index}@example.test`,
    }));
    await owner.db.insert(importRecords).values(
      people.map((payload) => ({
        brandId: BRAND,
        runId,
        entity: 'user' as const,
        externalId: payload.externalId,
        payload,
        payloadHash: hashImportValue(payload),
      })),
    );
    const mappings = people.map((person) =>
      importMappingSchema.parse({
        kind: 'agent',
        externalValue: person.externalId,
        target: { kind: 'invited', departmentIds: [DEPARTMENT] },
      }),
    );
    const validate = () =>
      withSystem(app.db, BRAND, (tx) => validateImportInvitationPlan(tx, scope, mappings));
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM users ORDER BY id`,
    );
    expect(await validate()).toEqual([
      { externalId: 'invite-plan-0', code: 'invite-email-duplicate' },
      { externalId: 'invite-plan-500', code: 'invite-email-duplicate' },
    ]);
    await owner.db.insert(importExternalIds).values({
      brandId: BRAND,
      source: 'zendesk',
      sourceAccountKey: 'a'.repeat(64),
      entity: 'user',
      externalId: 'invite-plan-0',
      helpdockId: USER,
      payloadHash: 'e'.repeat(64),
    });
    expect(await validate()).toHaveLength(2);
    await owner.db.insert(importExternalIds).values({
      brandId: BRAND,
      source: 'zendesk',
      sourceAccountKey: key,
      entity: 'user',
      externalId: 'invite-plan-0',
      helpdockId: USER,
      payloadHash: 'e'.repeat(64),
    });
    expect(await validate()).toEqual([]);
    expect(
      await owner.db.execute(sql`SELECT id, xmin::text AS revision FROM users ORDER BY id`),
    ).toEqual(before);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('preflights ticket department eligibility and invitation collisions without changing staff or ticket rows', async () => {
    const scenario = await stagedTicketScenario('routing-preflight');
    const scope = { brandId: BRAND, runId: scenario.input.runId, source: 'zendesk' as const };
    const record = { ...scenario.input.record, assigneeExternalId: 'routing-assignee' };
    const base = [
      { kind: 'status', externalValue: 'open', target: { statusId: STATUS } },
      { kind: 'group', externalValue: '', target: { departmentId: DEPARTMENT, teamId: null } },
      { kind: 'priority', externalValue: '', target: { priority: 'medium' } },
      { kind: 'channel', externalValue: '', target: { channel: 'api' } },
    ].map((mapping) => importMappingSchema.parse(mapping));
    const assigned = (target: unknown) => [
      ...base,
      importMappingSchema.parse({ kind: 'agent', externalValue: 'routing-assignee', target }),
    ];
    const check = (mappings: ReturnType<typeof assigned>) =>
      withSystem(app.db, BRAND, (tx) => validateImportTicketRouting(tx, scope, record, mappings));
    const departmentId = uuidv7();
    await owner.db
      .insert(departments)
      .values({ id: departmentId, brandId: BRAND, name: 'Routing preflight other' });
    expect(await check(assigned({ kind: 'existing', userId: USER }))).toBeNull();
    const otherGroup = assigned({ kind: 'existing', userId: USER }).map((mapping) =>
      mapping.kind === 'group'
        ? importMappingSchema.parse({ ...mapping, target: { departmentId, teamId: null } })
        : mapping,
    );
    expect(await check(otherGroup)).toBe('assignee-department');
    expect(await check(base)).toBe('mapping-invalid');
    const payload = {
      externalId: 'routing-assignee',
      kind: 'agent',
      name: 'Routing agent',
      active: true,
      email: 'routing-new-agent@example.test',
    };
    const [row] = await owner.db
      .insert(importRecords)
      .values({
        brandId: BRAND,
        runId: scope.runId,
        entity: 'user',
        externalId: payload.externalId,
        payload,
        payloadHash: hashImportValue(payload),
      })
      .returning();
    if (!row) throw new Error('Missing routing agent');
    expect(await check(assigned({ kind: 'invited', departmentIds: [DEPARTMENT] }))).toBeNull();
    expect(await check(assigned({ kind: 'invited', departmentIds: [departmentId] }))).toBe(
      'assignee-department',
    );
    const collision = { ...payload, email: 'IMPORTER@EXAMPLE.COM' };
    await owner.db
      .update(importRecords)
      .set({ payload: collision, payloadHash: hashImportValue(collision) })
      .where(eq(importRecords.id, row.id));
    expect(await check(assigned({ kind: 'invited', departmentIds: [DEPARTMENT] }))).toBe(
      'mapping-invalid',
    );
    await owner.db.insert(importExternalIds).values({
      brandId: BRAND,
      source: 'zendesk',
      sourceAccountKey: '0'.repeat(64),
      entity: 'user',
      externalId: payload.externalId,
      helpdockId: USER,
      payloadHash: 'd'.repeat(64),
    });
    const beforeUsers = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM users ORDER BY id`,
    );
    const beforeTickets = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM tickets ORDER BY id`,
    );
    expect(await check(assigned({ kind: 'invited', departmentIds: [DEPARTMENT] }))).toBeNull();
    expect(
      await check(assigned({ kind: 'invited', departmentIds: [DEPARTMENT, departmentId] })),
    ).toBe('mapping-invalid');
    expect(
      await owner.db.execute(sql`SELECT id, xmin::text AS revision FROM users ORDER BY id`),
    ).toEqual(beforeUsers);
    expect(
      await owner.db.execute(sql`SELECT id, xmin::text AS revision FROM tickets ORDER BY id`),
    ).toEqual(beforeTickets);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('validates aggregate field capacity and duplicate keys with account-scoped reuse without creating definitions', async () => {
    const brandId = uuidv7();
    const runId = uuidv7();
    const key = sourceAccountKey({ source: 'zendesk', verifiedAccount: 'field-plan-account' });
    await owner.db.insert(brands).values({ id: brandId, name: 'Field plan brand', prefix: 'FPL' });
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId, source: 'zendesk', startedBy: USER, sourceAccountKey: key });
    await owner.db.insert(customFieldDefs).values(
      Array.from({ length: MAX_CUSTOM_FIELDS_PER_TARGET - 1 }, (_, index) => ({
        brandId,
        target: 'ticket' as const,
        key: `plan_existing_${index}`,
        label: `Existing ${index}`,
        type: 'text' as const,
      })),
    );
    const [existing] = await owner.db
      .select()
      .from(customFieldDefs)
      .where(and(eq(customFieldDefs.brandId, brandId), eq(customFieldDefs.key, 'plan_existing_0')));
    if (!existing) throw new Error('Missing field plan fixture');
    const scope = { brandId, runId, source: 'zendesk' as const };
    const mapping = (externalValue: string, key: string) =>
      importMappingSchema.parse({
        kind: 'field',
        externalValue,
        target: { kind: 'create', definition: { target: 'ticket', key, label: key, type: 'text' } },
      });
    const mappings = [mapping('one', 'plan_one'), mapping('two', 'plan_two')];
    const validate = () =>
      withSystem(app.db, brandId, (tx) => validateImportFieldPlan(tx, scope, mappings));
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM custom_field_defs WHERE brand_id = ${brandId} ORDER BY id`,
    );
    expect(await validate()).toEqual([
      { externalId: 'one', code: 'field-capacity' },
      { externalId: 'two', code: 'field-capacity' },
    ]);
    await owner.db.insert(importExternalIds).values({
      brandId,
      source: 'zendesk',
      sourceAccountKey: 'a'.repeat(64),
      entity: 'field',
      externalId: 'one',
      helpdockId: existing.id,
      payloadHash: 'b'.repeat(64),
    });
    expect(await validate()).toEqual([
      { externalId: 'one', code: 'field-capacity' },
      { externalId: 'two', code: 'field-capacity' },
    ]);
    await owner.db.insert(importExternalIds).values({
      brandId,
      source: 'zendesk',
      sourceAccountKey: key,
      entity: 'field',
      externalId: 'one',
      helpdockId: existing.id,
      payloadHash: 'b'.repeat(64),
    });
    expect(await validate()).toEqual([]);
    expect(
      await withSystem(app.db, brandId, (tx) =>
        validateImportFieldPlan(tx, scope, [
          mapping('three', 'shared_plan'),
          mapping('four', 'shared_plan'),
        ]),
      ),
    ).toEqual([
      { externalId: 'three', code: 'field-key-conflict' },
      { externalId: 'three', code: 'field-capacity' },
      { externalId: 'four', code: 'field-key-conflict' },
      { externalId: 'four', code: 'field-capacity' },
    ]);
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM custom_field_defs WHERE brand_id = ${brandId} ORDER BY id`,
      ),
    ).toEqual(before);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('checks live mapping destinations without provisioning users or fields or crossing brands', async () => {
    const runId = uuidv7();
    const scope = { brandId: BRAND, runId, source: 'zendesk' as const };
    await owner.db
      .insert(importRuns)
      .values({ id: runId, brandId: BRAND, source: 'zendesk', startedBy: USER });
    const check = (mapping: Parameters<typeof validateImportMappingTarget>[2]) =>
      withSystem(app.db, BRAND, (tx) => validateImportMappingTarget(tx, scope, mapping));
    expect(
      await check({ kind: 'status', externalValue: 'open', target: { statusId: STATUS } }),
    ).toBeNull();
    expect(
      await check({ kind: 'status', externalValue: 'missing', target: { statusId: uuidv7() } }),
    ).toBe('target-missing');
    expect(
      await check({
        kind: 'group',
        externalValue: 'support',
        target: { departmentId: DEPARTMENT, teamId: null },
      }),
    ).toBeNull();
    expect(
      await check({
        kind: 'group',
        externalValue: 'foreign',
        target: { departmentId: OTHER_DEPARTMENT, teamId: null },
      }),
    ).toBe('target-missing');
    const secondDepartment = uuidv7();
    const teamId = uuidv7();
    const tagId = uuidv7();
    await owner.db
      .insert(departments)
      .values({ id: secondDepartment, brandId: BRAND, name: 'Preflight second department' });
    await owner.db.insert(teams).values({
      id: teamId,
      brandId: BRAND,
      departmentId: secondDepartment,
      name: 'Preflight team',
    });
    await owner.db.insert(tags).values({ id: tagId, brandId: BRAND, name: 'Preflight-only-tag' });
    expect(
      await check({
        kind: 'group',
        externalValue: 'team',
        target: { departmentId: DEPARTMENT, teamId },
      }),
    ).toBe('target-invalid');
    expect(
      await check({
        kind: 'group',
        externalValue: 'team',
        target: { departmentId: secondDepartment, teamId },
      }),
    ).toBeNull();
    expect(await check({ kind: 'tag', externalValue: 'tag', target: { tagId } })).toBeNull();
    expect(
      await check({ kind: 'tag', externalValue: 'missing', target: { tagId: uuidv7() } }),
    ).toBe('target-missing');
    expect(await check({ kind: 'tag', externalValue: 'skip', target: { tagId: null } })).toBeNull();
    expect(
      await check({
        kind: 'agent',
        externalValue: 'existing',
        target: { kind: 'existing', userId: USER },
      }),
    ).toBeNull();
    await owner.db
      .update(userBrandRoles)
      .set({ role: 'viewer' })
      .where(and(eq(userBrandRoles.brandId, BRAND), eq(userBrandRoles.userId, USER)));
    try {
      expect(
        await check({
          kind: 'agent',
          externalValue: 'viewer',
          target: { kind: 'existing', userId: USER },
        }),
      ).toBe('target-invalid');
    } finally {
      await owner.db
        .update(userBrandRoles)
        .set({ role: 'agent' })
        .where(and(eq(userBrandRoles.brandId, BRAND), eq(userBrandRoles.userId, USER)));
    }
    expect(
      await check({
        kind: 'agent',
        externalValue: 'invite',
        target: { kind: 'invited', departmentIds: [DEPARTMENT] },
      }),
    ).toBe('source-missing');
    const agent = {
      externalId: 'invite',
      kind: 'agent',
      name: 'New agent',
      active: true,
      email: 'new-preflight-agent@example.test',
    };
    const field = {
      externalId: 'new-field',
      target: 'ticket',
      key: 'legacy',
      label: 'Legacy',
      type: 'text',
    };
    await owner.db.insert(importRecords).values([
      {
        brandId: BRAND,
        runId,
        entity: 'user',
        externalId: agent.externalId,
        payload: agent,
        payloadHash: hashImportValue(agent),
      },
      {
        brandId: BRAND,
        runId,
        entity: 'field',
        externalId: field.externalId,
        payload: field,
        payloadHash: hashImportValue(field),
      },
    ]);
    const collisionFieldId = uuidv7();
    await owner.db.insert(customFieldDefs).values({
      id: collisionFieldId,
      brandId: BRAND,
      target: 'ticket',
      key: 'preflight_collision',
      label: 'Existing field',
      type: 'text',
    });
    const usersBefore = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM users ORDER BY id`,
    );
    const fieldsBefore = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM custom_field_defs ORDER BY id`,
    );
    expect(
      await check({
        kind: 'agent',
        externalValue: 'invite',
        target: { kind: 'invited', departmentIds: [DEPARTMENT] },
      }),
    ).toBeNull();
    expect(
      await check({
        kind: 'agent',
        externalValue: 'invite',
        target: { kind: 'invited', departmentIds: [OTHER_DEPARTMENT] },
      }),
    ).toBe('target-missing');
    const definition = {
      target: 'ticket' as const,
      key: 'new_preflight_field',
      label: 'New field',
      type: 'text' as const,
      required: false,
      agentVisible: true,
      options: [],
    };
    const parsedMapping = importMappingSchema.parse({
      kind: 'field',
      externalValue: 'new-field',
      target: { kind: 'create', definition },
    });
    expect(await check(parsedMapping)).toBeNull();
    expect(
      await check(
        importMappingSchema.parse({
          kind: 'field',
          externalValue: 'new-field',
          target: { kind: 'create', definition: { ...definition, target: 'contact' } },
        }),
      ),
    ).toBe('target-invalid');
    expect(
      await check(
        importMappingSchema.parse({
          kind: 'field',
          externalValue: 'new-field',
          target: { kind: 'create', definition: { ...definition, key: 'preflight_collision' } },
        }),
      ),
    ).toBe('target-invalid');
    await owner.db.insert(importExternalIds).values({
      brandId: BRAND,
      source: 'zendesk',
      sourceAccountKey: '0'.repeat(64),
      entity: 'field',
      externalId: 'new-field',
      helpdockId: collisionFieldId,
      payloadHash: 'f'.repeat(64),
    });
    expect(await check(parsedMapping)).toBeNull();
    expect(
      await check({
        kind: 'field',
        externalValue: 'new-field',
        target: { kind: 'existing', fieldId: uuidv7() },
      }),
    ).toBe('target-invalid');
    expect(
      await owner.db.execute(sql`SELECT id, xmin::text AS revision FROM users ORDER BY id`),
    ).toEqual(usersBefore);
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM custom_field_defs ORDER BY id`,
      ),
    ).toEqual(fieldsBefore);
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('validates historical references without writes and refuses another source account or mismatched attachment parent', async () => {
    const scenario = await stagedTicketScenario('preflight-references');
    const scope = { brandId: BRAND, runId: scenario.input.runId, source: 'zendesk' as const };
    const key = sourceAccountKey({ source: 'zendesk', verifiedAccount: 'reference-account' });
    await owner.db
      .update(importRuns)
      .set({ sourceAccountKey: key })
      .where(eq(importRuns.id, scope.runId));
    const message = scenario.input.messages.find((row) => row.authorKind === 'customer');
    if (!message) throw new Error('Missing customer source message');
    const native = importRecordSchema.parse({ entity: 'message', payload: message });
    await owner.db.insert(importExternalIds).values({
      brandId: BRAND,
      source: 'zendesk',
      sourceAccountKey: 'a'.repeat(64),
      entity: 'contact',
      externalId: 'customer',
      helpdockId: CONTACT,
      payloadHash: 'c'.repeat(64),
    });
    const missing = await withSystem(app.db, BRAND, (tx) =>
      validateImportReferences(tx, scope, native),
    );
    expect(missing).toEqual([
      {
        code: 'reference-missing',
        reference: { entity: 'contact', externalId: 'customer', relation: 'author' },
      },
    ]);
    await owner.db.insert(importExternalIds).values({
      brandId: BRAND,
      source: 'zendesk',
      sourceAccountKey: key,
      entity: 'contact',
      externalId: 'customer',
      helpdockId: CONTACT,
      payloadHash: 'c'.repeat(64),
    });
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM tickets ORDER BY id`,
    );
    expect(
      await withSystem(app.db, BRAND, (tx) => validateImportReferences(tx, scope, native)),
    ).toEqual([]);
    expect(
      await owner.db.execute(sql`SELECT id, xmin::text AS revision FROM tickets ORDER BY id`),
    ).toEqual(before);
    const [file] = await owner.db
      .select()
      .from(importRecords)
      .where(and(eq(importRecords.runId, scope.runId), eq(importRecords.entity, 'attachment')));
    if (!file) throw new Error('Missing attachment fixture');
    const attachment = importRecordSchema.parse({ entity: 'attachment', payload: file.payload });
    if (attachment.entity !== 'attachment') throw new Error('Invalid attachment fixture');
    const [parent] = await owner.db
      .select()
      .from(importRecords)
      .where(
        and(
          eq(importRecords.runId, scope.runId),
          eq(importRecords.entity, 'message'),
          eq(importRecords.externalId, attachment.payload.messageExternalId ?? ''),
        ),
      );
    if (!parent) throw new Error('Missing attachment parent message');
    const changed = { ...parent.payload, ticketExternalId: 'other-ticket' };
    await owner.db
      .update(importRecords)
      .set({
        payload: changed,
        payloadHash: hashImportValue(changed),
        parentExternalId: 'other-ticket',
      })
      .where(eq(importRecords.id, parent.id));
    expect(
      await withSystem(app.db, BRAND, (tx) => validateImportReferences(tx, scope, attachment)),
    ).toEqual([
      {
        code: 'reference-parent-mismatch',
        reference: { entity: 'message', externalId: parent.externalId, relation: 'message' },
      },
    ]);
    await owner.db
      .update(importRecords)
      .set({ payloadHash: 'd'.repeat(64) })
      .where(eq(importRecords.id, parent.id));
    expect(
      await withSystem(app.db, BRAND, (tx) => validateImportReferences(tx, scope, attachment)),
    ).toEqual([
      {
        code: 'reference-invalid',
        reference: { entity: 'message', externalId: parent.externalId, relation: 'message' },
      },
    ]);
    await owner.db
      .update(importRecords)
      .set({
        payload: parent.payload,
        payloadHash: parent.payloadHash,
        parentExternalId: parent.parentExternalId,
      })
      .where(eq(importRecords.id, parent.id));
    const author = {
      externalId: 'oldagent',
      kind: 'customer',
      name: 'Incorrect source author kind',
      active: true,
    };
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: scope.runId,
      entity: 'user',
      externalId: 'oldagent',
      payload: author,
      payloadHash: hashImportValue(author),
    });
    const original = importRecordSchema.parse({ entity: 'message', payload: parent.payload });
    expect(
      await withSystem(app.db, BRAND, (tx) => validateImportReferences(tx, scope, original)),
    ).toEqual([
      {
        code: 'reference-invalid',
        reference: { entity: 'user', externalId: 'oldagent', relation: 'author' },
      },
    ]);
    const wrongFile = { ...file.payload, fileName: 'different-file.pdf' };
    await owner.db
      .update(importRecords)
      .set({ payload: wrongFile, payloadHash: hashImportValue(wrongFile) })
      .where(eq(importRecords.id, file.id));
    expect(
      await withSystem(app.db, BRAND, (tx) => validateImportReferences(tx, scope, original)),
    ).toEqual([
      {
        code: 'reference-invalid',
        reference: { entity: 'user', externalId: 'oldagent', relation: 'author' },
      },
      {
        code: 'reference-invalid',
        reference: { entity: 'attachment', externalId: file.externalId, relation: 'attachment' },
      },
    ]);
    const self = importRecordSchema.parse({
      entity: 'category',
      payload: { externalId: 'self', parentExternalId: 'self', names: { en: 'Invalid ancestry' } },
    });
    expect(
      await withSystem(app.db, BRAND, (tx) => validateImportReferences(tx, scope, self)),
    ).toEqual([
      {
        code: 'reference-self',
        reference: { entity: 'category', externalId: 'self', relation: 'category-parent' },
      },
    ]);
    const hierarchy = [
      { externalId: 'cycle-root', parentExternalId: 'cycle-a', names: { en: 'Root' } },
      { externalId: 'cycle-a', parentExternalId: 'cycle-b', names: { en: 'A' } },
      { externalId: 'cycle-b', parentExternalId: 'cycle-c', names: { en: 'B' } },
      { externalId: 'cycle-c', parentExternalId: 'cycle-b', names: { en: 'C' } },
    ];
    await owner.db.insert(importRecords).values(
      hierarchy.map((payload) => ({
        brandId: BRAND,
        runId: scope.runId,
        entity: 'category' as const,
        externalId: payload.externalId,
        parentExternalId: payload.parentExternalId,
        payload,
        payloadHash: hashImportValue(payload),
      })),
    );
    const root = importRecordSchema.parse({ entity: 'category', payload: hierarchy[0] });
    expect(
      await withSystem(app.db, BRAND, (tx) => validateImportReferences(tx, scope, root)),
    ).toEqual([
      {
        code: 'reference-cycle',
        reference: { entity: 'category', externalId: 'cycle-a', relation: 'category-parent' },
      },
    ]);
    await expect(
      withSystem(app.db, OTHER_BRAND, (tx) =>
        validateImportReferences(tx, { ...scope, brandId: OTHER_BRAND }, native),
      ),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
  });

  it('fingerprints staged inputs across pages without writing domain rows or changing source records', async () => {
    const ticketsBefore = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM tickets ORDER BY id`,
    );
    const scenario = await stagedTicketScenario('input-snapshot');
    const scope = { brandId: BRAND, runId: scenario.input.runId };
    const extra = Array.from({ length: 501 }, (_, index) => {
      const payload = { externalId: `snapshot-tag-${index}`, name: `Tag ${index}` };
      return {
        ...scope,
        entity: 'tag' as const,
        externalId: payload.externalId,
        payload,
        payloadHash: hashImportValue(payload),
      };
    });
    await owner.db.insert(importRecords).values(extra);
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM import_records WHERE run_id = ${scope.runId} ORDER BY id`,
    );
    const first = await withSystem(app.db, BRAND, (tx) => importInputFingerprint(tx, scope));
    expect(await withSystem(app.db, BRAND, (tx) => importInputFingerprint(tx, scope))).toBe(first);
    expect(
      await owner.db.execute(
        sql`SELECT id, xmin::text AS revision FROM import_records WHERE run_id = ${scope.runId} ORDER BY id`,
      ),
    ).toEqual(before);
    const [last] = await owner.db
      .select()
      .from(importRecords)
      .where(
        and(eq(importRecords.runId, scope.runId), eq(importRecords.externalId, 'snapshot-tag-99')),
      );
    if (!last) throw new Error('Missing last-page snapshot record');
    const changed = { ...last.payload, name: 'Corrected source tag' };
    await owner.db
      .update(importRecords)
      .set({ payload: changed, payloadHash: hashImportValue(changed) })
      .where(eq(importRecords.id, last.id));
    const second = await withSystem(app.db, BRAND, (tx) => importInputFingerprint(tx, scope));
    expect(second).not.toBe(first);
    await owner.db
      .update(importRuns)
      .set({ counts: { retryFailures: 2 } })
      .where(eq(importRuns.id, scope.runId));
    expect(await withSystem(app.db, BRAND, (tx) => importInputFingerprint(tx, scope))).toBe(second);
    await owner.db.insert(importMappings).values({
      ...scope,
      kind: 'priority',
      externalValue: 'normal',
      target: { priority: 'normal' },
    });
    const third = await withSystem(app.db, BRAND, (tx) => importInputFingerprint(tx, scope));
    expect(third).not.toBe(second);
    await owner.db.insert(importMappings).values(
      Array.from({ length: 501 }, (_, index) => ({
        ...scope,
        kind: 'tag' as const,
        externalValue: `snapshot-map-${index}`,
        target: { tagId: null },
      })),
    );
    const fourth = await withSystem(app.db, BRAND, (tx) => importInputFingerprint(tx, scope));
    expect(fourth).not.toBe(third);
    await owner.db
      .update(importMappings)
      .set({ target: { tagId: uuidv7() } })
      .where(
        and(
          eq(importMappings.runId, scope.runId),
          eq(importMappings.externalValue, 'snapshot-map-99'),
        ),
      );
    const fifth = await withSystem(app.db, BRAND, (tx) => importInputFingerprint(tx, scope));
    expect(fifth).not.toBe(fourth);
    await owner.db
      .update(importRuns)
      .set({ options: { rebuildAllReports: true } })
      .where(eq(importRuns.id, scope.runId));
    expect(await withSystem(app.db, BRAND, (tx) => importInputFingerprint(tx, scope))).not.toBe(
      third,
    );
    await expect(
      withSystem(app.db, OTHER_BRAND, (tx) =>
        importInputFingerprint(tx, { ...scope, brandId: OTHER_BRAND }),
      ),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
    expect(await owner.db.select().from(outbox)).toEqual([]);
    expect(
      await owner.db.execute(sql`SELECT id, xmin::text AS revision FROM tickets ORDER BY id`),
    ).toEqual(ticketsBefore);
  });

  it('creates and tests a write-only connection, binds its account and starts extraction through the outbox atomically', async () => {
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    try {
      const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 17).toString('base64') });
      const service = new ImportsService(keyring, (request) =>
        createZendeskImportConnection({
          ...request,
          credentials: zendeskCredentialsSchema.parse(request.credentials),
          limiter: new ImportRateLimiter({ capacity: 10, perMinute: 1000 }),
          allowCidrs: [],
          log: async () => {},
          transport: {
            apiRoot: fake.server.root,
            policy: {
              allowedPorts: [Number(new URL(fake.server.root).port)],
              allowCidrs: ['127.0.0.1/32'],
            },
          },
        }),
      );
      const inBrand = <T>(work: (context: Parameters<ImportsService['get']>[0]) => Promise<T>) =>
        withSystem(app.db, BRAND, (tx) =>
          work({
            tx,
            brandId: BRAND,
            actor: { userId: USER, role: 'admin', departmentIds: 'all' },
          }),
        );
      const created = await inBrand((context) =>
        service.create(context, { source: 'zendesk', mode: 'full' }),
      );
      expect(created).toMatchObject({
        status: 'draft',
        hasCredentials: false,
        counts: { extracted: {}, loaded: {}, skipped: {} },
      });
      const connection = {
        credentials: { auth: 'oauth' as const, subdomain: 'demo', accessToken: 'synthetic-token' },
        downloadHosts: ['cdn.zendesk.test'],
      };
      await expect(
        inBrand((context) =>
          service.connect(context, created.id, {
            ...connection,
            credentials: { ...connection.credentials, accessToken: 'wrong-token' },
          }),
        ),
      ).rejects.toThrow('import.credentials-refused');
      expect(await inBrand((context) => service.get(context, created.id))).toMatchObject({
        status: 'draft',
        hasCredentials: false,
      });
      const parentId = uuidv7();
      await owner.db.insert(importRuns).values({
        id: parentId,
        brandId: BRAND,
        source: 'zendesk',
        mode: 'full',
        status: 'completed',
        startedBy: USER,
        sourceAccountKey: sourceAccountKey({
          source: 'zendesk',
          verifiedAccount: 'different-account',
        }),
      });
      const delta = await inBrand((context) =>
        service.create(context, { source: 'zendesk', mode: 'delta', parentRunId: parentId }),
      );
      await expect(
        inBrand((context) => service.connect(context, delta.id, connection)),
      ).rejects.toThrow('import.account-mismatch');
      expect(await inBrand((context) => service.get(context, delta.id))).toMatchObject({
        status: 'draft',
        hasCredentials: false,
      });
      const connected = await inBrand((context) =>
        service.connect(context, created.id, connection),
      );
      expect(connected).toMatchObject({
        account: 'demo',
        run: { status: 'connecting', hasCredentials: true },
      });
      const [stored] = await owner.db
        .select()
        .from(importRuns)
        .where(eq(importRuns.id, created.id));
      if (!stored?.credentialsEncrypted) throw new Error('Missing encrypted connection');
      expect(JSON.parse(decryptSecret(stored.credentialsEncrypted, keyring))).toEqual(
        connection.credentials,
      );
      expect(stored.sourceAccountKey).toBe(
        sourceAccountKey({ source: 'zendesk', verifiedAccount: 'demo' }),
      );
      expect(JSON.stringify(connected)).not.toContain('synthetic-token');
      expect(connected.run).not.toHaveProperty('credentialsEncrypted');
      const listed = await inBrand((context) => service.list(context));
      expect(listed.runs.some((run) => run.id === created.id)).toBe(true);
      expect(JSON.stringify(listed)).not.toContain('synthetic-token');
      await expect(
        withSystem(app.db, OTHER_BRAND, (tx) =>
          service.get(
            {
              tx,
              brandId: OTHER_BRAND,
              actor: { userId: USER, role: 'admin', departmentIds: 'all' },
            },
            created.id,
          ),
        ),
      ).rejects.toThrow('import.run-not-found');
      await expect(
        inBrand(async (context) => {
          await service.extract(context, created.id);
          throw new Error('rollback extraction');
        }),
      ).rejects.toThrow('rollback extraction');
      expect(await inBrand((context) => service.get(context, created.id))).toMatchObject({
        status: 'connecting',
      });
      expect(await owner.db.select().from(outbox)).toEqual([]);
      expect(await inBrand((context) => service.extract(context, created.id))).toMatchObject({
        status: 'extracting',
        hasCredentials: true,
      });
      await expect(inBrand((context) => service.extract(context, created.id))).rejects.toThrow(
        'import.phase-invalid',
      );
      const events = await owner.db.select().from(outbox);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'import.work_requested',
        payload: { runId: created.id, step: 'extract' },
      });
      expect(
        JSON.stringify(
          await owner.db.select().from(auditLog).where(eq(auditLog.targetId, created.id)),
        ),
      ).not.toContain('synthetic-token');
      for (const event of events) await owner.db.delete(outbox).where(eq(outbox.id, event.id));
    } finally {
      await fake.server.close();
    }
  });

  it('loads encrypted runtime credentials only for the bound account and enforces exact download hosts', async () => {
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    try {
      const scenario = await stagedTicketScenario('runtime-account');
      const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 13).toString('base64') });
      const credentials = { auth: 'oauth', subdomain: 'demo', accessToken: 'synthetic-token' };
      const key = sourceAccountKey({ source: 'zendesk', verifiedAccount: 'demo' });
      await owner.db
        .update(importRuns)
        .set({
          sourceAccountKey: key,
          credentialsEncrypted: encryptSecret(JSON.stringify(credentials), keyring),
          options: { downloadHosts: ['cdn.zendesk.test'] },
        })
        .where(eq(importRuns.id, scenario.input.runId));
      const resolve = createImportConnectorRuntime(
        { db: app.db, keyring, allowCidrs: [] },
        {
          apiRoot: fake.server.root,
          policy: {
            allowedPorts: [Number(new URL(fake.server.root).port)],
            allowCidrs: ['127.0.0.1/32'],
            lookup: async () => [{ address: '127.0.0.1', family: 4 }],
          },
        },
      );
      const scope = { brandId: BRAND, runId: scenario.input.runId };
      const runtime = await resolve(scope);
      const url = fake.addAttachment('684', Buffer.from('runtime bytes'));
      const downloaded = await runtime.connector.fetchAttachment(runtime.context, {
        externalId: '684',
        fileName: 'receipt.txt',
        url,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('runtime bytes');
      const before = fake.server.calls.length;
      await expect(
        runtime.context.http.request('https://other.example/secret'),
      ).rejects.toMatchObject({ code: 'host-not-allowed' });
      expect(fake.server.calls).toHaveLength(before);
      await expect(
        runtime.context.log({ level: 'warning', message: 'synthetic-token' }),
      ).rejects.toBeInstanceOf(z.ZodError);
      expect(
        await owner.db.select().from(importLog).where(eq(importLog.runId, scope.runId)),
      ).toEqual([]);
      await owner.db
        .update(importRuns)
        .set({
          credentialsEncrypted: encryptSecret(
            JSON.stringify({ ...credentials, subdomain: 'other' }),
            keyring,
          ),
        })
        .where(eq(importRuns.id, scope.runId));
      await expect(resolve(scope)).rejects.toMatchObject({ code: 'credentials-refused' });
      await expect(resolve({ ...scope, brandId: uuidv7() })).rejects.toMatchObject({
        code: 'credentials-refused',
      });
      await owner.db
        .update(importRuns)
        .set({ credentialsEncrypted: 'invalid-envelope' })
        .where(eq(importRuns.id, scope.runId));
      await expect(resolve(scope)).rejects.toMatchObject({
        code: 'credentials-refused',
        message: 'credentials-refused',
      });
      await owner.db
        .update(importRuns)
        .set({ credentialsEncrypted: encryptSecret(JSON.stringify(credentials), keyring) })
        .where(eq(importRuns.id, scope.runId));
      for (const host of ['*.zendesk.com', 'https://cdn.zendesk.test', 'cdn.zendesk.test:443']) {
        await owner.db
          .update(importRuns)
          .set({ options: { downloadHosts: [host] } })
          .where(eq(importRuns.id, scope.runId));
        await expect(resolve(scope)).rejects.toBeInstanceOf(z.ZodError);
      }
      await owner.db
        .update(importRuns)
        .set({ status: 'paused', pausedFrom: 'loading', claimToken: null, claimedAt: null })
        .where(eq(importRuns.id, scope.runId));
      await expect(
        runtime.context.log({ level: 'warning', message: 'import.record-unavailable' }),
      ).rejects.toBeInstanceOf(ImportClaimLost);
      expect(
        await owner.db.select().from(importLog).where(eq(importLog.runId, scope.runId)),
      ).toEqual([]);
      expect(fake.server.calls).toHaveLength(before);
    } finally {
      await fake.server.close();
    }
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

  it('checks ticket and article files across dry-run continuations without creating attachments or outbox work', async () => {
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-dry-media-'));
    try {
      const brandId = uuidv7();
      const runId = uuidv7();
      await owner.db.insert(brands).values({ id: brandId, name: 'Dry media', prefix: 'DMV' });
      await owner.db
        .insert(importRuns)
        .values({ id: runId, brandId, source: 'zendesk', status: 'dry_run', startedBy: USER });
      const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer();
      const urls = [
        fake.addAttachment('good-file', Buffer.from('%PDF-1.7\nHistory')),
        fake.addAttachment('bad-file', png),
        `${fake.server.root}/attachments/token/missing/file`,
      ];
      for (const [index, url] of urls.entries()) {
        const payload = importRecordSchema.parse({
          entity: 'attachment',
          payload: {
            externalId: `dry-file-${index}`,
            ticketExternalId: 'source-ticket',
            fileName: 'history.pdf',
            contentType: 'application/pdf',
            url,
          },
        }).payload;
        await owner.db.insert(importRecords).values({
          brandId,
          runId,
          entity: 'attachment',
          externalId: `dry-file-${index}`,
          parentExternalId: 'source-ticket',
          payload,
          payloadHash: hashImportValue(payload),
        });
      }
      const article = importArticleSchema.parse({
        externalId: 'dry-article',
        sectionExternalId: 'source-section',
        locale: 'en',
        title: 'Source manual',
        bodyHtml: `<p>Manual</p><img src="data:image/png;base64,${png.toString('base64')}">`,
        draft: true,
        internal: true,
        createdAt: '2019-01-01T00:00:00Z',
        updatedAt: '2019-01-01T00:00:00Z',
        attachments: [
          {
            externalId: 'source-manual',
            fileName: 'manual.pdf',
            contentType: 'application/pdf',
            url: urls[0],
          },
          { externalId: 'missing-manual', fileName: 'missing.pdf', url: urls[2] },
        ],
      });
      await owner.db.insert(importRecords).values({
        brandId,
        runId,
        entity: 'article',
        externalId: article.externalId,
        parentExternalId: article.sectionExternalId,
        payload: article,
        payloadHash: hashImportValue(article),
      });
      const claim = await withSystem(app.db, brandId, (tx) =>
        claimImportRun(tx, { brandId, runId, phase: 'dry_run' }),
      );
      if (!claim) throw new Error('Missing dry-run media claim');
      const deps = downloadHarness(fake, new FakeStorage(dir));
      expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({
        state: 'records_checked',
      });
      expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({ state: 'plans_checked' });
      expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({
        state: 'identities_checked',
      });
      for (let index = 0; index < 6; index++)
        expect(await runImportDryRunMediaBatch(deps, claim)).toEqual({ state: 'more', checked: 1 });
      expect(await runImportDryRunMediaBatch(deps, claim)).toEqual({
        state: 'media_checked',
        checked: 0,
      });
      const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      expect(run?.status).toBe('dry_run');
      expect(run?.dryRunReport).toMatchObject({
        mediaChecked: 6,
        mediaWarnings: 2,
        mediaErrors: 1,
        mediaIssues: expect.arrayContaining([
          {
            entity: 'attachment',
            externalId: 'dry-file-1',
            level: 'error',
            code: 'media-mime_mismatch',
          },
          {
            entity: 'attachment',
            externalId: 'dry-file-2',
            level: 'warning',
            code: 'media-unavailable',
          },
          {
            entity: 'article',
            externalId: 'dry-article',
            level: 'warning',
            code: 'media-unavailable',
          },
        ]),
      });
      const filePreviews = await withSystem(app.db, brandId, async (tx) => {
        const binding = await attachmentReviewBinding(tx, { brandId, runId });
        const rows = await tx
          .select()
          .from(importRecords)
          .where(and(eq(importRecords.runId, runId), eq(importRecords.entity, 'attachment')))
          .orderBy(importRecords.id);
        return rows.map((row) => {
          const record = importRecordSchema.parse({ entity: row.entity, payload: row.payload });
          if (record.entity !== 'attachment') throw new Error('Missing attachment fixture');
          return attachmentPreview(record.payload, row, binding);
        });
      });
      expect(filePreviews.map((file) => file.availability.state)).toEqual([
        'available',
        'rejected',
        'unavailable',
      ]);
      expect(JSON.stringify(filePreviews)).not.toMatch(
        /token\/|payloadHash|policyHash|fingerprint/,
      );
      const requests = fake.server.calls.length;
      expect(await runImportDryRunMediaBatch(deps, claim)).toEqual({
        state: 'media_checked',
        checked: 0,
      });
      expect(fake.server.calls).toHaveLength(requests);
      expect(
        await owner.db.select().from(attachments).where(eq(attachments.brandId, brandId)),
      ).toEqual([]);
      expect(await owner.db.select().from(outbox)).toEqual([]);
      expect(await owner.db.select().from(hcMedia).where(eq(hcMedia.brandId, brandId))).toEqual([]);
      expect(
        await owner.db.select().from(hcImportAssets).where(eq(hcImportAssets.brandId, brandId)),
      ).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
      expect(JSON.stringify(run?.dryRunReport)).not.toContain(fake.server.root);
      await owner.db
        .update(brands)
        .set({
          settings: {
            contentPolicy: {
              ...contentPolicySchema.parse({}),
              file: { ...contentPolicySchema.parse({}).file, enabled: false },
            },
          },
        })
        .where(eq(brands.id, brandId));
      expect(await runImportDryRunMediaBatch(deps, claim)).toEqual({
        state: 'invalidated',
        checked: 0,
      });
      expect(fake.server.calls).toHaveLength(requests);
      const [invalidated] = await owner.db
        .select()
        .from(importRuns)
        .where(eq(importRuns.id, runId));
      expect(invalidated).toMatchObject({
        status: 'awaiting_mapping',
        claimToken: null,
        claimedAt: null,
      });
    } finally {
      await fake.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps per-file availability beyond the 100 issue samples and invalidates it with its review or policy', async () => {
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-file-availability-'));
    try {
      const brandId = uuidv7(),
        runId = uuidv7();
      await owner.db
        .insert(brands)
        .values({ id: brandId, name: 'File availability', prefix: 'FAV' });
      await owner.db
        .insert(importRuns)
        .values({ id: runId, brandId, source: 'zendesk', status: 'dry_run', startedBy: USER });
      const date = '2019-01-01T00:00:00Z';
      const refs = Array.from({ length: 101 }, (_, index) => ({
        externalId: `file-${index}`,
        fileName: `history-${index}.pdf`,
        contentType: 'application/pdf',
        url: `${fake.server.root}/attachments/token/missing-${index}/file`,
        sourcePage: 1,
      }));
      const records = [
        importRecordSchema.parse({
          entity: 'ticket',
          payload: {
            externalId: 'root',
            subject: 'Historical files',
            status: 'open',
            ccEmails: [],
            tags: [],
            custom: {},
            createdAt: date,
            updatedAt: date,
          },
        }),
        importRecordSchema.parse({
          entity: 'message',
          payload: {
            externalId: 'message',
            ticketExternalId: 'root',
            authorKind: 'system',
            public: false,
            bodyText: 'Original files',
            createdAt: date,
            attachments: refs,
          },
        }),
        ...refs.map((ref) =>
          importRecordSchema.parse({
            entity: 'attachment',
            payload: {
              ...ref,
              ticketExternalId: 'root',
              messageExternalId: 'message',
            },
          }),
        ),
      ];
      await owner.db.insert(importRecords).values(
        records.map((record) => ({
          brandId,
          runId,
          entity: record.entity,
          externalId: record.payload.externalId,
          parentExternalId: record.entity === 'ticket' ? null : 'root',
          payload: record.payload,
          payloadHash: hashImportValue(record.payload),
        })),
      );
      const claim = await withSystem(app.db, brandId, (tx) =>
        claimImportRun(tx, { brandId, runId, phase: 'dry_run' }),
      );
      if (!claim) throw new Error('Missing file-availability claim');
      const deps = downloadHarness(fake, new FakeStorage(dir));
      for (let page = 0; page < 4; page++)
        expect(await runImportDryRunRecordBatch(deps, { claim })).toEqual({ state: 'more' });
      for (const state of ['records_checked', 'plans_checked', 'identities_checked'])
        expect(await runImportDryRunRecordBatch(deps, { claim })).toMatchObject({ state });
      for (const _ref of refs)
        expect(await runImportDryRunMediaBatch(deps, claim)).toEqual({ state: 'more', checked: 1 });
      expect(await runImportDryRunMediaBatch(deps, claim)).toEqual({
        state: 'media_checked',
        checked: 0,
      });
      const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      const report = importDryRunCheckpointSchema.parse(run?.dryRunReport);
      expect(report.mediaWarnings).toBe(101);
      expect(report.mediaIssues).toHaveLength(100);
      expect(report.mediaIssues.some((issue) => issue.externalId === 'file-100')).toBe(false);
      const preview = () =>
        withSystem(app.db, brandId, (tx) =>
          previewImportedTicket(tx, { brandId, runId, externalId: 'root' }),
        );
      const checked = await preview();
      expect(checked.messages[0]?.attachments).toHaveLength(101);
      expect(
        checked.messages[0]?.attachments.every(
          (file) => file.availability?.state === 'unavailable',
        ),
      ).toBe(true);
      expect(JSON.stringify(checked)).not.toMatch(
        /token\/|sourcePage|dryRunMedia|payloadHash|policyHash/,
      );
      await expect(
        withSystem(app.db, OTHER_BRAND, (tx) =>
          previewImportedTicket(tx, { brandId: OTHER_BRAND, runId, externalId: 'root' }),
        ),
      ).rejects.toMatchObject({ code: 'target-unavailable' });
      await owner.db
        .update(importRuns)
        .set({ dryRunReport: { ...report, mediaAfter: null, phase: 'identities_checked' } })
        .where(eq(importRuns.id, runId));
      expect(
        (await preview()).messages[0]?.attachments.every(
          (file) => file.availability?.state === 'not_checked',
        ),
      ).toBe(true);
      await owner.db
        .update(importRuns)
        .set({ dryRunReport: report })
        .where(eq(importRuns.id, runId));
      await owner.db
        .update(brands)
        .set({
          settings: {
            contentPolicy: {
              ...contentPolicySchema.parse({}),
              file: { ...contentPolicySchema.parse({}).file, enabled: false },
            },
          },
        })
        .where(eq(brands.id, brandId));
      expect(
        (await preview()).messages[0]?.attachments.every(
          (file) => file.availability?.state === 'not_checked',
        ),
      ).toBe(true);
      expect(
        await owner.db.select().from(attachments).where(eq(attachments.brandId, brandId)),
      ).toEqual([]);
      expect(await owner.db.select().from(outbox)).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await fake.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180000);

  it.each([
    { status: 429, expected: { name: 'RateLimited' } },
    { status: 503, expected: { code: 'vendor-unavailable' } },
    { status: 401, expected: { code: 'credentials-refused' } },
  ])('does not advance dry-run media after a vendor $status', async ({ status, expected }) => {
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-dry-media-error-'));
    try {
      const brandId = uuidv7();
      const runId = uuidv7();
      await owner.db
        .insert(brands)
        .values({ id: brandId, name: 'Dry media failure', prefix: `DMF${status}` });
      await owner.db
        .insert(importRuns)
        .values({ id: runId, brandId, source: 'zendesk', status: 'dry_run', startedBy: USER });
      const url = fake.addAttachment('retry-file', Buffer.from('%PDF-1.7\nHistory'));
      const native = importRecordSchema.parse({
        entity: 'attachment',
        payload: {
          externalId: 'retry-file',
          ticketExternalId: 'source-ticket',
          fileName: 'history.pdf',
          contentType: 'application/pdf',
          url,
        },
      });
      await owner.db.insert(importRecords).values({
        brandId,
        runId,
        entity: native.entity,
        externalId: native.payload.externalId,
        parentExternalId: 'source-ticket',
        payload: native.payload,
        payloadHash: hashImportValue(native.payload),
      });
      const claim = await withSystem(app.db, brandId, (tx) =>
        claimImportRun(tx, { brandId, runId, phase: 'dry_run' }),
      );
      if (!claim) throw new Error('Missing failing media claim');
      const deps = downloadHarness(fake, new FakeStorage(dir));
      await runImportDryRunRecordBatch(deps, { claim });
      await runImportDryRunRecordBatch(deps, { claim });
      await runImportDryRunRecordBatch(deps, { claim });
      fake.server.failNext({
        path: new URL(url).pathname,
        status,
        headers: { 'retry-after': '2' },
        json: { error: 'opaque-provider-secret' },
      });
      await expect(runImportDryRunMediaBatch(deps, claim)).rejects.toMatchObject(expected);
      const [run] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      expect(run?.dryRunReport).toMatchObject({
        phase: 'identities_checked',
        mediaAfter: null,
        mediaChecked: 0,
        mediaWarnings: 0,
        mediaErrors: 0,
        mediaIssues: [],
      });
      expect(JSON.stringify(run?.dryRunReport)).not.toContain('opaque-provider-secret');
      expect(
        await owner.db.select().from(attachments).where(eq(attachments.brandId, brandId)),
      ).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
      await withSystem(app.db, brandId, (tx) => pauseImportRun(tx, { brandId, runId }));
      const requests = fake.server.calls.length;
      expect(await runImportDryRunMediaBatch(deps, claim)).toEqual({
        state: 'stopped',
        checked: 0,
      });
      expect(fake.server.calls).toHaveLength(requests);
    } finally {
      await fake.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['success', 'failure'] as const)(
    'drains four concurrent downloads when the batch has %s',
    async (mode) => {
      const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
      await fake.server.start();
      const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-parallel-'));
      try {
        const bytes = Buffer.from('%PDF-1.7\nConcurrent history');
        const urls = Array.from({ length: 4 }, (_, index) =>
          fake.addAttachment(`parallel-${index}`, bytes),
        );
        const scenario = await stagedTicketScenario(`parallel-history-${mode}`, urls[0]);
        const message = scenario.input.messages[0];
        if (!message) throw new Error('Missing parallel message');
        const originalRef = message.attachments[0];
        if (!originalRef) throw new Error('Missing parallel reference');
        message.attachments = urls.map((url, index) => ({
          ...originalRef,
          externalId: index === 0 ? originalRef.externalId : `parallel-file-${mode}-${index}`,
          url,
        }));
        await owner.db
          .update(importRecords)
          .set({ payload: message, payloadHash: hashImportValue(message) })
          .where(
            and(
              eq(importRecords.runId, scenario.input.runId),
              eq(importRecords.entity, 'message'),
              eq(importRecords.externalId, message.externalId),
            ),
          );
        for (const ref of message.attachments.slice(1)) {
          const payload = {
            ...ref,
            ticketExternalId: scenario.input.record.externalId,
            messageExternalId: message.externalId,
          };
          await owner.db.insert(importRecords).values({
            brandId: BRAND,
            runId: scenario.input.runId,
            entity: 'attachment',
            externalId: ref.externalId,
            parentExternalId: scenario.input.record.externalId,
            payload,
            payloadHash: hashImportValue(payload),
          });
        }
        const loaded = await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
        const storage = new FakeStorage(dir);
        const deps = downloadHarness(fake, storage);
        let active = 0;
        let maximum = 0;
        let arrived = 0;
        let release = () => {};
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const fetchAttachment = deps.connector.fetchAttachment.bind(deps.connector);
        deps.connector.fetchAttachment = async (context, ref) => {
          active++;
          arrived++;
          maximum = Math.max(maximum, active);
          if (arrived === 4) release();
          try {
            await Promise.race([barrier, waitForQueue(1000)]);
            if (mode === 'failure' && ref.externalId === originalRef.externalId)
              throw new ConnectorError('vendor-unavailable', 503);
            return await fetchAttachment(context, ref);
          } finally {
            active--;
          }
        };
        const batch = runImportAttachmentBatch(deps, { claim: scenario.claim });
        if (mode === 'failure')
          await expect(batch).rejects.toMatchObject({ code: 'vendor-unavailable' });
        else expect(await batch).toEqual({ state: 'awaiting_media', processed: 4 });
        expect(maximum).toBe(4);
        expect(active).toBe(0);
        const rows = await owner.db
          .select()
          .from(attachments)
          .where(eq(attachments.ticketId, loaded.ticketId));
        expect(rows).toHaveLength(4);
        expect(rows.filter((row) => row.status === 'processing')).toHaveLength(
          mode === 'failure' ? 3 : 4,
        );
        if (mode === 'failure') {
          deps.connector.fetchAttachment = fetchAttachment;
          expect(await runImportAttachmentBatch(deps, { claim: scenario.claim })).toEqual({
            state: 'awaiting_media',
            processed: 1,
          });
        }
        const calls = fake.server.calls.length;
        expect(await runImportAttachmentBatch(deps, { claim: scenario.claim })).toEqual({
          state: 'awaiting_media',
          processed: 0,
        });
        expect(fake.server.calls).toHaveLength(calls);
        const events = await owner.db.select().from(outbox);
        expect(events.filter((event) => event.event === 'attachment.uploaded')).toHaveLength(4);
        for (const event of events) await owner.db.delete(outbox).where(eq(outbox.id, event.id));
      } finally {
        await fake.server.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('refreshes expired Zendesk media during a staged import and stores the original bytes once', async () => {
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-refresh-'));
    try {
      const storage = new FakeStorage(dir);
      const deps = downloadHarness(fake, storage);
      const bytes = Buffer.from('%PDF-1.7\nExpired historical receipt');
      const stable = fake.addAttachment('498483', bytes);
      const initial = await deps.context.http.request(stable, {
        headers: { authorization: 'Bearer synthetic-token' },
      });
      fake.expireDownloads();
      const scenario = await stagedTicketScenario(
        'expired-vendor-media',
        initial.url,
        'application/pdf',
        '498483',
      );
      const loaded = await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
      expect(await runImportAttachmentBatch(deps, { claim: scenario.claim })).toEqual({
        state: 'awaiting_media',
        processed: 1,
      });
      const [row] = await owner.db
        .select()
        .from(attachments)
        .where(eq(attachments.ticketId, loaded.ticketId));
      if (!row) throw new Error('Missing refreshed attachment');
      expect(row).toMatchObject({
        status: 'processing',
        originalName: 'history.pdf',
        size: bytes.length,
      });
      expect(await storage.read(row.s3Key)).toEqual(bytes);
      expect(
        fake.server.calls.filter((call) => call.path === '/api/v2/attachments/498483'),
      ).toHaveLength(1);
      expect(
        fake.server.calls
          .filter((call) => call.path.startsWith('/cdn/'))
          .every((call) => !call.authenticated),
      ).toBe(true);
      const calls = fake.server.calls.length;
      expect(await runImportAttachmentBatch(deps, { claim: scenario.claim })).toEqual({
        state: 'awaiting_media',
        processed: 0,
      });
      expect(fake.server.calls).toHaveLength(calls);
      const events = await owner.db.select().from(outbox);
      expect(events.filter((event) => event.event === 'attachment.uploaded')).toHaveLength(1);
      expect(
        events.every((event) =>
          ['attachment.uploaded', 'media.objects.purge'].includes(event.event),
        ),
      ).toBe(true);
      for (const event of events) await owner.db.delete(outbox).where(eq(outbox.id, event.id));
    } finally {
      await fake.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retains a rejected placeholder when the vendor attachment is deleted and never fetches it again', async () => {
    const fake = new FakeZendesk({}, { authorization: 'Bearer synthetic-token', now: 0 });
    await fake.server.start();
    const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-import-missing-'));
    try {
      const scenario = await stagedTicketScenario(
        'deleted-vendor-file',
        `${fake.server.root}/missing-file`,
      );
      const loaded = await withSystem(app.db, BRAND, (tx) => loadStagedTicket(tx, scenario));
      const [record] = await owner.db
        .select()
        .from(importRecords)
        .where(
          and(
            eq(importRecords.runId, scenario.input.runId),
            eq(importRecords.entity, 'attachment'),
          ),
        );
      if (!record) throw new Error('Missing deleted attachment record');
      const deps = downloadHarness(fake, new FakeStorage(dir));
      const result = await downloadStagedImportAttachment(deps, {
        claim: scenario.claim,
        recordId: record.id,
      });
      expect(result.state).toBe('rejected');
      expect(
        (
          await owner.db.select().from(attachments).where(eq(attachments.id, result.attachmentId))
        )[0],
      ).toMatchObject({
        ticketId: loaded.ticketId,
        status: 'rejected',
        rejectReason: 'object_missing',
        originalName: 'history.pdf',
      });
      expect(
        (
          await owner.db.select().from(importLog).where(eq(importLog.runId, scenario.input.runId))
        ).map((row) => row.message),
      ).toEqual(['import.attachment.unavailable']);
      const calls = fake.server.calls.length;
      expect(
        await downloadStagedImportAttachment(deps, { claim: scenario.claim, recordId: record.id }),
      ).toEqual(result);
      expect(fake.server.calls).toHaveLength(calls);
      const events = await owner.db.select().from(outbox);
      expect(events.every((event) => event.event === 'media.objects.purge')).toBe(true);
      for (const event of events) await owner.db.delete(outbox).where(eq(outbox.id, event.id));
    } finally {
      await fake.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

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

  it('preserves a system message without adopting a mapped agent name or fabricating a staff reply', async () => {
    const input = request('system-name-mismatch');
    const note = input.messages.find((message) => message.authorExternalId === 'oldagent');
    if (!note) throw new Error('Missing old-agent fixture');
    note.authorKind = 'system';
    note.public = true;
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    const messages = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, loaded.ticketId));
    expect(
      messages.find((message) => message.kind === 'public' && message.seq === 2),
    ).toMatchObject({ authorType: 'system', authorId: null, authorDisplay: null });
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
