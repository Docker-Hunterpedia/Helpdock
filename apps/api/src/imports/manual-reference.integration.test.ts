import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKeyring } from '@helpdock/config';
import {
  attachments,
  brands,
  createDb,
  type DbHandle,
  departments,
  importFiles,
  importRuns,
  outbox,
  runMigrations,
  ticketMessages,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  type ImportFileMapping,
  type ImportMapping,
  importFileMappingSchema,
  importMappingSchema,
} from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDocker, startPostgres, startRedis } from '../testing/meta-install.js';
import { nativeReferenceQueues } from '../testing/native-reference-queues.js';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { ImportFilePresetsService } from './file-presets.service.js';
import { ImportFilesService } from './files.service.js';
import { ImportsService } from './imports.service.js';

const brandId = uuidv7(),
  userId = uuidv7(),
  departmentId = uuidv7(),
  statusId = uuidv7();
const headers = ['Ticket ID', 'Subject', 'Created', 'Body'];
const csvMapping = importFileMappingSchema.parse({
  entity: 'ticket',
  fields: [
    ...[
      ['externalId', 'Ticket ID'],
      ['subject', 'Subject'],
    ].map(([target, column]) => ({
      target,
      source: { kind: 'columns', names: [column] },
      transforms: [],
      omitEmpty: false,
    })),
    ...['createdAt', 'updatedAt'].map((target) => ({
      target,
      source: { kind: 'columns', names: ['Created'] },
      transforms: [{ kind: 'date', format: 'dmy', timezone: 'Asia/Riyadh' }],
      omitEmpty: false,
    })),
    {
      target: 'status',
      source: { kind: 'literal', value: 'open' },
      transforms: [],
      omitEmpty: false,
    },
  ],
  firstMessageFields: [
    {
      target: 'bodyText',
      source: { kind: 'columns', names: ['Body'] },
      transforms: [],
      omitEmpty: false,
    },
    ...Object.entries({
      public: true,
      authorKind: 'customer',
      authorExternalId: 'csv-customer',
    }).map(([target, value]) => ({
      target,
      source: { kind: 'literal', value },
      transforms: [],
      omitEmpty: false,
    })),
  ],
});

