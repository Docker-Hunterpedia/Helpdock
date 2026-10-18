import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { importSourceEnum, localeEnum } from './enums.js';
import { hcArticles, hcMedia } from './help-center.js';

/** Immutable prepared content identity; run-specific progress belongs to import_records. */
export const hcImportAssets = pgTable(
  'hc_import_assets',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    source: importSourceEnum('source').notNull(),
    sourceAccountKey: char('source_account_key', { length: 64 }).notNull(),
    parentExternalId: varchar('parent_external_id', { length: 200 }).notNull(),
    assetExternalId: varchar('asset_external_id', { length: 200 }).notNull(),
    locale: localeEnum('locale').notNull(),
    usage: varchar('usage', { length: 8 }).$type<'image' | 'download'>().notNull(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    mediaId: uuid('media_id').notNull(),
    articleId: uuid('article_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.brandId, table.mediaId],
      foreignColumns: [hcMedia.brandId, hcMedia.id],
      name: 'hc_import_assets_media_brand_fk',
    }).onDelete('no action'),
    foreignKey({
      columns: [table.brandId, table.articleId],
      foreignColumns: [hcArticles.brandId, hcArticles.id],
      name: 'hc_import_assets_article_brand_fk',
    }).onDelete('cascade'),
    check(
      'hc_import_assets_hashes_check',
      sql`${table.sourceAccountKey} ~ '^[0-9a-f]{64}$' AND ${table.payloadHash} ~ '^[0-9a-f]{64}$' AND ${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('hc_import_assets_usage_check', sql`${table.usage} IN ('image', 'download')`),
    uniqueIndex('hc_import_assets_identity_key').on(
      table.brandId,
      table.source,
      table.sourceAccountKey,
      table.parentExternalId,
      table.locale,
      table.assetExternalId,
      table.usage,
      table.payloadHash,
      table.contentHash,
    ),
    index('hc_import_assets_media_idx').on(table.mediaId),
    index('hc_import_assets_article_idx').on(table.brandId, table.articleId, table.locale),
    index('hc_import_assets_created_idx').on(table.createdAt, table.id),
  ],
);

export type HcImportAsset = typeof hcImportAssets.$inferSelect;
