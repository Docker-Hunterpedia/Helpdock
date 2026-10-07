import { createHmac, randomBytes } from 'node:crypto';
import type {
  HcArticleLookup,
  HcAudience,
  HcLocale,
  HcSitemapEntry,
  HcTreeCategory,
} from '@helpdock/schemas';
import { hcFeedbackFormSchema, localeSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { HelpCenterFeedback, HelpCenterSearch } from '../ports.js';
import {
  type FeedbackStep,
  feedbackHref,
  feedbackStepOf,
  nextFeedbackStep,
} from './feedback-step.js';
import { type CachedPage, etagOf, type PageCache, type PageCacheKey } from './page-cache.js';
import { HC_FALLBACK_PREFIX, parseSitePath, SiteLinks, type SiteRoute } from './paths.js';
import { NONCE } from './render/layout.js';
import { robotsTxt, sitemapXml } from './render/seo.js';
import type { SiteConfig } from './site-config.js';
import type { GoneArticle, PreviewArticle } from './site-reads.js';
import {
  STAFF_COOKIE,
  STAFF_COOKIE_TTL_SECONDS,
  type StaffPass,
  type StaffReader,
} from './staff-access.js';
import {
  flatten,
  type PageContext,
  type Rendered,
  renderArticle,
  renderCategory,
  renderGone,
  renderHome,
  renderNotFound,
  renderPreview,
  renderSearch,
  renderSection,
  renderWall,
} from './views.js';

/** The routes that are pages, as opposed to the files and the staff exchange. */
type PageRoute = Extract<
  SiteRoute,
  { kind: 'home' | 'category' | 'section' | 'article' | 'search' | 'unknown' }
>;

/**
 * The help center's request handling (M5-03, M5-04), apart from Nest so the
 * same code answers the api's routes and the Playwright server that drives
 * the pages in a browser (`apps/api/e2e/`), as `WebFormPage` does for the
 * form (ADR 0013, ADR 0015).
 *
 * | Outcome | Status | Cache-Control | Redis |
 * |---|---|---|---|
 * | a page a visitor may read | 200 | `public, s-maxage=300, stale-while-revalidate=60` + ETag, 304 on a match | stored |
 * | a 404 or 410 for a visitor | 404 / 410 | the same public rule | stored |
 * | any page for staff, a preview | 200 / 404 / 410 | `private, no-store` | never |
 * | the internal-only wall | 401 | `private, no-store` | never |
 * | search results | 200 | `private, no-store` | never: every query reaches search's log |
 *
 * Every html answer carries its own CSP with a fresh nonce; a cached page
 * keeps a placeholder where the nonce goes (`render/layout.ts`).
 */

export const PUBLIC_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60';
export const PRIVATE_CACHE_CONTROL = 'private, no-store';
/** The first-party cookie that tells one visitor's votes apart. Set only when they vote. */
export const VISITOR_COOKIE = 'hd_hc_v';
const VISITOR_COOKIE_TTL_SECONDS = 365 * 24 * 60 * 60;

/** What the pages read: `HelpCenterContentService` and the two reads of `site-reads.ts`. */
export interface SiteContent {
  config(brandId: string): Promise<SiteConfig | null>;
  tree(query: {
    brandId: string;
    audience: HcAudience;
    locale: HcLocale;
  }): Promise<HcTreeCategory[]>;
  article(query: {
    brandId: string;
    audience: HcAudience;
    locale: HcLocale;
    slug: string;
  }): Promise<HcArticleLookup>;
  sitemap(brandId: string): Promise<HcSitemapEntry[]>;
  gone(
    brandId: string,
    scope: { audience: HcAudience; locale: HcLocale; defaultLocale: HcLocale },
    slug: string,
  ): Promise<GoneArticle | null>;
  preview(
    brandId: string,
    scope: { locale: HcLocale; defaultLocale: HcLocale },
    slug: string,
  ): Promise<PreviewArticle | null>;
}

export interface SiteStaff {
  readerOf(cookie: string | undefined, brandId: string): Promise<StaffReader | null>;
  spendPass(token: string): Promise<StaffPass | null>;
  cookieFor(pass: StaffPass): Promise<string>;
}

/** The brand whose verified help center host this is. */
export interface SiteHosts {
  brandOf(host: string | undefined): Promise<string | null>;
}

export interface HelpCenterSiteDependencies {
  readonly content: SiteContent;
  readonly hosts: SiteHosts;
  readonly search: HelpCenterSearch;
  readonly feedback: HelpCenterFeedback;
  readonly cache: PageCache;
  readonly staff: SiteStaff;
  /** The install's own address (`APP_URL`): the fallback's origin and the admin's. */
  readonly appUrl: string;
  /** Where images are served from after the media redirect, for `img-src`. */
  readonly imageSources: readonly string[];
  /** Keys the hash a visitor without a cookie is known by. */
  readonly visitorSecret: string;
  readonly log: { warn(fields: Record<string, unknown>, message: string): void };
}

export interface SiteRequest {
  readonly method: 'GET' | 'POST';
  readonly host: string | undefined;
  /** `/hc/<brandId>/…` on the fallback, or the path on the brand's host. No query. */
  readonly path: string;
  /** Was the request routed by its host (the catch-all) or by the fallback path? */
  readonly byHost: boolean;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: {
    readonly ifNoneMatch?: string | undefined;
    readonly acceptLanguage?: string | undefined;
    readonly userAgent?: string | undefined;
    readonly origin?: string | undefined;
  };
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly ip: string;
  readonly body?: unknown;
}

export interface SiteCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly maxAge: number;
  readonly secure: boolean;
}