describe.skipIf(!hasDocker)('M11 manual file migration', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let owner: DbHandle, app: DbHandle;
  let queues: Awaited<ReturnType<typeof nativeReferenceQueues>>;
  let directory: string;
  let files: ImportFilesService;
  const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 29).toString('base64') });
  const service = new ImportsService(keyring, () => {
    throw new Error('A file import must not connect to a vendor');
  });
  const inBrand = <T>(work: (context: TicketingContext) => Promise<T>) =>
    withSystem(app.db, brandId, (tx) =>
      work({ tx, brandId, actor: { userId, role: 'admin', departmentIds: 'all' } }),
    );

  beforeAll(async () => {
    postgres = await startPostgres();
    redis = await startRedis();
    await runMigrations({
      migrationUrl: postgres.getConnectionUri(),
      appRolePassword: 'manual-reference-tests',
      log: () => {},
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    const runtime = new URL(postgres.getConnectionUri());
    runtime.username = 'helpdock_app';
    runtime.password = 'manual-reference-tests';
    app = createDb({ url: runtime.toString(), max: 2 });
    await owner.db.insert(users).values({
      id: userId,
      email: 'manual-importer@example.test',
      name: 'Importer',
      status: 'active',
    });
    await owner.db.insert(brands).values({ id: brandId, name: 'Manual migration', prefix: 'MAN' });
    await owner.db.insert(departments).values({ id: departmentId, brandId, name: 'Support' });
    await owner.db
      .insert(userBrandRoles)
      .values({ userId, brandId, role: 'admin', departmentIds: null });
    await owner.db.insert(ticketStatuses).values({
      id: statusId,
      brandId,
      name: 'Open',
      systemState: 'open',
      systemKey: 'open',
      isDefault: true,
      color: 'info',
    });
    directory = await mkdtemp(path.join(tmpdir(), 'helpdock-manual-reference-'));
    queues = await nativeReferenceQueues(
      {
        databaseUrl: runtime.toString(),
        redisUrl: redis.getConnectionUrl(),
        queueName: `manual-${uuidv7()}`,
        mediaQueueName: `manual-media-${uuidv7()}`,
        directory,
        masterKey: Buffer.alloc(32, 29).toString('base64'),
        apiRoot: 'http://127.0.0.1:1',
      },
      app.db,
      brandId,
    );
    files = new ImportFilesService(queues.storage);
    await queues.start();
  }, 300000);

  afterAll(async () => {
    try {
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
    if (!row) throw new Error('Missing manual import');
    return row;
  }

  async function phase(runId: string, active: readonly string[]) {
    await queues.pumpUntil(
      async () => !active.includes((await run(runId)).status),
      active.join('/'),
    );
    return run(runId);
  }

  async function upload(
    runId: string,
    bytes: Buffer,
    format: 'bundle' | 'csv',
    mapping?: ImportFileMapping,
  ) {
    const uploaded = await inBrand((context) =>
      files.upload(
        context,
        runId,
        format === 'bundle'
          ? { format, fileName: 'reference.zip', size: bytes.length }
          : {
              format,
              entity: mapping?.entity ?? 'ticket',
              fileName: 'source.csv',
              size: bytes.length,
            },
      ),
    );
    const [row] = await owner.db
      .select()
      .from(importFiles)
      .where(eq(importFiles.id, uploaded.file.id));
    if (!row) throw new Error('Missing manual source file');
    await queues.storage.put(row.uploadKey, bytes);
    await inBrand((context) => files.confirm(context, runId, row.id));
    const ready = async () => {
      const file = await inBrand((context) => files.get(context, runId, row.id));
      if (file.status === 'invalid') throw new Error(`Manual file refused: ${file.error}`);
      return file.status === 'ready';
    };
    await queues.pumpUntil(ready, 'sealed manual source');
    if (mapping) {
      await inBrand((context) => files.mapping(context, runId, row.id, mapping));
      await queues.pumpUntil(
        async () =>
          (await inBrand((context) => files.get(context, runId, row.id))).validation !== null,
        'CSV mapping validation',
      );
    }
  }

  async function migrate(bytes: Buffer, format: 'bundle' | 'csv', mapping?: ImportFileMapping) {
    const created = await inBrand((context) =>
      service.create(context, { source: 'file', mode: 'full' }),
    );
    await inBrand((context) =>
      files.connect(context, created.id, { dataset: `manual-${format}`, downloadHosts: [] }),
    );
    await upload(created.id, bytes, format, mapping);
    if (format === 'csv') {
      const contacts = Buffer.from('ID,Name\ncsv-customer,Original visitor\n');
      const contactMapping = importFileMappingSchema.parse({
        entity: 'contact',
        fields: [
          ['externalId', 'ID'],
          ['name', 'Name'],
        ].map(([target, column]) => ({
          target,
          source: { kind: 'columns', names: [column] },
          transforms: [],
          omitEmpty: false,
        })),
      });
      await upload(created.id, contacts, 'csv', contactMapping);
    }
    await inBrand((context) =>
      service.scope(context, created.id, {
        entities:
          format === 'bundle'
            ? ['user', 'contact', 'group', 'ticket', 'message', 'attachment']
            : ['contact', 'ticket', 'message'],
        rebuildAllReports: true,
      }),
    );
    await inBrand((context) => service.extract(context, created.id));
    expect((await phase(created.id, ['extracting'])).status).toBe('awaiting_mapping');
    const mappings: ImportMapping[] = [
      importMappingSchema.parse({ kind: 'status', externalValue: 'open', target: { statusId } }),
      importMappingSchema.parse({
        kind: 'group',
        externalValue: '',
        target: { departmentId, teamId: null },
      }),
      importMappingSchema.parse({
        kind: 'priority',
        externalValue: '',
        target: { priority: 'medium' },
      }),
      importMappingSchema.parse({
        kind: 'channel',
        externalValue: '',
        target: { channel: 'email' },
      }),
    ];
    if (format === 'bundle')
      mappings.push(
        importMappingSchema.parse({
          kind: 'group',
          externalValue: 'support',
          target: { departmentId, teamId: null },
        }),
        importMappingSchema.parse({
          kind: 'agent',
          externalValue: 'legacy-agent',
          target: { kind: 'name' },
        }),
        importMappingSchema.parse({
          kind: 'priority',
          externalValue: 'high',
          target: { priority: 'high' },
        }),
        importMappingSchema.parse({
          kind: 'channel',
          externalValue: 'email',
          target: { channel: 'email' },
        }),
      );
    await inBrand((context) => service.confirmMappings(context, created.id, { mappings }));
    await inBrand((context) => service.dryRun(context, created.id, { defaultCallingCode: '' }));
    expect((await phase(created.id, ['dry_run'])).status).toBe('awaiting_mapping');
    const report = await inBrand((context) => service.dryRunReport(context, created.id));
    expect(report.complete).toBe(true);
    expect(report.errors, JSON.stringify(report.issues)).toBe(0);
    const reviewToken = report.reviewToken;
    if (!reviewToken) throw new Error('Missing file dry-run approval');
    await inBrand((context) =>
      service.start(context, created.id, {
        reviewToken,
        acknowledgeWarnings: true,
      }),
    );
    expect(await phase(created.id, ['loading', 'finishing'])).toMatchObject({
      status: 'completed',
      credentialsEncrypted: null,
    });
  }

  async function snapshot() {
    const revisions: Record<string, unknown> = {};
    for (const table of [
      'tickets',
      'ticket_messages',
      'ticket_activity',
      'attachments',
      'contacts',
      'contact_identities',
      'report_daily',
      'report_agent_daily',
    ]) {
      const [row] = await owner.db.execute(
        sql`SELECT count(*)::int AS total, md5(coalesce(string_agg(row_to_json(t)::text || ':' || t.xmin::text, '' ORDER BY row_to_json(t)::text), '')) AS revision FROM ${sql.identifier(table)} t WHERE brand_id = ${brandId}`,
      );
      revisions[table] = row;
    }
    return revisions;
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
              'import.file_uploaded',
              'import.work_requested',
              'attachment.uploaded',
              'media.objects.purge',
              'help_center.imported',
            ].includes(event.event),
        )
        .map((event) => event.event),
    ).toEqual([]);
  }

  it('loads a 500-ticket bundle with private history and managed bytes, then repeats without any domain writes', async () => {
    const bytes = await readFile(
      new URL('../../../../packages/importers/fixtures/bundles/reference-500.zip', import.meta.url),
    );
    await migrate(bytes, 'bundle');
    const history = await owner.db.select().from(tickets).where(eq(tickets.brandId, brandId));
    expect(history).toHaveLength(500);
    expect(
      history.every((ticket) => ticket.createdAt.toISOString() === '2019-01-01T00:00:00.000Z'),
    ).toBe(true);
    const messages = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.brandId, brandId));
    expect(messages).toHaveLength(1000);
    expect(messages.filter((message) => message.kind === 'note')).toHaveLength(500);
    const stored = await owner.db
      .select()
      .from(attachments)
      .where(eq(attachments.brandId, brandId));
    expect(stored).toHaveLength(1);
    const attachment = stored[0];
    if (!attachment) throw new Error('Missing bundled attachment');
    expect(attachment).toMatchObject({ status: 'ready', origin: 'import' });
    expect(await queues.storage.read(attachment.s3Key)).toEqual(
      Buffer.from('%PDF-1.4\nSynthetic bundled receipt\n%%EOF\n'),
    );
    const before = await snapshot();
    await migrate(bytes, 'bundle');
    expect(await snapshot()).toEqual(before);
    await inert();
  }, 1200000);

  it('imports quoted multiline Arabic and explicit local dates using a saved CSV preset', async () => {
    const presets = new ImportFilePresetsService();
    const saved = await inBrand((context) =>
      presets.create(context, { name: 'Legacy CSV', headers, mapping: csvMapping }),
    );
    const available = await inBrand((context) =>
      presets.list(context, { entity: 'ticket', headerFingerprint: saved.headerFingerprint }),
    );
    expect(available.presets).toEqual([saved]);
    const bytes = Buffer.from(
      'Ticket ID,Subject,Created,Body\n0007,طلب قديم,03/11/2024 14:20,"مرحبًا\n""الرد الأصلي"""\n',
    );
    const preset = available.presets[0];
    if (!preset) throw new Error('Missing saved CSV preset');
    await migrate(bytes, 'csv', preset.mapping);
    const [ticket] = await owner.db.select().from(tickets).where(eq(tickets.subject, 'طلب قديم'));
    if (!ticket) throw new Error('Missing CSV ticket');
    expect(ticket).toMatchObject({
      createdAt: new Date('2024-11-03T11:20:00Z'),
      importSource: 'file',
    });
    const [message] = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticket.id));
    expect(message).toMatchObject({
      bodyText: 'مرحبًا\n"الرد الأصلي"',
      createdAt: new Date('2024-11-03T11:20:00Z'),
    });
    await inert();
  }, 1200000);
});
