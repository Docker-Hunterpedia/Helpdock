import { z } from 'zod';
import { localeSchema } from './brand.js';

/**
 * The help center's content (M5-01, M5-02, M5-09; REQUIREMENTS §4.5).
 *
 * **Category → section → article, and one version per locale.** A category
 * and a section are named in every language on the same row; an article is a
 * slug and a place in the tree, and its text lives in one version per locale,
 * because each language is written, published and made internal on its own.
 *
 * **A version has a working copy and a published copy.** The editor autosaves
 * the working copy; a visitor reads the published one, which changes only when
 * somebody publishes (or the scheduled publish runs). `hasUnpublishedChanges`
 * is the difference between the two.
 *
 * **Visibility is per version and live** (DOMAIN-RULES §5): making one
 * internal takes it away from every visitor-facing read the moment it commits.
 */

export const HC_SLUG_MAX = 120;
export const HC_NAME_MAX = 120;
export const HC_CATEGORY_DESCRIPTION_MAX = 300;
export const HC_TITLE_MAX = 200;
/** The search description: what a results page shows under the title. */
export const HC_DESCRIPTION_MAX = 160;
/** Of the stored, sanitised html. A long article is tens of kilobytes. */
export const HC_BODY_MAX = 500_000;
/** Of a Markdown file the editor imports. */
export const HC_MARKDOWN_MAX = 200_000;
export const HC_MAX_CATEGORIES = 100;
export const HC_MAX_SECTIONS = 500;
export const HC_MAX_ARTICLES = 5_000;
/** An article image before re-encoding. The WebP it becomes is far smaller. */
export const HC_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Entries the Activity panel shows; the audit log has the rest. */
export const HC_ACTIVITY_LIMIT = 10;

export type HcLocale = z.infer<typeof localeSchema>;

/**
 * Lower-case ASCII words joined by single hyphens. One slug serves every
 * language (`/en/articles/<slug>` and `/ar/articles/<slug>`), so it is written
 * in the script every URL bar and every search engine handles alike.
 */
export const hcSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(HC_SLUG_MAX)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lower-case letters, digits and single hyphens');

/**
 * A slug from a title: ASCII letters and digits kept, everything else a
 * hyphen. An Arabic-only title has none, and gets `fallback` instead.
 */
export const slugify = (text: string, fallback: string): string => {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, HC_SLUG_MAX)
    .replace(/-+$/, '');

  return slug === '' ? fallback : slug;
};

export const hcArticleStatusSchema = z.enum(['draft', 'scheduled', 'published', 'archived']);
export type HcArticleStatus = z.infer<typeof hcArticleStatusSchema>;

export const hcVisibilitySchema = z.enum(['public', 'internal']);
export type HcVisibility = z.infer<typeof hcVisibilitySchema>;

/**
 * Who a read is for (DOMAIN-RULES §5): `public` is a visitor, the sitemap and
 * public search; `internal` is signed-in staff, who may read both.
 */
export const hcAudienceSchema = z.enum(['public', 'internal']);
export type HcAudience = z.infer<typeof hcAudienceSchema>;

/** A brand's help center as a whole: open to visitors, or staff only (M5-09). */
export const hcAccessSchema = z.enum(['public', 'internal_only']);
export type HcAccess = z.infer<typeof hcAccessSchema>;

const nameSchema = z.string().trim().max(HC_NAME_MAX);

/** A name in each language; one of the two may be empty, not both. */
export const hcNamesSchema = z
  .object({ en: nameSchema, ar: nameSchema })
  .refine((names) => names.en !== '' || names.ar !== '', 'must have a name in one language');
export type HcNames = z.infer<typeof hcNamesSchema>;

export const hcDescriptionsSchema = z.object({
  en: z.string().trim().max(HC_CATEGORY_DESCRIPTION_MAX),
  ar: z.string().trim().max(HC_CATEGORY_DESCRIPTION_MAX),
});
export type HcDescriptions = z.infer<typeof hcDescriptionsSchema>;

/**
 * Why a help center change was refused, which the admin turns into a sentence:
 * a slug already in use, a category or section that still has children, an
 * article that was published once (it is archived instead of deleted, so no
 * consumer of the published help center is left pointing at nothing), a
 * scheduled time that has passed, or a brand at one of the ceilings above.
 */