export interface SiteResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly cookies: readonly SiteCookie[];
}

interface Target {
  readonly brandId: string;
  /** The path below the base. */
  readonly rest: string;
}

interface Where extends Target {
  readonly links: SiteLinks;
  /** See `PageContext.seo`. */
  readonly seo: SiteLinks;
}

const nonceOf = (): string => randomBytes(16).toString('base64');

export class HelpCenterSite {
  readonly #deps: HelpCenterSiteDependencies;
  readonly #appOrigin: string;
  readonly #secure: boolean;

  constructor(deps: HelpCenterSiteDependencies) {
    this.#deps = deps;
    const app = new URL(deps.appUrl);
    this.#appOrigin = app.origin;
    this.#secure = app.protocol === 'https:';
  }

  /** Whether the catch-all should hand this host to the help center. */
  async servesHost(host: string | undefined): Promise<boolean> {
    return (await this.#deps.hosts.brandOf(host)) !== null;
  }

  async handle(request: SiteRequest): Promise<SiteResponse> {
    const target = await this.#target(request);
    if (target === null) {
      return plain(404, 'Not found');
    }
    const config = await this.#deps.content.config(target.brandId);
    if (config === null) {
      return plain(404, 'Not found');
    }
    const links = this.#linksFor(target.brandId, config, request);
    const where: Where = { ...target, links, seo: this.#seoFor(target.brandId, config, links) };

    if (request.method === 'POST') {
      return this.#post(request, where, config);
    }

    const route = parseSitePath(where.rest);
    switch (route.kind) {
      case 'staff-session':
        return this.#staffSession(request, where);
      case 'robots':
        return text(
          200,
          robotsTxt({ internalOnly: config.access === 'internal_only', links }),
          'text/plain',
        );
      case 'sitemap':
        return config.access === 'internal_only'
          ? plain(404, 'Not found')
          : text(
              200,
              sitemapXml(await this.#deps.content.sitemap(where.brandId), where.seo, ['en', 'ar']),
              'application/xml',
            );
      case 'root':
        return redirect(
          302,
          links.home(pickLocale(request.headers.acceptLanguage, config.defaultLocale)),
          true,
        );
      default:
        return this.#page(request, where, config, route);
    }
  }

  /** A page: the wall, a cache hit, a preview, search, or a render (stored when public). */
  async #page(
    request: SiteRequest,
    where: Where,
    config: SiteConfig,
    route: PageRoute,
  ): Promise<SiteResponse> {
    const staff = await this.#deps.staff.readerOf(request.cookies[STAFF_COOKIE], where.brandId);
    const audience: HcAudience = staff === null ? 'public' : 'internal';
    const locale = route.kind === 'unknown' ? (route.locale ?? config.defaultLocale) : route.locale;

    if (config.access === 'internal_only' && staff === null) {
      const context = await this.#context(where, config, locale, audience, staff);
      const returnPath = `${where.rest}${queryString(request.query)}`;
      return this.#html(request, renderWall(context, returnPath), 'private');
    }

    const feedback: FeedbackStep =
      route.kind === 'article' ? feedbackStepOf(request.query.feedback) : 'ask';
    const cacheable = audience === 'public' && feedback === 'ask' && route.kind !== 'search';
    const key: PageCacheKey = {
      brandId: where.brandId,
      host: request.host ?? '',
      path: request.path,
      locale,
      audience,
    };
    const lookup = cacheable ? await this.#deps.cache.lookup(key) : null;
    if (lookup?.hit != null) {
      await this.#countView(request, where.brandId, lookup.hit, audience);
      return this.#fromCache(request, lookup.hit);
    }

    const context = await this.#context(where, config, locale, audience, staff);
    if (route.kind === 'article' && request.query.preview === '1' && staff !== null) {
      return this.#preview(request, context, route.slug);
    }
    if (route.kind === 'search') {
      return this.#search(request, context, where.brandId);
    }

    const rendered = await this.#render(route, context, where.brandId, feedback);
    const page: CachedPage = {
      status: rendered.page.status,
      html: rendered.page.html,
      etag: etagOf(rendered.page.html),
      noindex: rendered.page.noindex,
      widget: rendered.page.widget,
      view: rendered.view,
    };
    if (lookup !== null) {
      await this.#deps.cache.store(key, lookup.generation, page);
    }
    await this.#countView(request, where.brandId, page, audience);
    return this.#html(request, rendered.page, cacheable ? 'public' : 'private', page.etag);
  }

  async #preview(request: SiteRequest, context: PageContext, slug: string): Promise<SiteResponse> {
    const { config, locale } = context;
    const article = await this.#deps.content.preview(
      config.brandId,
      { locale, defaultLocale: config.defaultLocale },
      slug,
    );
    return this.#html(
      request,
      article === null ? renderNotFound(context, []) : renderPreview(context, article),
      'private',
    );
  }

  /** Which brand this request is for and the path below its base, or null. */
  async #target(request: SiteRequest): Promise<Target | null> {
    const hostBrand = await this.#deps.hosts.brandOf(request.host);
    if (request.byHost) {
      return hostBrand === null ? null : { brandId: hostBrand, rest: request.path };
    }
    const match = /^\/hc\/([0-9a-f-]{36})(\/.*)?$/i.exec(request.path);
    const brandId = match?.[1]?.toLowerCase();
    if (brandId === undefined || !z.uuid().safeParse(brandId).success) {
      return null;
    }
    // One brand's domain never serves another brand's help center (ADR 0013).
    if (hostBrand !== null && hostBrand !== brandId) {
      return null;
    }
    return { brandId, rest: match?.[2] ?? '/' };
  }

  #linksFor(brandId: string, config: SiteConfig, request: SiteRequest): SiteLinks {
    if (request.byHost) {
      const scheme = this.#secure ? 'https:' : 'http:';
      return new SiteLinks({
        base: '',
        origin: `${scheme}//${request.host ?? config.primaryDomain ?? ''}`,
        brandId,
      });
    }
    return new SiteLinks({
      base: `${HC_FALLBACK_PREFIX}/${brandId}`,
      origin: this.#appOrigin,
      brandId,
    });
  }

  /** The brand's domain for canonical links when this is its fallback path; else the page's own. */
  #seoFor(brandId: string, config: SiteConfig, links: SiteLinks): SiteLinks {
    if (!links.fallback || config.primaryDomain === null) {
      return links;
    }
    return new SiteLinks({
      base: '',
      origin: `${this.#secure ? 'https:' : 'http:'}//${config.primaryDomain}`,
      brandId,
    });
  }

  async #context(
    where: Where,
    config: SiteConfig,
    locale: HcLocale,
    audience: HcAudience,
    staff: StaffReader | null,
  ): Promise<PageContext> {
    const tree = await this.#deps.content.tree({ brandId: where.brandId, audience, locale });
    const publicIds =
      staff === null
        ? null
        : new Set(
            flatten(
              await this.#deps.content.tree({ brandId: where.brandId, audience: 'public', locale }),
            ).map((entry) => entry.article.id),
          );
    return {
      config,
      locale,
      links: where.links,
      seo: where.seo,
      audience,
      staff,
      tree,
      publicIds,
      widget: staff === null && config.widgetOrigins.includes(where.links.origin),
      adminUrl: (path) => `${this.#appOrigin}${path}`,
    };
  }

  async #render(
    route: SiteRoute,
    context: PageContext,
    brandId: string,
    feedback: FeedbackStep,
  ): Promise<{ page: Rendered; view: CachedPage['view'] }> {
    const { locale, audience } = context;
    switch (route.kind) {
      case 'home':
        return { page: renderHome(context, await this.#popular(brandId, context)), view: null };
      case 'category':
        return {
          page:
            renderCategory(context, route.slug) ??
            renderNotFound(context, await this.#popular(brandId, context)),
          view: null,
        };
      case 'section':
        return {
          page:
            renderSection(context, route.slug) ??
            renderNotFound(context, await this.#popular(brandId, context)),
          view: null,
        };
      case 'article': {
        const lookup = await this.#deps.content.article({
          brandId,
          audience,
          locale,
          slug: route.slug,
        });
        if (lookup.state === 'found') {
          return {
            page: renderArticle(context, lookup.article, { feedback }),
            view: { articleId: lookup.article.id, locale: lookup.article.locale },
          };
        }
        if (lookup.state === 'gone') {
          const gone = await this.#deps.content.gone(
            brandId,
            { audience, locale, defaultLocale: context.config.defaultLocale },
            route.slug,
          );
          return { page: renderGone(context, gone), view: null };
        }
        return { page: renderNotFound(context, await this.#popular(brandId, context)), view: null };
      }
      default:
        return { page: renderNotFound(context, await this.#popular(brandId, context)), view: null };
    }
  }

  async #popular(brandId: string, context: PageContext) {
    try {
      return await this.#deps.feedback.popular({
        brandId,
        audience: context.audience,
        locale: context.locale,
        limit: 5,
      });
    } catch (error) {
      this.#deps.log.warn({ brandId, err: error }, 'help center: popular articles unavailable');
      return [];
    }
  }

  async #search(
    request: SiteRequest,
    context: PageContext,
    brandId: string,
  ): Promise<SiteResponse> {
    const q = (request.query.q ?? '').trim().slice(0, 200);
    const topic = request.query.topic ?? null;
    let result: Awaited<ReturnType<HelpCenterSearch['search']>> = { hits: [], total: 0 };
    if (q !== '') {
      try {
        result = await this.#deps.search.search({
          brandId,
          audience: context.audience,
          locale: context.locale,
          q,
          limit: 50,
          offset: 0,
          source: 'help_center',
          // Staff searches would skew Insights, as their views and votes would.
          log: context.audience === 'public',
        });
      } catch (error) {
        this.#deps.log.warn({ brandId, err: error }, 'help center: search failed');
      }
    }
    return this.#html(
      request,
      renderSearch(context, { q, topic }, result.hits, result.searchId ?? undefined),
      'private',
    );
  }

  /** Counts a visitor's view of an article. Staff and previews are not counted; a failure never fails the page. */
  async #countView(
    request: SiteRequest,
    brandId: string,
    page: CachedPage,
    audience: HcAudience,
  ): Promise<void> {
    if (audience !== 'public' || page.view === null || page.status !== 200) {
      return;
    }
    try {
      await this.#deps.feedback.recordView({
        brandId,
        articleId: page.view.articleId,
        locale: page.view.locale,
        visitorKey: this.#visitorKey(request),
        ...(request.query.sid === undefined ? {} : { searchId: request.query.sid }),
      });
    } catch (error) {
      this.#deps.log.warn({ brandId, err: error }, 'help center: a view was not counted');
    }
  }

  /**
   * The visitor's first-party cookie, or a keyed hash of their address and
   * browser when they have none. Nothing third-party, and neither is stored
   * by the page itself.
   */
  #visitorKey(request: SiteRequest): string {
    const cookie = request.cookies[VISITOR_COOKIE];
    if (cookie !== undefined && /^[A-Za-z0-9_-]{22}$/.test(cookie)) {
      return `c:${cookie}`;
    }
    const hash = createHmac('sha256', this.#deps.visitorSecret)
      .update(`${request.ip}\n${request.headers.userAgent ?? ''}`)
      .digest('base64url')
      .slice(0, 22);
    return `h:${hash}`;
  }

  async #post(request: SiteRequest, where: Where, config: SiteConfig): Promise<SiteResponse> {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== 'null' && origin !== where.links.origin) {
      return plain(403, 'Forbidden');
    }
    const path = where.rest.replace(/\/+$/, '');
    if (path === '/_hd/sign-out') {
      return {
        ...redirect(303, where.links.home(config.defaultLocale), true),
        cookies: [this.#staffCookie(where, '', 0)],
      };
    }
    if (path !== '/_hd/feedback') {
      return plain(404, 'Not found');
    }

    const body = hcFeedbackFormSchema.safeParse(request.body);
    if (!body.success) {
      return plain(400, 'Bad request');
    }
    const staff = await this.#deps.staff.readerOf(request.cookies[STAFF_COOKIE], where.brandId);
    const audience: HcAudience = staff === null ? 'public' : 'internal';
    if (config.access === 'internal_only' && staff === null) {
      return plain(401, 'Unauthorized');
    }
    const lookup = await this.#deps.content.article({
      brandId: where.brandId,
      audience,
      locale: body.data.locale,
      slug: body.data.slug,
    });
    if (lookup.state !== 'found' || lookup.article.id !== body.data.article) {
      return plain(404, 'Not found');
    }
    const cookie = request.cookies[VISITOR_COOKIE];
    const fresh =
      cookie === undefined || !/^[A-Za-z0-9_-]{22}$/.test(cookie)
        ? randomBytes(16).toString('base64url')
        : null;
    const keyed =
      fresh === null
        ? request
        : { ...request, cookies: { ...request.cookies, [VISITOR_COOKIE]: fresh } };
    const helpful = body.data.helpful === 'yes';
    // Staff answering on their own help center are not readers: no vote is counted.
    try {
      if (staff === null)
        await this.#deps.feedback.recordVote({
          brandId: where.brandId,
          articleId: lookup.article.id,
          locale: lookup.article.locale,
          visitorKey: this.#visitorKey(keyed),
          helpful,
          ...(helpful || body.data.comment === undefined ? {} : { comment: body.data.comment }),
        });
    } catch (error) {
      this.#deps.log.warn(
        { brandId: where.brandId, err: error },
        'help center: a vote was not recorded',
      );
    }
    return {
      ...redirect(
        303,
        feedbackHref(
          where.links.article(body.data.locale, body.data.slug),
          nextFeedbackStep(body.data),
        ),
        true,
      ),
      cookies:
        fresh === null
          ? []
          : [
              {
                name: VISITOR_COOKIE,
                value: fresh,
                path: where.links.base === '' ? '/' : where.links.base,
                maxAge: VISITOR_COOKIE_TTL_SECONDS,
                secure: this.#secure,
              },
            ],
    };
  }

  async #staffSession(request: SiteRequest, where: Where): Promise<SiteResponse> {
    const pass = await this.#deps.staff.spendPass(request.query.pass ?? '');
    if (pass === null || pass.brandId !== where.brandId) {
      return plain(403, 'This link has expired. Open the help center from the admin again.');
    }
    return {
      ...redirect(303, `${where.links.base}${pass.path}`, true),
      cookies: [
        this.#staffCookie(where, await this.#deps.staff.cookieFor(pass), STAFF_COOKIE_TTL_SECONDS),
      ],
    };
  }

  #staffCookie(where: Where, value: string, maxAge: number): SiteCookie {
    return {
      name: STAFF_COOKIE,
      value,
      path: where.links.base === '' ? '/' : where.links.base,
      maxAge,
      secure: this.#secure,
    };
  }

  #fromCache(request: SiteRequest, page: CachedPage): SiteResponse {
    if (request.headers.ifNoneMatch !== undefined && request.headers.ifNoneMatch === page.etag) {
      return {
        status: 304,
        headers: { 'cache-control': PUBLIC_CACHE_CONTROL, etag: page.etag },
        body: '',
        cookies: [],
      };
    }
    return this.#send(page.status, page.html, 'public', page.etag, page.widget, page.noindex);
  }

  #html(
    request: SiteRequest,
    page: Rendered,
    caching: 'public' | 'private',
    etag?: string,
  ): SiteResponse {
    if (caching === 'public' && etag !== undefined && request.headers.ifNoneMatch === etag) {
      return {
        status: 304,
        headers: { 'cache-control': PUBLIC_CACHE_CONTROL, etag },
        body: '',
        cookies: [],
      };
    }
    return this.#send(page.status, page.html, caching, etag, page.widget, page.noindex);
  }

  #send(
    status: number,
    html: string,
    caching: 'public' | 'private',
    etag: string | undefined,
    widget: boolean,
    noindex: boolean,
  ): SiteResponse {
    const nonce = nonceOf();
    return {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': pageContentSecurityPolicy(nonce, {
          widget,
          imageSources: this.#deps.imageSources,
        }),
        'cache-control': caching === 'public' ? PUBLIC_CACHE_CONTROL : PRIVATE_CACHE_CONTROL,
        ...(caching === 'public' && etag !== undefined ? { etag } : {}),
        ...(noindex ? { 'x-robots-tag': 'noindex' } : {}),
      },
      body: html.replaceAll(NONCE, nonce),
      cookies: [],
    };
  }
}

