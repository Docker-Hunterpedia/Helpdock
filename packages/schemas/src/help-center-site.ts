import { z } from 'zod';
import { localeSchema } from './brand.js';

/**
 * The published help center as a site (M5-03, M5-04, M5-06): its theme, its
 * home page, its header and footer links, its custom CSS, and the staff pass
 * that lets a signed-in staff member read it as staff on the brand's own host.
 *
 * Everything here is configured on Help center › Settings
 * (`Admin/HelpCenter-Settings`) by an Admin or a Team Leader
 * (`help_center:manage`) and rendered by the api (ADR 0015).
 */

// --------------------------------------------------------------------------
// Theme (M5-06, DESIGN §8)
// --------------------------------------------------------------------------

/**
 * The same three lists `@helpdock/ui`'s brand resolver accepts. They are
 * repeated here because this package depends on nothing but zod; a test in
 * the api holds the two in step.
 */
export const HC_SURFACE_TONES = ['warm', 'neutral', 'cool'] as const;
export const HC_THEME_MODES = ['light', 'dark', 'auto'] as const;
export const HC_THEME_FONTS = ['ibm-plex', 'noto-sans', 'vazirmatn'] as const;

export const hcThemeSchema = z.object({
  /** Any hex; the api refuses one below 3:1 on the surface (DESIGN §8). */
  accent: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'a six-digit hex colour such as #0F766E')
    .transform((value) => value.toUpperCase()),
  surfaceTone: z.enum(HC_SURFACE_TONES),
  /** DESIGN §4: a brand moves `md` and `lg` within 0 to 12. */
  radius: z.int().min(0).max(12),
  mode: z.enum(HC_THEME_MODES),
  font: z.enum(HC_THEME_FONTS),
});
export type HcTheme = z.infer<typeof hcThemeSchema>;

export const HC_THEME_DEFAULTS: HcTheme = {
  accent: '#0F766E',
  surfaceTone: 'warm',
  radius: 6,
  mode: 'auto',
  font: 'ibm-plex',
};

/** An uploaded logo or favicon, once the media pipeline has re-encoded it. */
export const hcSiteImageSchema = z.object({
  mediaId: z.uuid(),
  /** The redirect route the page's `<img>` and `<link rel="icon">` name. */
  src: z.string(),
  width: z.int().nullable(),
  height: z.int().nullable(),
});
export type HcSiteImage = z.infer<typeof hcSiteImageSchema>;

export const hcAppearanceSchema = z.object({
  theme: hcThemeSchema,
  logo: hcSiteImageSchema.nullable(),
  favicon: hcSiteImageSchema.nullable(),
});
export type HcAppearance = z.infer<typeof hcAppearanceSchema>;

export const hcAppearanceUpdateRequestSchema = z.object({
  theme: hcThemeSchema,
  /** A `ready` image uploaded with the `logo` purpose, or null for none. */
  logoMediaId: z.uuid().nullable(),
  faviconMediaId: z.uuid().nullable(),
});
export type HcAppearanceUpdateRequest = z.infer<typeof hcAppearanceUpdateRequestSchema>;

/** What an image is uploaded for: an article, or the site's logo or favicon. */
export const hcMediaPurposeSchema = z.enum(['article', 'logo', 'favicon']);
export type HcMediaPurpose = z.infer<typeof hcMediaPurposeSchema>;

/** DESIGN §8: logos and favicons are re-encoded and scaled to 512 px at most. */
export const HC_SITE_IMAGE_MAX_EDGE = 512;

// --------------------------------------------------------------------------
// Home page (M5-06)
// --------------------------------------------------------------------------

export const HC_FEATURED_MAX = 6;
/** How many "Popular" articles the home page lists. */
export const HC_POPULAR_COUNT = 5;

export const hcHomeLayoutSchema = z
  .object({
    categories: z.boolean(),
    featured: z.boolean(),
    /** In the order the home page lists them. */
    featuredArticleIds: z.array(z.uuid()).max(HC_FEATURED_MAX),
    popular: z.boolean(),
  })
  .refine((home) => new Set(home.featuredArticleIds).size === home.featuredArticleIds.length, {
    message: 'an article is featured once',
    path: ['featuredArticleIds'],
  });
export type HcHomeLayout = z.infer<typeof hcHomeLayoutSchema>;

export const HC_HOME_DEFAULTS: HcHomeLayout = {
  categories: true,
  featured: false,
  featuredArticleIds: [],
  popular: true,
};

// --------------------------------------------------------------------------
// Header and footer links (M5-06)
// --------------------------------------------------------------------------

export const HC_LINKS_MAX = 8;
export const HC_LINK_LABEL_MAX = 60;
export const HC_LINK_URL_MAX = 2_000;

/**
 * One link. Its address is absolute http(s) or `mailto:`: a link leaves the
 * help center, and a relative one would mean something different on the
 * brand's host and on the install's fallback path.
 */
export const hcLinkSchema = z
  .object({
    labelEn: z.string().trim().max(HC_LINK_LABEL_MAX),
    labelAr: z.string().trim().max(HC_LINK_LABEL_MAX),
    url: z
      .string()
      .trim()
      .max(HC_LINK_URL_MAX)
      .refine((value) => {
        try {
          const url = new URL(value);
          return ['http:', 'https:', 'mailto:'].includes(url.protocol);
        } catch {
          return false;
        }
      }, 'an absolute http, https or mailto address'),
  })
  .refine((link) => link.labelEn !== '' || link.labelAr !== '', {
    message: 'a link needs a label in one language',
    path: ['labelEn'],
  });
