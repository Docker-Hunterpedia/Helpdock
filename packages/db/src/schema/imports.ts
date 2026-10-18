import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import {
  importEntityEnum,
  importLogLevelEnum,
  importMappingKindEnum,
  importModeEnum,
  importRecordStatusEnum,
  importSourceEnum,
  importStatusEnum,
} from './enums.js';
import { users } from './users.js';

/** Brand-admin staging data; every child binds its run and brand in a composite foreign key. */
export const importRuns = pgTable(
  'import_runs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    source: importSourceEnum('source').notNull(),
    sourceAccountKey: char('source_account_key', { length: 64 })
      .notNull()
      .default('0000000000000000000000000000000000000000000000000000000000000000'),
    mode: importModeEnum('mode').notNull().default('full'),
    parentRunId: uuid('parent_run_id'),
    status: importStatusEnum('status').notNull().default('draft'),
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    credentialsEncrypted: text('credentials_encrypted'),
    cursors: jsonb('cursors').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    counts: jsonb('counts').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    dryRunReport: jsonb('dry_run_report').$type<Record<string, unknown>>(),
    error: text('error'),
    startedBy: uuid('started_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimToken: uuid('claim_token'),
    pausedFrom: importStatusEnum('paused_from'),
  },
  (table) => [
    check('import_runs_account_key_shape', sql`${table.sourceAccountKey} ~ '^[0-9a-f]{64}$'`),
    unique('import_runs_brand_id_key').on(table.brandId, table.id),
    foreignKey({
      columns: [table.brandId, table.parentRunId],
      foreignColumns: [table.brandId, table.id],
      name: 'import_runs_parent_brand_fk',
    }).onDelete('cascade'),
    check(
      'import_runs_parent_shape',
      sql`(${table.mode} = 'full' AND ${table.parentRunId} IS NULL) OR (${table.mode} = 'delta' AND ${table.parentRunId} IS NOT NULL AND ${table.parentRunId} <> ${table.id})`,
    ),
    check(
      'import_runs_terminal_credentials',
      sql`${table.status} NOT IN ('completed', 'failed', 'cancelled') OR ${table.credentialsEncrypted} IS NULL`,
    ),
    check(
      'import_runs_claim_shape',
      sql`(${table.claimToken} IS NULL AND ${table.claimedAt} IS NULL) OR (${table.claimToken} IS NOT NULL AND ${table.claimedAt} IS NOT NULL AND ${table.status} IN ('extracting', 'dry_run', 'loading', 'finishing'))`,
    ),
    check(
      'import_runs_pause_shape',
      sql`(${table.status} = 'paused' AND ${table.pausedFrom} IS NOT NULL AND ${table.pausedFrom} IN ('extracting', 'dry_run', 'loading', 'finishing')) OR (${table.status} <> 'paused' AND ${table.pausedFrom} IS NULL)`,
    ),
    uniqueIndex('import_runs_brand_claim_key')
      .on(table.brandId)
      .where(sql`${table.claimToken} IS NOT NULL`),
    index('import_runs_brand_created_idx').on(table.brandId, table.createdAt, table.id),
    index('import_runs_brand_finished_idx')
      .on(table.brandId, table.finishedAt, table.id)
      .where(sql`${table.finishedAt} IS NOT NULL`),
    index('import_runs_claim_idx').on(table.status, table.claimedAt),
  ],
);

export const importRecords = pgTable(
  'import_records',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    entity: importEntityEnum('entity').notNull(),
    externalId: varchar('external_id', { length: 200 }).notNull(),
    parentExternalId: varchar('parent_external_id', { length: 200 }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    loadHash: char('load_hash', { length: 64 }),
    dryRunIdentity: jsonb('dry_run_identity').$type<Record<string, unknown>>(),
    dryRunMedia: jsonb('dry_run_media').$type<Record<string, unknown>>(),
    preparedAssets: jsonb('prepared_assets').$type<Record<string, unknown>>(),
    status: importRecordStatusEnum('status').notNull().default('staged'),
    helpdockId: uuid('helpdock_id'),
    error: text('error'),
  },
  (table) => [
    foreignKey({
      columns: [table.brandId, table.runId],
      foreignColumns: [importRuns.brandId, importRuns.id],
    }).onDelete('cascade'),
    unique('import_records_external_key').on(table.runId, table.entity, table.externalId),
    check('import_records_hash_shape', sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    index('import_records_parent_idx').on(table.runId, table.parentExternalId, table.entity),
    index('import_records_load_idx').on(table.runId, table.entity, table.status, table.id),
    index('import_records_article_translation_idx')
      .on(table.brandId, table.runId, sql`(${table.payload} ->> 'translationOf')`)
      .where(sql`${table.entity} = 'article'`),
  ],
);

export const importMappings = pgTable(
  'import_mappings',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    kind: importMappingKindEnum('kind').notNull(),
    externalValue: varchar('external_value', { length: 300 }).notNull(),
    target: jsonb('target').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.brandId, table.runId],
      foreignColumns: [importRuns.brandId, importRuns.id],
    }).onDelete('cascade'),
    unique('import_mappings_external_key').on(table.runId, table.kind, table.externalValue),
  ],
);

