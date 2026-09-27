import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import {
  hcAccessEnum,
  hcArticleStatusEnum,
  hcMediaPurposeEnum,
  hcMediaStatusEnum,
  hcVisibilityEnum,
  localeEnum,
} from './enums.js';
import { users } from './users.js';

/**
 * The help center's content (M5-01, REQUIREMENTS §4.5): category → section →
 * article, and one version of an article per locale.
 *
 * Every table here is brand-scoped and **not** department-scoped: help center
 * content belongs to the brand, and a Team Leader managing it is managing the
 * brand's knowledge, not a department's tickets (DOMAIN-RULES §1.2).
 *
 * **Names are per locale in one jsonb** (`{ en, ar }`), as `canned_responses`
 * keeps its bodies: a category is created, renamed and reordered as one thing
 * whatever language it is read in. An article's *text* is not, because each
 * language is written, published and made internal on its own — so that is a
 * row per locale in `hc_article_versions`.
 */

export const hcCategories = pgTable(
  'hc_categories',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** The url segment, `/en/categories/<slug>`. The same in every locale. */
    slug: varchar('slug', { length: 120 }).notNull(),
    names: jsonb('names').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    descriptions: jsonb('descriptions')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('hc_categories_brand_slug_key').on(table.brandId, table.slug)],
);

export const hcSections = pgTable(
  'hc_sections',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /**
     * `no action`: a category with sections in it is not deleted by accident,
     * while a brand's deletion, which cascades to both, is checked at the end
     * of the statement rather than row by row as `restrict` would be.
     */
    categoryId: uuid('category_id')
      .notNull()
      .references(() => hcCategories.id, { onDelete: 'no action' }),
    slug: varchar('slug', { length: 120 }).notNull(),
    names: jsonb('names').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('hc_sections_brand_slug_key').on(table.brandId, table.slug),
    index('hc_sections_category_idx').on(table.categoryId, table.position),
  ],
);

export const hcArticles = pgTable(
  'hc_articles',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** `no action`, for the reason `hc_sections.category_id` gives. */
    sectionId: uuid('section_id')
      .notNull()
      .references(() => hcSections.id, { onDelete: 'no action' }),
    /**
     * `/<locale>/articles/<slug>`: one slug for every language, so switching
     * language on a page changes the prefix and nothing else (the artboard's
     * `/en/…` and `/ar/…` of the same article).
     */
    slug: varchar('slug', { length: 120 }).notNull(),
    position: integer('position').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('hc_articles_brand_slug_key').on(table.brandId, table.slug),
    index('hc_articles_section_idx').on(table.sectionId, table.position),
  ],
);

/**
 * One language of one article.
 *
 * **Two copies of the text.** `title`, `description` and `body_html` are the
 * working copy the editor autosaves into; the `published_*` columns are what a
 * visitor reads, and change only when somebody publishes (or the scheduled
 * publish runs). Autosaving into the text visitors read would publish every
 * half-typed sentence of a live article.
 *
 * **`status` and `visibility` are live.** Making an article internal, or
 * archiving it, takes it away from visitors the moment it commits; the read
 * service filters on these two columns in SQL before anything else
 * (DOMAIN-RULES §5).
 *
 * `changed_at` moves whenever something a reader of the published help center
 * could notice moves: a publish, a status or visibility change. It is what the
 * read service's "changed since" answers from, so search (M5-05) and, from M7,
 * knowledge chunks can catch up without replaying the outbox.
 */
export const hcArticleVersions = pgTable(
  'hc_article_versions',
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
    locale: localeEnum('locale').notNull(),
    status: hcArticleStatusEnum('status').notNull().default('draft'),
    visibility: hcVisibilityEnum('visibility').notNull().default('public'),
    title: varchar('title', { length: 200 }).notNull(),
    description: varchar('description', { length: 160 }).notNull().default(''),
    /** Sanitised on the way in (`sanitizeArticleHtml`), never on the way out. */
    bodyHtml: text('body_html').notNull().default(''),
    publishedTitle: varchar('published_title', { length: 200 }),
    publishedDescription: varchar('published_description', { length: 160 }),
    publishedBodyHtml: text('published_body_html'),
    /** Extracted from the published html, for search (M5-05) and chunking (M7). */
    publishedBodyText: text('published_body_text'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** No foreign key: the name outlives the person, as on `audit_log`. */
    publishedBy: uuid('published_by'),
    /** Set while `status = 'scheduled'`, and only then. */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hc_article_versions_article_locale_key').on(table.articleId, table.locale),
    // The scheduled-publish tick's read: what is due, oldest first.
    index('hc_article_versions_scheduled_idx')
      .on(table.brandId, table.scheduledAt)
      .where(sql`${table.status} = 'scheduled'`),
    index('hc_article_versions_changed_idx').on(table.brandId, table.changedAt),
  ],
);