export const hcRefusalSchema = z.enum([
  'slug-taken',
  'not-empty',
  'was-published',
  'schedule-in-past',
  'limit-reached',
  // M5-06: an accent below 3:1 on the surface (DESIGN §8), an image that is
  // not a finished upload for that purpose, a featured article that is not
  // this brand's.
  'low-contrast',
  'media-not-ready',
  'unknown-article',
]);
export type HcRefusal = z.infer<typeof hcRefusalSchema>;

// --------------------------------------------------------------------------
// The admin's structure: the tree and the list
// --------------------------------------------------------------------------

export const hcCategorySchema = z.object({
  id: z.uuid(),
  slug: hcSlugSchema,
  names: z.object({ en: z.string(), ar: z.string() }),
  descriptions: z.object({ en: z.string(), ar: z.string() }),
  position: z.int(),
});
export type HcCategory = z.infer<typeof hcCategorySchema>;

export const hcSectionSchema = z.object({
  id: z.uuid(),
  categoryId: z.uuid(),
  slug: hcSlugSchema,
  names: z.object({ en: z.string(), ar: z.string() }),
  position: z.int(),
});
export type HcSection = z.infer<typeof hcSectionSchema>;

/** One language of an article, as the list shows it. */
export const hcVersionSummarySchema = z.object({
  locale: localeSchema,
  status: hcArticleStatusSchema,
  visibility: hcVisibilitySchema,
  title: z.string(),
  /** Set while `scheduled`. */
  scheduledAt: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  updatedByName: z.string().nullable(),
  /** The working copy differs from what visitors read. */
  hasUnpublishedChanges: z.boolean(),
});
export type HcVersionSummary = z.infer<typeof hcVersionSummarySchema>;

export const hcArticleSummarySchema = z.object({
  id: z.uuid(),
  sectionId: z.uuid(),
  slug: hcSlugSchema,
  position: z.int(),
  versions: z.array(hcVersionSummarySchema),
});
export type HcArticleSummary = z.infer<typeof hcArticleSummarySchema>;

/** `GET …/help-center/structure`: everything the Articles tab draws. */
export const hcStructureSchema = z.object({
  defaultLocale: localeSchema,
  /** The brand's, which a scheduled time is entered and shown in. */
  timezone: z.string(),
  categories: z.array(hcCategorySchema),
  sections: z.array(hcSectionSchema),
  articles: z.array(hcArticleSummarySchema),
});
export type HcStructure = z.infer<typeof hcStructureSchema>;

export const hcCategoryCreateRequestSchema = z.object({
  names: hcNamesSchema,
  descriptions: hcDescriptionsSchema.optional(),
  /** Derived from the English name when left out. */
  slug: hcSlugSchema.optional(),
});
export type HcCategoryCreateRequest = z.infer<typeof hcCategoryCreateRequestSchema>;