export const importExternalIds = pgTable(
  'import_external_ids',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    source: importSourceEnum('source').notNull(),
    sourceAccountKey: char('source_account_key', { length: 64 })
      .notNull()
      .default('0000000000000000000000000000000000000000000000000000000000000000'),
    entity: importEntityEnum('entity').notNull(),
    externalId: varchar('external_id', { length: 200 }).notNull(),
    helpdockId: uuid('helpdock_id').notNull(),
    sourceUrl: text('source_url'),
    sourceNumber: varchar('source_number', { length: 50 }),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'import_external_ids_pk',
      columns: [
        table.brandId,
        table.source,
        table.sourceAccountKey,
        table.entity,
        table.externalId,
      ],
    }),
    check(
      'import_external_ids_account_key_shape',
      sql`${table.sourceAccountKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check('import_external_ids_hash_shape', sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    index('import_external_ids_helpdock_idx').on(table.brandId, table.entity, table.helpdockId),
    index('import_external_ids_number_idx').on(table.brandId, table.sourceNumber),
    index('import_external_ids_native_lookup_idx').on(
      table.brandId,
      table.entity,
      table.externalId,
    ),
  ],
);

export const importLog = pgTable(
  'import_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    level: importLogLevelEnum('level').notNull(),
    entity: importEntityEnum('entity'),
    externalId: varchar('external_id', { length: 200 }),
    message: text('message').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.brandId, table.runId],
      foreignColumns: [importRuns.brandId, importRuns.id],
    }).onDelete('cascade'),
    index('import_log_run_cursor_idx').on(table.runId, table.id),
    index('import_log_run_level_cursor_idx').on(table.runId, table.level, table.id),
  ],
);

export const importFilePresets = pgTable(
  'import_file_presets',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    entity: importEntityEnum('entity').notNull(),
    headerFingerprint: char('header_fingerprint', { length: 64 }).notNull(),
    mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('import_file_presets_name_key').on(table.brandId, sql`lower(${table.name})`),
    index('import_file_presets_headers_idx').on(table.brandId, table.headerFingerprint),
  ],
);

export const importFiles = pgTable(
  'import_files',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    revision: uuid('revision').notNull().$defaultFn(uuidv7),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    format: varchar('format', { length: 10 }).notNull(),
    entity: importEntityEnum('entity'),
    size: bigint('size', { mode: 'number' }).notNull(),
    uploadKey: text('upload_key').notNull(),
    sourceKey: text('source_key'),
    preparationKey: text('preparation_key'),
    sha256: char('sha256', { length: 64 }),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    headers: jsonb('headers').$type<string[]>(),
    sampleRows:
      jsonb('sample_rows').$type<{ cells: string[]; line: number; truncated: boolean }[]>(),
    mapping: jsonb('mapping').$type<Record<string, unknown>>(),
    inventoryMapping: jsonb('inventory_mapping').$type<Record<string, unknown>>(),
    inventoryValidation: jsonb('inventory_validation').$type<Record<string, unknown>>(),
    validation: jsonb('validation').$type<Record<string, unknown>>(),
    recordCount: integer('record_count'),
    error: varchar('error', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({
      columns: [table.brandId, table.runId],
      foreignColumns: [importRuns.brandId, importRuns.id],
    }).onDelete('cascade'),
    index('import_files_run_idx').on(table.brandId, table.runId, table.id),
    unique('import_files_brand_run_id_key').on(table.brandId, table.runId, table.id),
    index('import_files_work_idx').on(table.status, table.updatedAt),
    check('import_files_size', sql`${table.size} > 0 AND ${table.size} <= 2147483648`),
    check(
      'import_files_format',
      sql`(${table.format} = 'csv' AND ${table.entity} IS NOT NULL) OR (${table.format} = 'bundle' AND ${table.entity} IS NULL)`,
    ),
    check(
      'import_files_status',
      sql`${table.status} IN ('pending', 'uploaded', 'ready', 'invalid', 'discarded')`,
    ),
    check(
      'import_files_sealed',
      sql`${table.status} <> 'ready' OR (${table.sourceKey} IS NOT NULL AND ${table.sha256} IS NOT NULL AND ${table.sha256} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/** Native-ID inventories are staging only; they cannot carry URLs or bypass source authentication. */
export const importTicketInventory = pgTable(
  'import_ticket_inventory',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    fileId: uuid('file_id').notNull(),
    revision: uuid('revision').notNull(),
    sourceHash: char('source_hash', { length: 64 }).notNull(),
    externalId: varchar('external_id', { length: 200 }).notNull(),
    location: varchar('location', { length: 8 }).notNull(),
    line: bigint('line', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'import_ticket_inventory_file_fk',
      columns: [table.brandId, table.runId, table.fileId],
      foreignColumns: [importFiles.brandId, importFiles.runId, importFiles.id],
    }).onDelete('cascade'),
    uniqueIndex('import_ticket_inventory_native_key').on(
      table.fileId,
      table.revision,
      table.sourceHash,
      table.externalId,
    ),
    index('import_ticket_inventory_run_idx').on(
      table.brandId,
      table.runId,
      sql`${table.externalId} COLLATE "C"`,
    ),
    check('import_ticket_inventory_id_shape', sql`${table.externalId} ~ '^[!-~]+$'`),
    check('import_ticket_inventory_hash_shape', sql`${table.sourceHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'import_ticket_inventory_location',
      sql`${table.location} IN ('active', 'archived', 'auto')`,
    ),
    check(
      'import_ticket_inventory_line',
      sql`${table.line} > 0 AND ${table.line} <= 9007199254740991`,
    ),
  ],
);

/** Immutable successful GET responses used only while extraction may resume. */
export const importPages = pgTable(
  'import_pages',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.brandId, table.runId],
      foreignColumns: [importRuns.brandId, importRuns.id],
    }).onDelete('cascade'),
    unique('import_pages_request_key').on(table.runId, table.requestHash),
    check('import_pages_hash_shape', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
