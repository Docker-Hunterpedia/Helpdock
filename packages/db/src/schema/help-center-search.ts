import { type SQL, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { hcSearchSourceEnum, localeEnum } from './enums.js';
import { hcArticles, hcArticleVersions } from './help-center.js';
import { tsvector } from './tsvector.js';

/**
 * Help center search, feedback and views (M5-05, M5-08). Brand-scoped tenant
 * tables, none department-scoped, for the reason `help-center.ts` gives.
 */

/**
 * Lower case, Arabic diacritics and tatweel removed, and the alef, yaa and
 * taa marbuta variants folded, so a trigram comparison is not thrown by a
 * harakah or a hamza the visitor did not type. `apps/api`'s search mirrors it
 * for the query (`normalizeForTrigram`); a test holds the two together.
 */
export const trigramNormalized = (column: string): string =>
  `lower(translate(regexp_replace(${column}, '[\\u064B-\\u065F\\u0670\\u0640]', '', 'g'), 'أإآٱىة', 'اااايه'))`;

/**
 * The search index: the **published** text of every published version, one
 * row per version (M5-05). Written by the search subscriber from the
 * `help_center.*` events and never by a request; a version that stops being
 * published loses its row. Internal versions are indexed too, for staff
 * search — who may *match* is decided at query time by joining the live
 * version through `readableVersions(audience)`, so a row that is a few
 * seconds stale can never show a visitor what the live row no longer allows.
 *
 * `search` is weighted title (A) over description (B) over body (C), in the
 * language's own configuration: `arabic` for `ar`, `english` for `en`.
 */
export const hcSearchDocuments = pgTable(
  'hc_search_documents',
  {
    versionId: uuid('version_id')
      .primaryKey()
      .references(() => hcArticleVersions.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => hcArticles.id, { onDelete: 'cascade' }),
    locale: localeEnum('locale').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    /** The title as the trigram match compares it. */
    titleNormalized: text('title_normalized').generatedAlwaysAs(
      (): SQL => sql.raw(trigramNormalized('"title"')),
    ),
    search: tsvector('search').generatedAlwaysAs(
      (): SQL =>
        sql.raw(`setweight(to_tsvector(case when "locale" = 'ar' then 'arabic'::regconfig else 'english'::regconfig end, "title"), 'A')
      || setweight(to_tsvector(case when "locale" = 'ar' then 'arabic'::regconfig else 'english'::regconfig end, "description"), 'B')
      || setweight(to_tsvector(case when "locale" = 'ar' then 'arabic'::regconfig else 'english'::regconfig end, "body_text"), 'C')`),
    ),
    /** The version's `changed_at` this row was built from; a re-index skips a row already current. */
    sourceChangedAt: timestamp('source_changed_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Under FORCEd row-level security a GIN index cannot run ahead of the
    // policy (ADR 0011), so the brand and language narrow the rows by btree
    // and the match runs over what is left: at most 5 000 articles per brand.
    index('hc_search_documents_brand_locale_idx').on(table.brandId, table.locale),
    index('hc_search_documents_article_idx').on(table.articleId),
  ],
);

/**
 * Every search typed into the help center or the widget (M5-05), for the
 * Insights tab. Kept for the brand's search log window (DOMAIN-RULES §11, 180
 * days by default) and then deleted by `maintenance.retention`. Holds the
 * query and never who typed it.
 */
export const hcSearchLog = pgTable(
  'hc_search_log',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Trimmed, whitespace collapsed and lower-cased, so "Refund " and "refund" count together. */
    query: varchar('query', { length: 200 }).notNull(),
    locale: localeEnum('locale').notNull(),
    source: hcSearchSourceEnum('source').notNull(),
    hits: integer('hits').notNull(),
    /** Set the first time a visitor opens a hit of this search. */
    openedAt: timestamp('opened_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('hc_search_log_brand_created_idx').on(table.brandId, table.createdAt)],
);

/**
 * One row per visitor per article per day (M5-08): the view count's dedupe.
 * `visitor_hash` is a hash of whatever key the caller identifies a visitor by
 * (a widget visitor id, a help center cookie), never the key itself. Kept for
 * the search log window with the log.
 */
export const hcArticleViews = pgTable(
  'hc_article_views',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => hcArticles.id, { onDelete: 'cascade' }),
    visitorHash: varchar('visitor_hash', { length: 64 }).notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    /** The language of the first view that day. */
    locale: localeEnum('locale').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.visitorHash, table.day] }),
    index('hc_article_views_brand_day_idx').on(table.brandId, table.day),
  ],
);

/**
 * "Was this helpful?" (M5-08): one answer per visitor per article version —
 * one language of one article — and a second answer replaces the first. A
 * "No" may carry a comment, which staff read and nobody answers.
 */
export const hcArticleFeedback = pgTable(
  'hc_article_feedback',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => hcArticles.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => hcArticleVersions.id, { onDelete: 'cascade' }),
    locale: localeEnum('locale').notNull(),
    visitorHash: varchar('visitor_hash', { length: 64 }).notNull(),
    helpful: boolean('helpful').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hc_article_feedback_version_visitor_key').on(table.versionId, table.visitorHash),
    index('hc_article_feedback_brand_updated_idx').on(table.brandId, table.updatedAt),
  ],
);

export type HcSearchDocument = typeof hcSearchDocuments.$inferSelect;
export type HcSearchLogEntry = typeof hcSearchLog.$inferSelect;
export type HcArticleView = typeof hcArticleViews.$inferSelect;
export type HcArticleFeedback = typeof hcArticleFeedback.$inferSelect;