export const hcCategoryUpdateRequestSchema = z
  .object({
    names: hcNamesSchema.optional(),
    descriptions: hcDescriptionsSchema.optional(),
    slug: hcSlugSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'must change something');
export type HcCategoryUpdateRequest = z.infer<typeof hcCategoryUpdateRequestSchema>;

export const hcSectionCreateRequestSchema = z.object({
  categoryId: z.uuid(),
  names: hcNamesSchema,
  slug: hcSlugSchema.optional(),
});
export type HcSectionCreateRequest = z.infer<typeof hcSectionCreateRequestSchema>;

export const hcSectionUpdateRequestSchema = z
  .object({
    names: hcNamesSchema.optional(),
    slug: hcSlugSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'must change something');
export type HcSectionUpdateRequest = z.infer<typeof hcSectionUpdateRequestSchema>;

/**
 * A new order for every child of one parent: the categories (no parent), the
 * sections of one category, or the articles of one section. Naming an id that
 * belongs to another parent *moves* it there, which is how a drag across the
 * tree lands.
 */
export const hcReorderRequestSchema = z.object({
  parentId: z.uuid().nullable(),
  ids: z.array(z.uuid()).min(1).max(HC_MAX_ARTICLES),
});
export type HcReorderRequest = z.infer<typeof hcReorderRequestSchema>;

// --------------------------------------------------------------------------
// One article in the editor
// --------------------------------------------------------------------------

export const hcArticleCreateRequestSchema = z.object({
  sectionId: z.uuid(),
  locale: localeSchema,
  title: z.string().trim().min(1).max(HC_TITLE_MAX),
  /** Derived from the title when left out. */
  slug: hcSlugSchema.optional(),
});
export type HcArticleCreateRequest = z.infer<typeof hcArticleCreateRequestSchema>;

export const hcArticleUpdateRequestSchema = z
  .object({
    slug: hcSlugSchema.optional(),
    sectionId: z.uuid().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'must change something');
export type HcArticleUpdateRequest = z.infer<typeof hcArticleUpdateRequestSchema>;

/** The editor's autosave of one language's working copy. Creates the version if it is new. */
export const hcVersionSaveRequestSchema = z.object({
  title: z.string().trim().min(1).max(HC_TITLE_MAX),
  description: z.string().trim().max(HC_DESCRIPTION_MAX),
  /** Sanitised by the api against the article allowlist before it is stored. */
  bodyHtml: z.string().max(HC_BODY_MAX),
});
export type HcVersionSaveRequest = z.infer<typeof hcVersionSaveRequestSchema>;

/**
 * The Status select. `published` publishes the working copy as it stands,
 * which is also what "Publish changes" sends; `scheduled` does the same at
 * `scheduledAt`, which must be in the future.
 */
export const hcVersionStatusRequestSchema = z
  .object({
    status: hcArticleStatusSchema,
    /** Required with `scheduled`, refused with anything else. */
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((body) => (body.status === 'scheduled') === (body.scheduledAt !== undefined), {
    message: 'scheduledAt goes with status scheduled, and only with it',
    path: ['scheduledAt'],
  });
export type HcVersionStatusRequest = z.infer<typeof hcVersionStatusRequestSchema>;

export const hcVersionVisibilityRequestSchema = z.object({ visibility: hcVisibilitySchema });
export type HcVersionVisibilityRequest = z.infer<typeof hcVersionVisibilityRequestSchema>;

export const hcVersionSchema = hcVersionSummarySchema.extend({
  description: z.string(),
  bodyHtml: z.string(),
  publishedByName: z.string().nullable(),
});
export type HcVersion = z.infer<typeof hcVersionSchema>;

/** What the Activity panel names, from the audit log's `hc_article.*` rows. */
export const hcActivityActionSchema = z.enum([
  'created',
  'edited',
  'published',
  'scheduled',
  'unpublished',
  'archived',
  'visibility_changed',
  'moved',
  'slug_changed',
]);
export type HcActivityAction = z.infer<typeof hcActivityActionSchema>;

export const hcActivityEntrySchema = z.object({
  id: z.uuid(),
  action: hcActivityActionSchema,
  locale: localeSchema.nullable(),
  /** Null for the scheduled publish, which no person ran. */
  actorName: z.string().nullable(),
  at: z.iso.datetime(),
  /** The scheduled time, or the new visibility, when the action has one. */
  detail: z.string().nullable(),
});
export type HcActivityEntry = z.infer<typeof hcActivityEntrySchema>;

export const hcArticleSchema = z.object({
  id: z.uuid(),
  sectionId: z.uuid(),
  slug: hcSlugSchema,
  versions: z.array(hcVersionSchema),
  activity: z.array(hcActivityEntrySchema),
});
export type HcArticle = z.infer<typeof hcArticleSchema>;

// --------------------------------------------------------------------------
// The help center as a whole (M5-09)
// --------------------------------------------------------------------------

export const hcSettingsSchema = z.object({ access: hcAccessSchema });
export type HcSettings = z.infer<typeof hcSettingsSchema>;

export const hcSettingsUpdateRequestSchema = hcSettingsSchema;
export type HcSettingsUpdateRequest = z.infer<typeof hcSettingsUpdateRequestSchema>;

// --------------------------------------------------------------------------
// Article images (M5-02 over the M1-10 pipeline)
// --------------------------------------------------------------------------

/** What an article image may be uploaded as. Everything becomes WebP. */
export const HC_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const hcMediaPresignRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mime: z.enum(HC_IMAGE_MIME_TYPES),
  size: z.int().positive().max(HC_IMAGE_MAX_BYTES),
  /** M5-06: a logo or favicon is scaled to 512 px rather than 2048. */
  purpose: z.enum(['article', 'logo', 'favicon']).default('article'),
});
export type HcMediaPresignRequest = z.input<typeof hcMediaPresignRequestSchema>;

export const hcMediaPresignResponseSchema = z.object({
  mediaId: z.uuid(),
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type HcMediaPresignResponse = z.infer<typeof hcMediaPresignResponseSchema>;

export const hcMediaStatusSchema = z.enum(['pending', 'processing', 'ready', 'rejected']);
export type HcMediaStatus = z.infer<typeof hcMediaStatusSchema>;

export const hcMediaSchema = z.object({
  id: z.uuid(),
  status: hcMediaStatusSchema,
  /** The path an article's `<img src>` names once `ready`. */
  src: z.string().nullable(),
  width: z.int().nullable(),
  height: z.int().nullable(),
  rejectReason: z.string().nullable(),
});
export type HcMedia = z.infer<typeof hcMediaSchema>;

/**
 * The one image source an article may carry: this install's own redirect to a
 * five-minute presigned URL (ARCHITECTURE §9). Anything else in an `<img src>`
 * is dropped by the sanitiser, so an article cannot hotlink a tracking pixel.
 */
export const hcMediaPath = (brandId: string, mediaId: string): string =>
  `/api/help-center/brands/${brandId}/media/${mediaId}`;

export const HC_MEDIA_PATH_PATTERN =
  /^\/api\/help-center\/brands\/[0-9a-f-]{36}\/media\/[0-9a-f-]{36}$/;

/** The two kinds of callout the editor offers, and the only two the sanitiser keeps. */
export const CALLOUT_KINDS = ['tip', 'caution'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/**
 * The embed address of a video an author pasted, or null when it is not one
 * we embed. Only YouTube (through its no-cookie host) and Vimeo: an embed is
 * an iframe on the help center, and an allowlist of two players is what keeps
 * that iframe from being any page an author, or an API caller, chose.
 */
export const videoEmbedUrl = (input: string): string | null => {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const youtubeId = (id: string | null | undefined): string | null =>
    id !== null && id !== undefined && /^[A-Za-z0-9_-]{11}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : null;
  const vimeoId = (id: string | undefined): string | null =>
    id !== undefined && /^\d{1,12}$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;

  switch (host) {
    case 'youtube.com':
    case 'youtube-nocookie.com':
      if (segments[0] === 'watch') {
        return youtubeId(url.searchParams.get('v'));
      }
      return segments[0] === 'embed' || segments[0] === 'shorts' ? youtubeId(segments[1]) : null;
    case 'youtu.be':
      return youtubeId(segments[0]);
    case 'vimeo.com':
      return vimeoId(segments[0]);
    case 'player.vimeo.com':
      return segments[0] === 'video' ? vimeoId(segments[1]) : null;
    default:
      return null;
  }
};

// --------------------------------------------------------------------------
// Route parameters
// --------------------------------------------------------------------------

const brand = z.object({ brandId: z.uuid() });
export const hcCategoryParamSchema = brand.extend({ categoryId: z.uuid() });
export const hcSectionParamSchema = brand.extend({ sectionId: z.uuid() });
export const hcArticleParamSchema = brand.extend({ articleId: z.uuid() });
export const hcVersionParamSchema = hcArticleParamSchema.extend({ locale: localeSchema });
export const hcMediaParamSchema = brand.extend({ mediaId: z.uuid() });

// --------------------------------------------------------------------------
// The read side, for the help center pages, sitemap and search (wave 2)
// --------------------------------------------------------------------------

/** An article as a reader of the published help center sees it. */
export const hcPublishedArticleSchema = z.object({
  id: z.uuid(),
  slug: hcSlugSchema,
  /** The language of the text, which is the default locale's on a fallback. */
  locale: localeSchema,
  /** True when the requested language had no readable version. */
  fallback: z.boolean(),
  visibility: hcVisibilitySchema,
  title: z.string(),
  description: z.string(),
  bodyHtml: z.string(),
  publishedAt: z.iso.datetime(),
  /** Every language this article can be read in by the same audience, for hreflang. */
  locales: z.array(localeSchema),
  section: z.object({ id: z.uuid(), slug: hcSlugSchema, name: z.string() }),
  category: z.object({ id: z.uuid(), slug: hcSlugSchema, name: z.string() }),
});
export type HcPublishedArticle = z.infer<typeof hcPublishedArticleSchema>;

/**
 * An article looked up by slug: readable, gone (archived — the page answers
 * 410), or not there for this audience (a draft, or internal to a visitor —
 * 404, which says nothing about whether it exists).
 */
export type HcArticleLookup =
  | { readonly state: 'found'; readonly article: HcPublishedArticle }
  | { readonly state: 'gone' }
  | { readonly state: 'not_found' };

export const hcTreeArticleSchema = z.object({
  id: z.uuid(),
  slug: hcSlugSchema,
  title: z.string(),
  locale: localeSchema,
  fallback: z.boolean(),
});
export type HcTreeArticle = z.infer<typeof hcTreeArticleSchema>;

export const hcTreeSectionSchema = z.object({
  id: z.uuid(),
  slug: hcSlugSchema,
  name: z.string(),
  articles: z.array(hcTreeArticleSchema),
});
export type HcTreeSection = z.infer<typeof hcTreeSectionSchema>;

export const hcTreeCategorySchema = z.object({
  id: z.uuid(),
  slug: hcSlugSchema,
  name: z.string(),
  description: z.string(),
  sections: z.array(hcTreeSectionSchema),
});
export type HcTreeCategory = z.infer<typeof hcTreeCategorySchema>;

/** One sitemap `<url>`: an article in one language, with its alternates. */
export const hcSitemapEntrySchema = z.object({
  slug: hcSlugSchema,
  locale: localeSchema,
  lastModified: z.iso.datetime(),
  alternates: z.array(localeSchema),
});
export type HcSitemapEntry = z.infer<typeof hcSitemapEntrySchema>;

/**
 * One language of one article that changed since a point in time, and whether
 * the audience may now read it. `slug` is withheld when it may not: a consumer
 * removing an entry needs the id, not the address.
 */
export const hcChangedVersionSchema = z.object({
  articleId: z.uuid(),
  locale: localeSchema,
  visible: z.boolean(),
  slug: hcSlugSchema.nullable(),
  changedAt: z.iso.datetime(),
});
export type HcChangedVersion = z.infer<typeof hcChangedVersionSchema>;

// --------------------------------------------------------------------------
// Outbox events (DOMAIN-RULES §6)
// --------------------------------------------------------------------------

/**
 * `help_center.article_changed`: something a reader of the published help
 * center could notice about one article moved — a publish, a status or
 * visibility change, a new slug or section. Search (M5-05) and the page cache
 * (M5-03) re-read the article through the read service; from M7 the
 * `knowledge.sync` job re-labels its chunks (DOMAIN-RULES §5).
 */
export const HC_ARTICLE_CHANGED_EVENT = 'help_center.article_changed';
/** `help_center.structure_changed`: a category or section was renamed, moved or removed. */
export const HC_STRUCTURE_CHANGED_EVENT = 'help_center.structure_changed';
/** `help_center.access_changed`: the brand's help center became public or internal-only. */
export const HC_ACCESS_CHANGED_EVENT = 'help_center.access_changed';
/** `help_center.media_uploaded`: an article image is in the bucket and wants converting. */
export const HC_MEDIA_UPLOADED_EVENT = 'help_center.media_uploaded';

export const hcArticleChangeSchema = z.enum([
  'published',
  'unpublished',
  'archived',
  'scheduled',
  'visibility',
  'slug',
  'moved',
]);
export type HcArticleChange = z.infer<typeof hcArticleChangeSchema>;

export const hcArticleChangedPayloadSchema = z.object({
  articleId: z.uuid(),
  /** Null when the change touches every language, such as a new slug. */
  locale: localeSchema.nullable(),
  change: hcArticleChangeSchema,
  /** On `scheduled` only: when the version goes live, which the scheduler's delayed job is for. */
  scheduledAt: z.iso.datetime().optional(),
});
export type HcArticleChangedPayload = z.infer<typeof hcArticleChangedPayloadSchema>;
