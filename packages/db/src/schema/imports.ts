import { sql } from 'drizzle-orm';
import {
  bigserial,
  char,
  check,
  foreignKey,
  index,
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
  },
  (table) => [
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
    index('import_runs_brand_created_idx').on(table.brandId, table.createdAt, table.id),
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
    index('import_records_load_idx').on(table.runId, table.entity, table.status, table.id),
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
    entity: importEntityEnum('entity').notNull(),
    externalId: varchar('external_id', { length: 200 }).notNull(),
    helpdockId: uuid('helpdock_id').notNull(),
    sourceUrl: text('source_url'),
    sourceNumber: varchar('source_number', { length: 50 }),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.brandId, table.source, table.entity, table.externalId] }),
    check('import_external_ids_hash_shape', sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    index('import_external_ids_helpdock_idx').on(table.brandId, table.entity, table.helpdockId),
    index('import_external_ids_number_idx').on(table.brandId, table.sourceNumber),
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