export type HcLink = z.infer<typeof hcLinkSchema>;

export const hcLinksSchema = z.object({
  header: z.array(hcLinkSchema).max(HC_LINKS_MAX),
  footer: z.array(hcLinkSchema).max(HC_LINKS_MAX),
});
export type HcLinks = z.infer<typeof hcLinksSchema>;

// --------------------------------------------------------------------------
// Custom CSS (M5-06, DESIGN §8)
// --------------------------------------------------------------------------

/** Characters of custom CSS a brand may save; what is kept after sanitising is never longer. */
export const HC_CUSTOM_CSS_MAX = 20_000;

/** Why the sanitiser dropped a rule or a declaration. The admin names each in a sentence. */
export const hcCssRemovalReasonSchema = z.enum([
  'import',
  'at-rule',
  'url',
  'expression',
  'fixed',
  'escape',
  'malformed',
]);
export type HcCssRemovalReason = z.infer<typeof hcCssRemovalReasonSchema>;

export const hcCssRemovalSchema = z.object({
  /** The dropped text, trimmed to 200 characters, for the admin to show in mono. */
  rule: z.string(),
  reason: hcCssRemovalReasonSchema,
});
export type HcCssRemoval = z.infer<typeof hcCssRemovalSchema>;

export const hcCustomCssUpdateRequestSchema = z.object({
  css: z.string().max(HC_CUSTOM_CSS_MAX),
});
export type HcCustomCssUpdateRequest = z.infer<typeof hcCustomCssUpdateRequestSchema>;

/** The saved CSS, and what saving removed from what was sent. */
export const hcCustomCssResultSchema = z.object({
  css: z.string(),
  removed: z.array(hcCssRemovalSchema),
});
export type HcCustomCssResult = z.infer<typeof hcCustomCssResultSchema>;

// --------------------------------------------------------------------------
// Everything on the Settings tab below "Who can read it"
// --------------------------------------------------------------------------

export const hcSiteSchema = z.object({
  appearance: hcAppearanceSchema,
  home: hcHomeLayoutSchema,
  links: hcLinksSchema,
  customCss: z.string(),
  /** Where the help center answers: the primary verified domain, or the install's fallback path. */
  url: z.url(),
});
export type HcSite = z.infer<typeof hcSiteSchema>;

// --------------------------------------------------------------------------
// The staff pass (M5-03): reading the help center as staff on its own host
// --------------------------------------------------------------------------

/** A path on the help center: `/`, `/en/articles/refund-timelines`. Never a host. */
export const hcSitePathSchema = z
  .string()
  .max(500)
  .regex(/^\/(?![/\\])[^\s\\]*$/, 'a path on the help center, starting with one slash');

export const hcStaffPassRequestSchema = z.object({
  /** Where to land; the home page when left out. */
  path: hcSitePathSchema.optional(),
  /** Open this language of this article's working copy instead: the editor's Preview. */
  preview: z.object({ articleId: z.uuid(), locale: localeSchema }).optional(),
});
export type HcStaffPassRequest = z.infer<typeof hcStaffPassRequestSchema>;

export const hcStaffPassResponseSchema = z.object({
  /** One use, one minute: the help center exchanges it for its own staff cookie. */
  url: z.url(),
});
export type HcStaffPassResponse = z.infer<typeof hcStaffPassResponseSchema>;

/**
 * `help_center.site_changed`: the theme, home page, links or custom CSS of a
 * help center changed. The page cache drops the brand's pages on it, as it
 * does on the three events of M5-09.
 */
export const HC_SITE_CHANGED_EVENT = 'help_center.site_changed';

export const hcSiteCardSchema = z.enum(['appearance', 'home', 'links', 'custom_css']);
export type HcSiteCard = z.infer<typeof hcSiteCardSchema>;

// --------------------------------------------------------------------------
// The pages' own inputs (M5-03)
// --------------------------------------------------------------------------

/** The query a help center page reads; anything else is dropped. */
export const hcSiteQuerySchema = z.object({
  q: z.string().max(500).optional(),
  topic: z.string().max(200).optional(),
  /** `1` on an article: staff read its working copy. */
  preview: z.string().max(10).optional(),
  /** `1` after a visitor answered "Was this helpful?". */
  feedback: z.string().max(10).optional(),
  /** A staff pass (`/_hd/staff?pass=`). */
  pass: z.string().max(100).optional(),
  /** The search a result was opened from, for "Opened a result" (M5-08). */
  sid: z.string().max(100).optional(),
});
export type HcSiteQuery = z.infer<typeof hcSiteQuerySchema>;

/** "Was this helpful?", as the article page's form posts it. */
export const hcFeedbackFormSchema = z.object({
  article: z.uuid(),
  locale: localeSchema,
  slug: z.string().max(200),
  helpful: z.enum(['yes', 'no']),
});
export type HcFeedbackForm = z.infer<typeof hcFeedbackFormSchema>;

/** The sign-out form carries nothing. */
export const hcSignOutFormSchema = z.object({});
export type HcSignOutForm = z.infer<typeof hcSignOutFormSchema>;
