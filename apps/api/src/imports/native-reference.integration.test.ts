import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  hcArticles,
  hcArticleVersions,
  hcMedia,
  importExternalIds,
  importFiles,
  importRecords,
  importRuns,
  outbox,
  runMigrations,
  tags,
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
import { hashImportValue } from '@helpdock/importers';
import {
  FRESHDESK_IMPORT_ENTITIES,
  type ImportMapping,
  type ImportRunCreate,
  importMappingKindSchema,
  importMappingSchema,
  importRecordSchema,
  ZOHODESK_IMPORT_ENTITIES,
} from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDocker, startPostgres, startRedis } from '../testing/meta-install.js';
import { nativeReferenceQueues } from '../testing/native-reference-queues.js';
import {
  type NativeReferenceSource,
  nativeReferenceSource,
} from '../testing/native-reference-source.js';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { ImportFilesService } from './files.service.js';
import { ImportsService } from './imports.service.js';
import { IMPORT_CLAIM_TIMEOUT_MS } from './jobs/claims.js';
import { recoverBrandImports } from './jobs/recover.js';

describe.skipIf(!hasDocker).each(['freshdesk', 'zohodesk'] as const)(
  'M11 %s native reference migration',
  (name) => {
    const brandId = uuidv7();
    const userId = uuidv7();
    const departmentId = uuidv7();
    const openId = uuidv7();
    const closedId = uuidv7();
    const masterKey = Buffer.alloc(32, 27).toString('base64');
    const tagIds = new Map<string, string>();
    let postgres: StartedPostgreSqlContainer;
    let redis: StartedRedisContainer;
    let owner: DbHandle;
    let app: DbHandle;
    let source: NativeReferenceSource;
    let queues: Awaited<ReturnType<typeof nativeReferenceQueues>>;
    let directory: string;
    let service: ImportsService;
    let files: ImportFilesService;
    const inBrand = <T>(work: (context: TicketingContext) => Promise<T>) =>
      withSystem(app.db, brandId, (tx) =>
        work({ tx, brandId, actor: { userId, role: 'admin', departmentIds: 'all' } }),
      );

    beforeAll(async () => {
      postgres = await startPostgres();
      redis = await startRedis();
      await runMigrations({
        migrationUrl: postgres.getConnectionUri(),
        appRolePassword: 'native-reference-tests',
        log: () => {},
      });
      owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
      const runtimeUrl = new URL(postgres.getConnectionUri());
      runtimeUrl.username = 'helpdock_app';
      runtimeUrl.password = 'native-reference-tests';
      app = createDb({ url: runtimeUrl.toString(), max: 2 });
      await owner.db.insert(users).values({
        id: userId,
        email: 'native-importer@example.test',
        name: 'Importer',
        status: 'active',
      });
      await owner.db
        .insert(brands)
        .values({ id: brandId, name: 'Native migration', prefix: 'NAT' });
      await owner.db.insert(departments).values({ id: departmentId, brandId, name: 'Support' });
      await owner.db
        .insert(userBrandRoles)
        .values({ userId, brandId, role: 'admin', departmentIds: null });
      await owner.db.insert(ticketStatuses).values([
        {
          id: openId,
          brandId,
          name: 'Open',
          systemState: 'open',
          systemKey: 'open',
          isDefault: true,
          color: 'info',
        },
        {
          id: closedId,
          brandId,
          name: 'Closed',
          systemState: 'closed',
          systemKey: 'closed',
          color: 'success',
        },
      ]);
      for (const label of ['migration', ...Array.from({ length: 5 }, (_, i) => `team-${i}`)]) {
        const id = uuidv7();
        tagIds.set(label, id);
        await owner.db.insert(tags).values({ id, brandId, name: label });
      }
      source = await nativeReferenceSource(name);
      service = new ImportsService(createKeyring({ APP_MASTER_KEY: masterKey }), source.connect);
      directory = await mkdtemp(path.join(tmpdir(), `helpdock-${name}-reference-`));
      queues = await nativeReferenceQueues(
        {
          databaseUrl: runtimeUrl.toString(),
          redisUrl: redis.getConnectionUrl(),
          queueName: `m11-${name}-${uuidv7()}`,
          mediaQueueName: `m11-${name}-media-${uuidv7()}`,
          directory,
          masterKey,
          apiRoot: source.transport.apiRoot,
        },
        app.db,
        brandId,
      );
      files = new ImportFilesService(queues.storage);
      await queues.start();
    }, 300000);

    afterAll(async () => {
      // Release a held request before closing the server, including assertion failures.
      try {
        await source?.close();
        await queues?.close();
      } finally {
        await app?.close();
        await owner?.close();
        await redis?.stop();
        await postgres?.stop();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });

    async function run(runId: string) {
      const [row] = await owner.db.select().from(importRuns).where(eq(importRuns.id, runId));
      if (!row) throw new Error('Missing native reference run');
      return row;
    }

    async function phase(runId: string, active: readonly string[]) {
      await queues.pumpUntil(
        async () => !active.includes((await run(runId)).status),
        active.join('/'),
      );
      return run(runId);
    }

    async function inventory(runId: string) {
      if (name !== 'freshdesk') return;
      const bytes = Buffer.from(`Ticket ID\n${source.archiveIds.join('\n')}\n`);
      const uploaded = await inBrand((context) =>
        files.upload(context, runId, {
          format: 'csv',
          entity: 'ticket',
          fileName: 'archive-inventory.csv',
          size: bytes.length,
          inventoryMapping: { idColumn: 'Ticket ID', location: 'archived' },
        }),
      );
      const [row] = await owner.db
        .select()
        .from(importFiles)
        .where(eq(importFiles.id, uploaded.file.id));
      if (!row) throw new Error('Missing uploaded archive inventory');
      await queues.storage.put(row.uploadKey, bytes);
      await inBrand((context) => files.confirm(context, runId, row.id));
      await queues.pumpUntil(async () => {
        const file = await inBrand((context) => files.get(context, runId, row.id));
        if (file.status === 'invalid') throw new Error('Archive inventory preparation failed');
        return file.status === 'ready' && file.inventoryValidation !== null;
      }, 'sealed archive inventory');
    }

    async function mappings(runId: string) {
      const selected: ImportMapping[] = [];
      const existing = await owner.db
        .select()
        .from(customFieldDefs)
        .where(eq(customFieldDefs.brandId, brandId));
      for (const kind of importMappingKindSchema.options) {
        let after: string | undefined;
        do {
          const page = await inBrand((context) =>
            service.mappingValues(context, runId, {
              kind,
              limit: 100,
              ...(after === undefined ? {} : { after }),
            }),
          );
          for (const row of page.values) {
            const base = { kind, externalValue: row.externalValue };
            if (kind === 'field') {
              const field = await inBrand((context) =>
                service.mappingField(context, runId, { externalId: row.externalValue }),
              );
              const target = field.target === 'organization' ? 'account' : field.target;
              const key = `m_${hashImportValue(field.externalId).slice(0, 24)}`;
              const known = existing.find((item) => item.target === target && item.key === key);
              selected.push(
                importMappingSchema.parse({
                  ...base,
                  target: known
                    ? { kind: 'existing', fieldId: known.id }
                    : {
                        kind: 'create',
                        definition: {
                          target,
                          key,
                          label: field.label,
                          type:
                            field.type === 'textarea'
                              ? 'text'
                              : field.type === 'multiselect'
                                ? 'multi_select'
                                : field.type,
                          ...(field.options
                            ? { options: field.options.map((item) => item.value) }
                            : {}),
                        },
                      },
                }),
              );
            } else if (kind === 'group') {
              selected.push(
                importMappingSchema.parse({ ...base, target: { departmentId, teamId: null } }),
              );
            } else if (kind === 'agent') {
              selected.push(
                importMappingSchema.parse({ ...base, target: { kind: 'existing', userId } }),
              );
            } else if (kind === 'tag') {
              const tagId = tagIds.get(row.externalValue);
              if (!tagId) throw new Error(`Unexpected source tag: ${row.externalValue}`);
              selected.push(importMappingSchema.parse({ ...base, target: { tagId } }));
            } else {
              if (!row.proposed)
                throw new Error(`Missing native mapping: ${kind}:${row.externalValue}`);
              selected.push(row.proposed);
            }
          }
          after = page.nextCursor ?? undefined;
        } while (after !== undefined);
      }
      await inBrand((context) => service.confirmMappings(context, runId, { mappings: selected }));
    }

    async function migrate(input: Omit<ImportRunCreate, 'source'>, crash = false) {
      const created = await inBrand((context) =>
        service.create(context, { ...input, source: name }),
      );
      await inBrand((context) =>
        service.connect(context, created.id, {
          credentials: source.credentials,
          downloadHosts: [],
        }),
      );
      await inventory(created.id);
      await inBrand((context) =>
        service.scope(context, created.id, {
          entities: [
            ...(name === 'freshdesk' ? FRESHDESK_IMPORT_ENTITIES : ZOHODESK_IMPORT_ENTITIES),
          ],
          rebuildAllReports: true,
          ...(name === 'freshdesk' ? { inventoryMode: 'archives', inventoryConfirmed: true } : {}),
        }),
      );
      if (crash) source.failExtraction();
      await inBrand((context) => service.extract(context, created.id));
      expect((await phase(created.id, ['extracting'])).status).toBe('awaiting_mapping');
      await mappings(created.id);
      await inBrand((context) => service.dryRun(context, created.id, { defaultCallingCode: '' }));
      expect((await phase(created.id, ['dry_run'])).status).toBe('awaiting_mapping');
      const report = await inBrand((context) => service.dryRunReport(context, created.id));
      expect(report).toMatchObject({ complete: true, errors: 0 });
      const reviewToken = report.reviewToken;
      if (!reviewToken) throw new Error('Missing native dry-run approval');
      const held = crash ? source.holdFile() : undefined;
      try {
        await inBrand((context) =>
          service.start(context, created.id, { reviewToken, acknowledgeWarnings: true }),
        );
        if (held) {
          await queues.pumpUntil(async () => {
            const current = await run(created.id);
            if (['failed', 'cancelled'].includes(current.status)) {
              const checkpoints = await owner.db.execute(sql`
                SELECT entity, status, count(*)::int AS total FROM import_records
                WHERE run_id = ${created.id} GROUP BY entity, status ORDER BY entity, status
              `);
              throw new Error(
                `Import stopped before the crash point: ${current.error ?? current.status}; checkpoints=${JSON.stringify(checkpoints)}`,
              );
            }
            return held.waiting;
          }, 'attachment download before crash');
          expect(await run(created.id)).toMatchObject({
            status: 'loading',
            claimToken: expect.any(String),
          });
          await queues.kill();
          held.release();
          // Advance only the dead worker's lease, never records, receipts or extraction cursors.
          await owner.db
            .update(importRuns)
            .set({ claimedAt: new Date(Date.now() - IMPORT_CLAIM_TIMEOUT_MS - 1) })
            .where(eq(importRuns.id, created.id));
          expect(
            await withSystem(app.db, brandId, (tx) => recoverBrandImports(tx, brandId)),
          ).toBeGreaterThan(0);
          await queues.start();
        }
        expect(await phase(created.id, ['loading', 'finishing'])).toMatchObject({
          status: 'completed',
          credentialsEncrypted: null,
        });
      } finally {
        held?.release();
      }
      return created.id;
    }

    async function snapshot() {
      const result: Record<string, unknown> = {};
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
        'hc_categories',
        'hc_sections',
        'hc_articles',
        'hc_article_versions',
        'hc_media',
        'hc_import_assets',
      ]) {
        const [row] = await owner.db.execute(sql`
          SELECT count(*)::int AS total,
            md5(coalesce(string_agg(row_to_json(t)::text || ':' || t.xmin::text, '' ORDER BY row_to_json(t)::text), '')) AS revision
          FROM ${sql.identifier(table)} t WHERE brand_id = ${brandId}
        `);
        result[table] = row;
      }
      return result;
    }

    async function inert() {
      for (const table of [
        'workflow_runs',
        'ticket_sla_clocks',
        'notifications',
        'ai_calls',
        'webhook_deliveries',
      ]) {
        const [row] = await owner.db.execute(
          sql`SELECT count(*)::int AS total FROM ${sql.identifier(table)} WHERE brand_id = ${brandId}`,
        );
        expect(row?.total, table).toBe(0);
      }
      const events = await owner.db.select().from(outbox).where(eq(outbox.brandId, brandId));
      expect(
        events
          .filter(
            (event) =>
              ![
                'import.work_requested',
                'import.file_uploaded',
                'attachment.uploaded',
                'media.objects.purge',
                'help_center.media_uploaded',
                'help_center.imported',
              ].includes(event.event),
          )
          .map((event) => event.event),
      ).toEqual([]);
      expect(
        source
          .calls()
          .filter(
            (call) =>
              call.method !== 'GET' && (call.method !== 'POST' || call.path !== '/oauth/v2/token'),
          ),
      ).toEqual([]);
    }

    it('recovers a killed worker with all 500 histories intact, repeats without writes and applies old archive deltas', async () => {
      const runId = await migrate({ mode: 'full' }, true);
      const loaded = await owner.db.select().from(tickets).where(eq(tickets.brandId, brandId));
      const messages = await owner.db
        .select()
        .from(ticketMessages)
        .where(eq(ticketMessages.brandId, brandId));
      const identities = await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.brandId, brandId));
      const staged = await owner.db
        .select()
        .from(importRecords)
        .where(eq(importRecords.runId, runId));
      const records = staged.map((row) =>
        importRecordSchema.parse({ entity: row.entity, payload: row.payload }),
      );
      const participants = await owner.db
        .select()
        .from(ticketParticipants)
        .where(eq(ticketParticipants.brandId, brandId));
      const linkedTags = await owner.db
        .select()
        .from(ticketTags)
        .where(eq(ticketTags.brandId, brandId));
      const sourceId = (entity: string, externalId: string | undefined) => {
        const id = identities.find(
          (entry) => entry.entity === entity && entry.externalId === externalId,
        )?.helpdockId;
        if (!id) throw new Error(`Missing ${entity} receipt for ${externalId}`);
        return id;
      };
      expect(loaded).toHaveLength(500);
      expect(new Set(loaded.map((ticket) => ticket.number)).size).toBe(500);
      expect(messages).toHaveLength(2000);
      expect(messages.filter((message) => message.kind === 'note')).toHaveLength(500);
      expect(
        messages.filter((message) => message.authorType === 'staff' && message.authorId === userId),
      ).toHaveLength(1000);
      for (const record of records.filter((record) => record.entity === 'ticket')) {
        const sourceTicket = record.payload;
        const ticketId = sourceId('ticket', sourceTicket.externalId);
        const ticket = loaded.find((item) => item.id === ticketId);
        expect(ticket, sourceTicket.externalId).toMatchObject({
          subject: sourceTicket.subject,
          importSource: name,
          departmentId,
          assigneeId: userId,
          createdAt: new Date(sourceTicket.createdAt),
          updatedAt: new Date(sourceTicket.updatedAt),
        });
        expect(messages.filter((message) => message.ticketId === ticketId)).toHaveLength(4);
        const requesterId = sourceId('contact', sourceTicket.requesterExternalId);
        expect(ticket?.contactId).toBe(requesterId);
        expect(
          linkedTags
            .filter((link) => link.ticketId === ticketId)
            .map((link) => link.tagId)
            .sort(),
        ).toEqual(sourceTicket.tags.map((tag) => tagIds.get(tag)).sort());
        expect(
          participants.filter((participant) => participant.ticketId === ticketId),
        ).toHaveLength(1);
        for (const [key, value] of Object.entries(sourceTicket.custom)) {
          const field = records
            .filter((item) => item.entity === 'field')
            .find((item) => item.payload.target === 'ticket' && item.payload.key === key);
          if (!field) throw new Error(`Missing ticket field ${key}`);
          expect(
            ticket?.custom[`m_${hashImportValue(field.payload.externalId).slice(0, 24)}`],
          ).toEqual(value);
        }
      }
      for (const record of records.filter((record) => record.entity === 'message')) {
        const original = record.payload;
        expect(
          messages.find((message) => message.id === sourceId('message', original.externalId)),
        ).toMatchObject({
          ticketId: sourceId('ticket', original.ticketExternalId),
          bodyText: original.bodyText,
          kind: original.public ? 'public' : 'note',
          createdAt: new Date(original.createdAt),
          ...(original.email?.messageId ? { externalMessageId: original.email.messageId } : {}),
        });
      }
      const media = await owner.db
        .select()
        .from(attachments)
        .where(eq(attachments.brandId, brandId));
      expect(media).toHaveLength(500);
      for (const file of media) {
        expect(file).toMatchObject({
          origin: 'import',
          status: 'ready',
          mime: 'application/pdf',
          size: source.media.length,
        });
        expect(await queues.storage.read(file.s3Key)).toEqual(source.media);
      }
      expect(
        await owner.db.select().from(contacts).where(eq(contacts.brandId, brandId)),
      ).toHaveLength(50);
      const identifiers = await owner.db
        .select()
        .from(contactIdentities)
        .where(eq(contactIdentities.brandId, brandId));
      expect(
        identifiers.every((identity) => identity.source === 'import' && !identity.verified),
      ).toBe(true);
      for (const record of records.filter((record) => record.entity === 'contact')) {
        const emails = identifiers
          .filter(
            (identity) =>
              identity.contactId === sourceId('contact', record.payload.externalId) &&
              identity.kind === 'email',
          )
          .map((identity) => identity.value);
        expect(emails.sort()).toEqual(
          record.payload.emails.map((email) => email.toLowerCase()).sort(),
        );
      }
      expect(
        await owner.db.select().from(accounts).where(eq(accounts.brandId, brandId)),
      ).toHaveLength(10);
      const versions = await owner.db
        .select()
        .from(hcArticleVersions)
        .where(eq(hcArticleVersions.brandId, brandId));
      expect(
        await owner.db.select().from(hcArticles).where(eq(hcArticles.brandId, brandId)),
      ).toHaveLength(20);
      expect(versions).toHaveLength(40);
      expect(new Set(versions.map((version) => version.locale))).toEqual(new Set(['en', 'ar']));
      if (name === 'freshdesk')
        expect(versions.every((version) => version.visibility === 'internal')).toBe(true);
      else {
        const originalArticleId = sourceId('article', 'article:7001:en');
        const english = versions.find(
          (version) => version.locale === 'en' && version.articleId === originalArticleId,
        );
        expect(english?.bodyHtml).toContain('Staff-only working changes.');
        expect(english?.publishedBodyHtml).toContain('Original customer-facing content.');
        expect(english?.publishedBodyHtml).not.toContain('Staff-only working changes.');
        const kbFiles = await owner.db.select().from(hcMedia).where(eq(hcMedia.brandId, brandId));
        expect(kbFiles).toHaveLength(1);
        for (const file of kbFiles) {
          expect(file.status).toBe('ready');
          expect(await queues.storage.read(file.s3Key)).toEqual(source.media);
        }
      }
      await inert();
      const beforeRepeat = await snapshot();
      const repeatId = await migrate({ mode: 'full' });
      expect(await snapshot()).toEqual(beforeRepeat);
      source.change(new Date().toISOString());
      await migrate({ mode: 'delta', parentRunId: repeatId });
      const changed = await owner.db.select().from(tickets).where(eq(tickets.brandId, brandId));
      for (const externalId of [source.firstTicketId, source.lastTicketId]) {
        const id = identities.find(
          (entry) => entry.entity === 'ticket' && entry.externalId === externalId,
        )?.helpdockId;
        const original = loaded.find((ticket) => ticket.id === id);
        expect(changed.find((ticket) => ticket.id === id)).toMatchObject({
          subject: `Delta subject ${externalId}`,
          statusId: closedId,
          createdAt: original?.createdAt,
        });
        const thread = await owner.db
          .select()
          .from(ticketMessages)
          .where(eq(ticketMessages.ticketId, id!));
        expect(thread).toHaveLength(5);
        expect(
          thread.find((message) => message.bodyText === `Delta note ${externalId}`),
        ).toMatchObject({ kind: 'note', authorType: 'staff', authorId: userId });
      }
      const firstId = identities.find(
        (entry) => entry.entity === 'ticket' && entry.externalId === source.firstTicketId,
      )?.helpdockId;
      const [rating] = await owner.db
        .select()
        .from(csatResponses)
        .where(eq(csatResponses.ticketId, firstId!));
      expect(rating).toMatchObject({
        comment: 'Corrected original feedback',
        ratedAt: new Date('2018-01-03T10:00:00Z'),
      });
      const afterDelta = await snapshot();
      expect(afterDelta.tickets).toMatchObject({ total: 500 });
      expect(afterDelta.ticket_messages).toMatchObject({ total: 2002 });
      expect(afterDelta.attachments).toEqual(beforeRepeat.attachments);
      const changedProfiles = await owner.db
        .select()
        .from(contacts)
        .where(eq(contacts.brandId, brandId));
      expect(
        changedProfiles.find(
          (contact) => contact.importedDetails?.description === 'Delta contact description',
        ),
      ).toBeDefined();
      const changedCompanies = await owner.db
        .select()
        .from(accounts)
        .where(eq(accounts.brandId, brandId));
      expect(
        changedCompanies.find((company) =>
          name === 'freshdesk'
            ? company.importedDetails?.notes === 'Delta company note'
            : company.importedDetails?.description === 'Delta company description',
        ),
      ).toBeDefined();
      expect(
        await owner.db
          .select()
          .from(importRecords)
          .where(and(eq(importRecords.runId, runId), eq(importRecords.status, 'staged'))),
      ).toEqual([]);
      await inert();
    }, 3600000);
  },
);
