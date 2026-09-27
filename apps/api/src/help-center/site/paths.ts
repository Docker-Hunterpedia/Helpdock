import { type HcLocale, hcSlugSchema, localeSchema } from '@helpdock/schemas';

/**
 * The help center's addresses (M5-03). The language is the first segment of
 * every page, so a page has one address per language and a search engine can
 * be told about both (M5-04):
 *
 * | Path | Page |
 * |---|---|
 * | `/` | a redirect to the reader's language |
 * | `/<locale>` | home |
 * | `/<locale>/categories/<slug>` | a category |
 * | `/<locale>/sections/<slug>` | a section: the category layout with one card |
 * | `/<locale>/articles/<slug>` | an article (`?preview=1` for staff: the working copy) |
 * | `/<locale>/search?q=` | search results |
 * | `/sitemap.xml`, `/robots.txt` | M5-04 |
 * | `/_hd/staff?pass=` | exchanges a staff pass for the staff cookie |
 * | `/_hd/feedback`, `/_hd/sign-out` | the two forms the pages post |
 *
 * On a brand's verified host the paths are at the root. A brand with no host
 * yet is served on the install's own host under `/hc/<brandId>`, as ADR 0013
 * serves the web form under `/contact/<brandId>`; `base` is that prefix, or
 * the empty string.
 */

export const HC_FALLBACK_PREFIX = '/hc';
export const STAFF_SESSION_PATH = '/_hd/staff';
export const FEEDBACK_PATH = '/_hd/feedback';
export const SIGN_OUT_PATH = '/_hd/sign-out';

export type SiteRoute =
  | { readonly kind: 'root' }
  | { readonly kind: 'home'; readonly locale: HcLocale }
  | {
      readonly kind: 'category' | 'section' | 'article';
      readonly locale: HcLocale;
      readonly slug: string;
    }
  | { readonly kind: 'search'; readonly locale: HcLocale }
  | { readonly kind: 'sitemap' | 'robots' | 'staff-session' }
  /** Anything else: a 404, in the language its first segment names, if any. */
  | { readonly kind: 'unknown'; readonly locale: HcLocale | null };

const PAGE_KINDS = { categories: 'category', sections: 'section', articles: 'article' } as const;

const localeOf = (segment: string | undefined): HcLocale | null => {
  const parsed = localeSchema.safeParse(segment);
  return parsed.success ? parsed.data : null;
};

/** A path below the base, without its query, as a route. Trailing slashes are ignored. */
export const parseSitePath = (path: string): SiteRoute => {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) {
    return { kind: 'root' };
  }
  if (segments.length === 1) {
    switch (segments[0]) {
      case 'sitemap.xml':
        return { kind: 'sitemap' };
      case 'robots.txt':
        return { kind: 'robots' };
    }
  }
  if (`/${segments.join('/')}` === STAFF_SESSION_PATH) {
    return { kind: 'staff-session' };
  }

  const locale = localeOf(segments[0]);
  if (locale === null) {
    return { kind: 'unknown', locale: null };
  }
  if (segments.length === 1) {
    return { kind: 'home', locale };
  }
  if (segments.length === 2 && segments[1] === 'search') {
    return { kind: 'search', locale };
  }
  const kind = PAGE_KINDS[segments[1] as keyof typeof PAGE_KINDS] as
    | (typeof PAGE_KINDS)[keyof typeof PAGE_KINDS]
    | undefined;
  const slug = hcSlugSchema.safeParse(segments[2]);
  if (segments.length === 3 && kind !== undefined && slug.success && slug.data === segments[2]) {
    return { kind, locale, slug: slug.data };
  }
  return { kind: 'unknown', locale };
};

/**
 * Every address a page links to, relative to the host (`href`) or absolute
 * (`url`, for canonical links, the sitemap and structured data).
 */
export class SiteLinks {
  /** `''` on the brand's host, `/hc/<brandId>` on the fallback. */
  readonly base: string;
  /** `https://help.acme.com`, or the install's origin on the fallback. */
  readonly origin: string;
  /** Whether this is the install's fallback path rather than the brand's host. */
  readonly fallback: boolean;
  readonly #brandId: string;

  constructor(options: { base: string; origin: string; brandId: string }) {
    this.base = options.base;
    this.origin = options.origin.replace(/\/$/, '');
    this.fallback = options.base !== '';
    this.#brandId = options.brandId;
  }

  home(locale: HcLocale): string {
    return `${this.base}/${locale}`;
  }

  category(locale: HcLocale, slug: string): string {
    return `${this.base}/${locale}/categories/${slug}`;
  }

  section(locale: HcLocale, slug: string): string {
    return `${this.base}/${locale}/sections/${slug}`;
  }

  /** With `searchId`, the view it counts is "opened from a search" (M5-08). */
  article(locale: HcLocale, slug: string, searchId?: string): string {
    const from = searchId === undefined ? '' : `?sid=${encodeURIComponent(searchId)}`;
    return `${this.base}/${locale}/articles/${slug}${from}`;
  }

  search(locale: HcLocale, query: { q?: string; topic?: string } = {}): string {
    const params = new URLSearchParams();
    if (query.q !== undefined && query.q !== '') {
      params.set('q', query.q);
    }
    if (query.topic !== undefined) {
      params.set('topic', query.topic);
    }
    const search = params.toString();
    return `${this.base}/${locale}/search${search === '' ? '' : `?${search}`}`;
  }

  sitemap(): string {
    return `${this.base}/sitemap.xml`;
  }

  feedback(): string {
    return `${this.base}${FEEDBACK_PATH}`;
  }

  signOut(): string {
    return `${this.base}${SIGN_OUT_PATH}`;
  }

  /** The web form (M4-09): `/contact` on the host, `/contact/<brandId>` on the fallback. */
  contact(locale: HcLocale, articleId?: string): string {
    const path = this.fallback ? `/contact/${this.#brandId}` : '/contact';
    const article = articleId === undefined ? '' : `&article=${articleId}`;
    return `${path}?lang=${locale}${article}`;
  }

  /** An address a page links to, made absolute. */
  url(href: string): string {
    return `${this.origin}${href}`;
  }

  /**
   * A link inside an article body. The editor writes `/en/articles/…` for a
   * link to another article; on the fallback that path needs the base.
   */
  bodyHref(href: string): string {
    return this.fallback && /^\/(?:en|ar)(?:\/|$)/.test(href) ? `${this.base}${href}` : href;
  }
}