const plain = (status: number, body: string): SiteResponse =>
  text(status, body, 'text/plain', PRIVATE_CACHE_CONTROL);

const text = (
  status: number,
  body: string,
  type: string,
  cacheControl = PUBLIC_CACHE_CONTROL,
): SiteResponse => ({
  status,
  headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': cacheControl },
  body,
  cookies: [],
});

const redirect = (status: number, location: string, noStore: boolean): SiteResponse => ({
  status,
  headers: {
    location,
    'cache-control': noStore ? PRIVATE_CACHE_CONTROL : PUBLIC_CACHE_CONTROL,
    vary: 'Accept-Language',
  },
  body: '',
  cookies: [],
});

const queryString = (query: Readonly<Record<string, string | undefined>>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(name, value);
    }
  }
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
};

/** The first of the reader's languages the help center speaks, else the brand's default. */
export const pickLocale = (acceptLanguage: string | undefined, fallback: HcLocale): HcLocale => {
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((param) => /^q=([\d.]+)$/.exec(param.trim())?.[1]).find(Boolean);
      return {
        language: tag.toLowerCase().split('-')[0] ?? '',
        q: q === undefined ? 1 : Number(q),
      };
    })
    .filter((entry) => entry.language !== '' && entry.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const entry of ranked) {
    const parsed = localeSchema.safeParse(entry.language);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return fallback;
};

/** The two video players an article may embed (`videoEmbedUrl`). */
const VIDEO_FRAMES = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'];

/**
 * The pages' policy: their own nonce'd style, fonts and forms; images from
 * this origin, inline data (the callout icons) and the bucket the media
 * redirect points at; the two video players in frames; and — only on a page
 * that carries the widget — scripts from this origin and connections back to
 * it (M4-01).
 */
export const pageContentSecurityPolicy = (
  nonce: string,
  options: { readonly widget: boolean; readonly imageSources: readonly string[] },
): string => {
  const images = ["'self'", 'data:', ...options.imageSources].join(' ');
  return [
    "default-src 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
    "font-src 'self'",
    `img-src ${images}`,
    options.widget ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'none'",
    ...(options.widget ? ["connect-src 'self'", `media-src ${images}`] : []),
    `frame-src ${VIDEO_FRAMES.join(' ')}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
};