/**
 * A brand's help center as a whole (M5-09): who may read it. One row per
 * brand, written on first save; no row reads as the default, `public`.
 *
 * M5-06 adds the site: the theme, logo and favicon, the home page, the header
 * and footer links and the custom CSS. The jsonb columns are validated by the
 * schemas in `@helpdock/schemas` (`help-center-site.ts`) on write and parsed
 * with their defaults underneath on read, so a row written before a key
 * existed still renders.
 */
export const hcSettings = pgTable('hc_settings', {
  brandId: uuid('brand_id')
    .primaryKey()
    .references(() => brands.id, { onDelete: 'cascade' }),
  access: hcAccessEnum('access').notNull().default('public'),
  /** `{ accent, surfaceTone, radius, mode, font }` (DESIGN §8). */
  theme: jsonb('theme').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** A `ready` `hc_media` row uploaded for the purpose; cleared if the image goes. */
  logoMediaId: uuid('logo_media_id').references(() => hcMedia.id, { onDelete: 'set null' }),
  faviconMediaId: uuid('favicon_media_id').references(() => hcMedia.id, {
    onDelete: 'set null',
  }),
  /** `{ categories, featured, featuredArticleIds, popular }`. */
  home: jsonb('home').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** `{ header: [], footer: [] }`, each link `{ labelEn, labelAr, url }`. */
  links: jsonb('links').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Already sanitised (`custom-css.ts` in the api); rendered after the theme. */
  customCss: text('custom_css').notNull().default(''),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * An image pasted or inserted into an article (M5-02), and what the media
 * pipeline made of it: the upload is sniffed, re-encoded to WebP and stripped
 * of metadata by `help_center.media_process`, as a ticket attachment is by
 * `media.process` (ARCHITECTURE §9). Its own table because `attachments`
 * hangs off a ticket and follows the ticket's department; an article image
 * belongs to the brand.
 */
export const hcMedia = pgTable(
  'hc_media',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** The object the client PUT to. Built from uuids alone. */
    s3Key: text('s3_key').notNull(),
    originalName: text('original_name').notNull(),
    /** Declared at presign; rewritten from the magic bytes by the worker. */
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    status: hcMediaStatusEnum('status').notNull().default('pending'),
    /** An article image, or the site's logo or favicon (M5-06), which decides the largest edge. */
    purpose: hcMediaPurposeEnum('purpose').notNull().default('article'),
    /** A key, never a tool's stderr. */
    rejectReason: text('reject_reason'),
    /** The WebP the pipeline wrote. Null until `ready`. */
    webpKey: text('webp_key'),
    width: integer('width'),
    height: integer('height'),
    uploadedBy: uuid('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('hc_media_s3_key_key').on(table.s3Key)],
);

export type HcCategory = typeof hcCategories.$inferSelect;
export type NewHcCategory = typeof hcCategories.$inferInsert;
export type HcSection = typeof hcSections.$inferSelect;
export type NewHcSection = typeof hcSections.$inferInsert;
export type HcArticle = typeof hcArticles.$inferSelect;
export type NewHcArticle = typeof hcArticles.$inferInsert;
export type HcArticleVersion = typeof hcArticleVersions.$inferSelect;
export type NewHcArticleVersion = typeof hcArticleVersions.$inferInsert;
export type HcSettings = typeof hcSettings.$inferSelect;
export type HcMedia = typeof hcMedia.$inferSelect;
export type NewHcMedia = typeof hcMedia.$inferInsert;
