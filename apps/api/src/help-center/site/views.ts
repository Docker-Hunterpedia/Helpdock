import type {
  HcAudience,
  HcLocale,
  HcPublishedArticle,
  HcTreeArticle,
  HcTreeCategory,
  HcTreeSection,
} from '@helpdock/schemas';
import { HC_POPULAR_COUNT } from '@helpdock/schemas';
import type { PopularArticle, SearchHit } from '../ports.js';
import { type FeedbackStep, feedbackHref } from './feedback-step.js';
import type { SiteLinks } from './paths.js';
import { articleBodyHtml } from './render/article-body.js';
import { type ChromeView, type HeadView, type NavLink, renderDocument } from './render/layout.js';
import {
  articleMain,
  type Crumb,
  categoryMain,
  goneMain,
  type HelpView,
  highlight,
  homeMain,
  type ListItem,
  notFoundMain,
  previewBanner,
  type SectionCard,
  searchMain,
  wallMain,
} from './render/pages.js';
import { alternatesFor, articleData, breadcrumbList, websiteData } from './render/seo.js';
import {
  formatDate,
  formatDateTime,
  readingMinutes,
  type Translate,
  translator,
} from './render/text.js';
import type { SiteConfig } from './site-config.js';
import type { GoneArticle, PreviewArticle } from './site-reads.js';
import type { StaffReader } from './staff-access.js';
import { themeStylesheet } from './theme.js';

/**
 * From what the help center holds to a finished document, one function per
 * page (M5-03, M5-04). `HelpCenterSite` fetches; this decides what each page
 * shows, links to and tells search engines, and hands the result to the
 * renderer. Nothing here reads the database or the request.
 */

export interface PageContext {
  readonly config: SiteConfig;
  readonly locale: HcLocale;
  readonly links: SiteLinks;
  /**
   * Where search engines are sent: the same as `links`, except on the
   * install's fallback path for a brand that has a domain, whose pages
   * point their canonical at the domain.
   */
  readonly seo: SiteLinks;
  readonly audience: HcAudience;
  readonly staff: StaffReader | null;
  /** Categories → sections → articles this audience may read. */
  readonly tree: readonly HcTreeCategory[];
  /**
   * For staff: the article ids a visitor could read, so the rest carry the
   * Internal badge. Null for a visitor, who sees nothing else.
   */
  readonly publicIds: ReadonlySet<string> | null;
  /** The widget runs on this origin (the brand allowed it on Channels › Widget). */
  readonly widget: boolean;
  /** An address in the admin, for "Edit in admin" and the wall's sign-in. */
  readonly adminUrl: (path: string) => string;
}

export interface Rendered {
  readonly status: number;
  readonly html: string;
  readonly noindex: boolean;
  readonly widget: boolean;
}

/** How many articles a category page lists per section before "See all" (`HelpCenter/Category-EN`). */
export const SECTION_PREVIEW = 5;
const RELATED_COUNT = 3;
/** How many categories the header names before it would crowd the search. */
const HEADER_CATEGORIES = 5;

const OTHER: Readonly<Record<HcLocale, HcLocale>> = { en: 'ar', ar: 'en' };

const tOf = (context: PageContext): Translate => translator(context.locale);

/** A page's own link (`links`) as the absolute address search engines are given (`seo`). */
const seoUrl = (context: PageContext, href: string): string =>
  context.seo === context.links
    ? context.links.url(href)
    : context.seo.url(href.slice(context.links.base.length));

const siteName = (context: PageContext): string =>
  tOf(context)(
    context.config.access === 'internal_only' ? 'siteName.internal' : 'siteName.public',
    {
      brand: context.config.brandName,
    },
  );

const isInternal = (context: PageContext, articleId: string): boolean =>
  context.publicIds !== null && !context.publicIds.has(articleId);

const articleItem = (context: PageContext, article: HcTreeArticle, meta?: string): ListItem => ({
  title: article.title,
  lang: article.locale,
  href: context.links.article(context.locale, article.slug),
  internal: isInternal(context, article.id),
  ...(meta === undefined ? {} : { meta }),
});

interface Located {
  readonly category: HcTreeCategory;
  readonly section: HcTreeSection;
  readonly article: HcTreeArticle;
}

/** Every readable article with where it lives, in staff's order. */
export const flatten = (tree: readonly HcTreeCategory[]): Located[] =>
  tree.flatMap((category) =>
    category.sections.flatMap((section) =>
      section.articles.map((article) => ({ category, section, article })),
    ),
  );

/**
 * "Still need help?": the web form, and the widget where it runs. On an
 * article both carry its id: `/contact?article=<id>` and
 * `Helpdock('open', { article: <id> })` (M5-08).
 */
const help = (context: PageContext, articleId: string | null, preview = false): HelpView => ({
  contactHref: context.links.contact(context.locale, articleId ?? undefined),
  chat:
    context.widget && !preview
      ? JSON.stringify(articleId === null ? null : { article: articleId })
      : null,
  preview,
});

interface ChromeOptions {
  readonly head: HeadView;
  readonly otherLocaleHref: string;
  readonly headerSearch: boolean;
  readonly nav: boolean;
  readonly currentCategoryId?: string;
  readonly banner?: string;
  /** Widget off: the states, the wall and a preview. */
  readonly widget: boolean;
}

const chrome = (context: PageContext, options: ChromeOptions): ChromeView => {
  const { config, links, locale } = context;
  const t = tOf(context);
  const label = (link: { labelEn: string; labelAr: string }) =>
    (locale === 'ar' ? link.labelAr || link.labelEn : link.labelEn || link.labelAr) ?? '';
  const nav: NavLink[] = options.nav
    ? context.tree.slice(0, HEADER_CATEGORIES).map((category) => ({
        label: category.name,
        href: links.category(locale, category.slug),
        current: category.id === options.currentCategoryId,
      }))
    : [];
  return {
    locale,
    t,
    links,
    siteName: siteName(context),
    brandName: config.brandName,
    logoSrc: config.logo === null ? null : links.url(config.logo.src),
    faviconSrc: config.favicon?.src ?? null,
    nav,
    headerLinks: options.nav
      ? config.links.header.map((link) => ({ label: label(link), url: link.url }))
      : [],
    footerLinks: config.links.footer.map((link) => ({ label: label(link), url: link.url })),
    headerSearch: options.headerSearch,
    otherLocaleHref: options.otherLocaleHref,
    staff: context.staff,
    internalOnly: config.access === 'internal_only',
    themeCss: themeStylesheet(config.theme),
    customCss: config.customCss,
    mode: config.theme.mode,
    widget: options.widget && context.widget ? { brandId: config.brandId } : null,
    banner: options.banner ?? null,
    head: options.head,
  };
};

/** Indexable only for a visitor; staff pages and every state are `noindex`. */
const indexable = (context: PageContext): boolean => context.audience === 'public';

const document = (
  context: PageContext,
  options: ChromeOptions,
  main: string,
  status = 200,
): Rendered => {
  const view = chrome(context, options);
  return {
    status,
    html: renderDocument(view, main),
    noindex: view.head.noindex,
    widget: view.widget !== null,
  };
};

const stateHead = (context: PageContext, titleKey: string): HeadView => ({
  title: `${tOf(context)(titleKey)} · ${siteName(context)}`,
  description: tOf(context)('meta.description', { brand: context.config.brandName }),
  canonical: null,
  alternates: [],
  noindex: true,
  og: null,
  jsonLd: [],
});

const homeCrumb = (context: PageContext): Crumb => ({
  label: tOf(context)(context.config.access === 'internal_only' ? 'nav.homeInternal' : 'nav.home'),
  href: context.links.home(context.locale),
});

// ---------------------------------------------------------------- home

export const renderHome = (context: PageContext, popular: readonly PopularArticle[]): Rendered => {
  const { config, links, locale, tree } = context;
  const t = tOf(context);
  const located = flatten(tree);
  const byId = new Map(located.map((entry) => [entry.article.id, entry]));
  const featured = config.home.featured
    ? config.home.featuredArticleIds
        .map((id) => byId.get(id))
        .filter((entry): entry is Located => entry !== undefined)
        .map((entry) => articleItem(context, entry.article, entry.category.name))
    : null;
  const popularItems = config.home.popular
    ? popular
        .filter((hit) => byId.has(hit.articleId))
        .slice(0, HC_POPULAR_COUNT)
        .map((hit) => {
          const entry = byId.get(hit.articleId) as Located;
          return articleItem(context, entry.article, entry.category.name);
        })
    : null;
  const { seo } = context;
  const url = seo.url(seo.home(locale));

  return document(
    context,
    {
      head: {
        title: siteName(context),
        description: t('meta.description', { brand: config.brandName }),
        canonical: indexable(context) ? url : null,
        alternates: indexable(context)
          ? alternatesFor(['en', 'ar'], config.defaultLocale, (other) => seo.home(other), seo)
          : [],
        noindex: !indexable(context),
        og: indexable(context) ? { type: 'website', image: chromeLogo(context) } : null,
        jsonLd: indexable(context)
          ? [
              websiteData({
                name: siteName(context),
                url,
                locale,
                searchUrl: seo.url(seo.search(locale)),
              }),
            ]
          : [],
      },
      otherLocaleHref: links.home(OTHER[locale]),
      headerSearch: false,
      nav: true,
      widget: true,
    },
    homeMain({
      t,
      locale,
      searchAction: links.search(locale),
      categories: config.home.categories
        ? tree.map((category) => ({
            name: category.name,
            description: category.description,
            href: links.category(locale, category.slug),
            sections: category.sections.length,
            articles: category.sections.reduce((sum, section) => sum + section.articles.length, 0),
          }))
        : null,
      featured,
      popular: popularItems,
      help: help(context, null),
    }),
  );
};

const chromeLogo = (context: PageContext): string | null =>
  context.config.logo === null ? null : context.links.url(context.config.logo.src);

// ---------------------------------------------------------------- category and section

const sectionCard = (
  context: PageContext,
  section: HcTreeSection,
  limit: number | null,
): SectionCard => ({
  id: section.id,
  name: section.name,
  href: context.links.section(context.locale, section.slug),
  articles: (limit === null ? section.articles : section.articles.slice(0, limit)).map((article) =>
    articleItem(context, article),
  ),
  total: section.articles.length,
});

/** A category page, or null when the audience may read nothing in it (a 404). */
export const renderCategory = (context: PageContext, slug: string): Rendered | null => {
  const { links, locale, tree } = context;
  const category = tree.find((candidate) => candidate.slug === slug);
  if (category === undefined) {
    return null;
  }
  const t = tOf(context);
  const articles = category.sections.reduce((sum, section) => sum + section.articles.length, 0);
  const url = context.seo.url(context.seo.category(locale, slug));
  const crumbs = [homeCrumb(context), { label: category.name, href: null }];

  return document(
    context,
    {
      head: listingHead(context, category.name, category.description, url, crumbs, (other) =>
        context.seo.category(other, slug),
      ),
      otherLocaleHref: links.category(OTHER[locale], slug),
      headerSearch: true,
      nav: true,
      currentCategoryId: category.id,
      widget: true,
    },
    categoryMain({
      t,
      locale,
      crumbs,
      title: category.name,
      description: category.description,
      meta: `${t('counts.sections', { count: category.sections.length })} · ${t('counts.articles', { count: articles })}`,
      sections: category.sections.map((section) => sectionCard(context, section, SECTION_PREVIEW)),
      single: false,
      otherTopics: otherTopics(context, category.id),
      help: help(context, null),
    }),
  );
};

/** A section page: the category layout with the one card (`HelpCenter/Category-EN`'s note). */
export const renderSection = (context: PageContext, slug: string): Rendered | null => {
  const { links, locale, tree } = context;
  const category = tree.find((candidate) =>
    candidate.sections.some((section) => section.slug === slug),
  );
  const section = category?.sections.find((candidate) => candidate.slug === slug);
  if (category === undefined || section === undefined) {
    return null;
  }
  const t = tOf(context);
  const url = context.seo.url(context.seo.section(locale, slug));
  const crumbs = [
    homeCrumb(context),
    { label: category.name, href: links.category(locale, category.slug) },
    { label: section.name, href: null },
  ];

  return document(
    context,
    {
      head: listingHead(context, section.name, category.description, url, crumbs, (other) =>
        context.seo.section(other, slug),
      ),
      otherLocaleHref: links.section(OTHER[locale], slug),
      headerSearch: true,
      nav: true,
      currentCategoryId: category.id,
      widget: true,
    },
    categoryMain({
      t,
      locale,
      crumbs,
      title: section.name,
      description: '',
      meta: t('counts.articles', { count: section.articles.length }),
      sections: [sectionCard(context, section, null)],
      single: true,
      otherTopics: otherTopics(context, category.id),
      help: help(context, null),
    }),
  );
};

const otherTopics = (context: PageContext, currentId: string): NavLink[] =>
  context.tree
    .filter((category) => category.id !== currentId)
    .map((category) => ({
      label: category.name,
      href: context.links.category(context.locale, category.slug),
      current: false,
    }));

const listingHead = (
  context: PageContext,
  title: string,
  description: string,
  url: string,
  crumbs: readonly Crumb[],
  hrefIn: (locale: HcLocale) => string,
): HeadView => {
  const { config } = context;
  const open = indexable(context);
  return {
    title: `${title} · ${siteName(context)}`,
    description:
      description === ''
        ? tOf(context)('meta.description', { brand: config.brandName })
        : description,
    canonical: open ? url : null,
    alternates: open ? alternatesFor(['en', 'ar'], config.defaultLocale, hrefIn, context.seo) : [],
    noindex: !open,
    og: open ? { type: 'website', image: chromeLogo(context) } : null,
    jsonLd: open
      ? [
          breadcrumbList(
            crumbs.map((crumb) => ({
              name: crumb.label,
              url: crumb.href === null ? url : seoUrl(context, crumb.href),
            })),
          ),
        ]
      : [],
  };
};

// ---------------------------------------------------------------- article

export interface ArticleOptions {
  readonly feedback: FeedbackStep;
}

const sectionNavOf = (context: PageContext, sectionId: string, currentId: string): NavLink[] => {
  const section = context.tree
    .flatMap((category) => category.sections)
    .find((candidate) => candidate.id === sectionId);
  return (section?.articles ?? []).map((article) => ({
    label: article.title,
    href: context.links.article(context.locale, article.slug),
    current: article.id === currentId,
  }));
};

const relatedOf = (
  context: PageContext,
  categoryId: string,
  articleId: string,
  sectionId: string,
) => {
  const inCategory = flatten(context.tree).filter(
    (entry) => entry.category.id === categoryId && entry.article.id !== articleId,
  );
  const elsewhere = inCategory.filter((entry) => entry.section.id !== sectionId);
  return [...elsewhere, ...inCategory.filter((entry) => entry.section.id === sectionId)]
    .slice(0, RELATED_COUNT)
    .map((entry) => articleItem(context, entry.article));
};

const articleCrumbs = (
  context: PageContext,
  article: { category: { slug: string; name: string }; section: { slug: string; name: string } },
  title: string,
  lang: HcLocale,
): Crumb[] => [
  homeCrumb(context),
  {
    label: article.category.name,
    href: context.links.category(context.locale, article.category.slug),
  },
  {
    label: article.section.name,
    href: context.links.section(context.locale, article.section.slug),
  },
  { label: title, href: null, lang },
];

const bodyOf = (context: PageContext, html: string): string =>
  articleBodyHtml(html, {
    videoTitle: tOf(context)('article.video'),
    href: (path) => context.links.bodyHref(path),
  });

export const renderArticle = (
  context: PageContext,
  article: HcPublishedArticle,
  options: ArticleOptions,
): Rendered => {
  const { config, links, locale } = context;
  const t = tOf(context);
  const open = indexable(context);
  const crumbs = articleCrumbs(context, article, article.title, article.locale);
  // A fallback's canonical is the article in its own language, which has no
  // alternate in the language asked for (`HelpCenter/Article-AR` panel 1).
  const { seo } = context;
  const canonical = seo.url(seo.article(article.locale, article.slug));
  const updated = t('article.updated', {
    date: formatDate(new Date(article.publishedAt), locale, config.timezone),
  });
  const readTime = t('article.readTime', { count: readingMinutes(article.bodyHtml) });

  return document(
    context,
    {
      head: {
        title: `${article.title} · ${siteName(context)}`,
        description:
          article.description === ''
            ? t('meta.description', { brand: config.brandName })
            : article.description,
        canonical: open ? canonical : null,
        alternates: open
          ? alternatesFor(
              article.locales,
              config.defaultLocale,
              (other) => seo.article(other, article.slug),
              seo,
            )
          : [],
        noindex: !open,
        og: open ? { type: 'article', image: chromeLogo(context) } : null,
        jsonLd: open
          ? [
              articleData({
                headline: article.title,
                description: article.description,
                url: canonical,
                locale: article.locale,
                modified: article.publishedAt,
                publisher: config.brandName,
                logo: chromeLogo(context),
              }),
              breadcrumbList(
                crumbs.map((crumb) => ({
                  name: crumb.label,
                  url: crumb.href === null ? canonical : seoUrl(context, crumb.href),
                })),
              ),
            ]
          : [],
      },
      otherLocaleHref: links.article(OTHER[locale], article.slug),
      headerSearch: true,
      nav: true,
      currentCategoryId: article.category.id,
      widget: true,
    },
    articleMain({
      t,
      locale,
      crumbs,
      title: article.title,
      lang: article.locale,
      meta: [updated, readTime],
      fallback: article.fallback
        ? {
            title: t('article.fallback.title', { language: t(`languageName.${locale}`) }),
            body: t('article.fallback.body', { original: t(`languageName.${article.locale}`) }),
            browseHref: links.section(locale, article.section.slug),
          }
        : null,
      bodyHtml: bodyOf(context, article.bodyHtml),
      internal: article.visibility === 'internal' || isInternal(context, article.id),
      sectionName: article.section.name,
      sectionNav: sectionNavOf(context, article.section.id, article.id),
      related: relatedOf(context, article.category.id, article.id, article.section.id),
      feedback: {
        action: links.feedback(),
        articleId: article.id,
        locale: article.locale,
        slug: article.slug,
        step: options.feedback,
        skipHref: feedbackHref(links.article(locale, article.slug), 'thanks'),
      },
      help: help(context, article.id),
    }),
  );
};

/** The editor's Preview (`HelpCenter/States-EN` panel 5): the working copy, for staff. */
export const renderPreview = (context: PageContext, article: PreviewArticle): Rendered => {
  const { config, links, locale } = context;
  const t = tOf(context);
  const date =
    article.state === 'scheduled' && article.scheduledAt !== null
      ? formatDateTime(article.scheduledAt, locale, config.timezone)
      : article.publishedAt === null
        ? null
        : formatDate(article.publishedAt, locale, config.timezone);
  const banner = previewBanner({
    t,
    locale,
    state: article.state,
    date,
    editHref: context.adminUrl(`/help-center/articles/${article.id}`),
    exitHref: links.article(locale, article.slug),
  });
  const meta =
    article.state === 'draft'
      ? [t('preview.draftMeta')]
      : [
          t('article.updated', { date: formatDate(article.updatedAt, locale, config.timezone) }),
          t('article.readTime', { count: readingMinutes(article.bodyHtml) }),
        ];

  return document(
    context,
    {
      head: {
        ...stateHead(context, 'preview.label'),
        title: `${t('preview.label')} · ${article.title}`,
      },
      otherLocaleHref: `${links.article(OTHER[locale], article.slug)}?preview=1`,
      headerSearch: true,
      nav: true,
      currentCategoryId: article.category.id,
      banner,
      widget: false,
    },
    articleMain({
      t,
      locale,
      crumbs: articleCrumbs(context, article, article.title, locale),
      title: article.title,
      lang: locale,
      meta,
      fallback: null,
      bodyHtml: bodyOf(context, article.bodyHtml),
      internal: article.visibility === 'internal',
      sectionName: article.section.name,
      sectionNav: sectionNavOf(context, article.section.id, article.id),
      related: [],
      feedback: null,
      help: help(context, null, true),
    }),
  );
};

// ---------------------------------------------------------------- search

export const renderSearch = (
  context: PageContext,
  query: { readonly q: string; readonly topic: string | null },
  hits: readonly SearchHit[],
  searchId: string | undefined,
): Rendered => {
  const { links, locale } = context;
  const t = tOf(context);
  const categoryOf = new Map(
    flatten(context.tree).map((entry) => [entry.article.id, entry.category]),
  );
  const inTopic = hits.filter(
    (hit) => query.topic === null || categoryOf.get(hit.articleId)?.slug === query.topic,
  );
  const counts = new Map<string, number>();
  for (const hit of hits) {
    const category = categoryOf.get(hit.articleId);
    if (category !== undefined) {
      counts.set(category.id, (counts.get(category.id) ?? 0) + 1);
    }
  }
  const filters =
    hits.length === 0
      ? []
      : [
          {
            label: t('search.allTopics'),
            href: links.search(locale, { q: query.q }),
            current: query.topic === null,
            count: hits.length,
          },
          ...context.tree
            .filter((category) => counts.has(category.id))
            .map((category) => ({
              label: category.name,
              href: links.search(locale, { q: query.q, topic: category.slug }),
              current: query.topic === category.slug,
              count: counts.get(category.id) ?? 0,
            })),
        ];

  return document(
    context,
    {
      head: {
        ...stateHead(context, 'search.title'),
        title: `${query.q === '' ? t('search.title') : query.q} · ${siteName(context)}`,
      },
      otherLocaleHref: links.search(OTHER[locale], { q: query.q }),
      headerSearch: false,
      nav: true,
      widget: true,
    },
    searchMain({
      t,
      locale,
      q: query.q,
      action: links.search(locale),
      clearHref: links.search(locale),
      results: inTopic.map((hit) => ({
        title: hit.title,
        lang: hit.locale,
        href: links.article(locale, hit.slug, searchId),
        titleHtml: highlight(hit.title, query.q),
        snippetHtml: highlight(hit.snippet, query.q),
        trail: [categoryOf.get(hit.articleId)?.name, hit.sectionTitle].filter(
          (part): part is string => part !== undefined && part !== '',
        ),
      })),
      total: inTopic.length,
      language: t(`languageName.${locale}`),
      filters,
      topics: context.tree.map((category) => ({
        label: category.name,
        href: links.category(locale, category.slug),
        current: false,
      })),
      help: help(context, null),
    }),
  );
};

// ---------------------------------------------------------------- states

export const renderNotFound = (
  context: PageContext,
  popular: readonly PopularArticle[],
): Rendered => {
  const { links, locale } = context;
  const readable = new Map(flatten(context.tree).map((entry) => [entry.article.id, entry.article]));
  return document(
    context,
    {
      head: stateHead(context, 'states.notFound.title'),
      otherLocaleHref: links.home(OTHER[locale]),
      headerSearch: false,
      nav: false,
      widget: false,
    },
    notFoundMain({
      t: tOf(context),
      locale,
      searchAction: links.search(locale),
      homeHref: links.home(locale),
      popular: popular
        .map((hit) => readable.get(hit.articleId))
        .filter((article): article is HcTreeArticle => article !== undefined)
        .slice(0, 2)
        .map((article) => articleItem(context, article)),
    }),
    404,
  );
};

export const renderGone = (context: PageContext, gone: GoneArticle | null): Rendered => {
  const { config, links, locale } = context;
  const section =
    gone === null
      ? undefined
      : context.tree
          .flatMap((category) => category.sections)
          .find((candidate) => candidate.id === gone.sectionId);
  return document(
    context,
    {
      head: stateHead(context, 'states.gone.title'),
      otherLocaleHref: links.home(OTHER[locale]),
      headerSearch: false,
      nav: false,
      widget: false,
    },
    goneMain({
      t: tOf(context),
      locale,
      searchAction: links.search(locale),
      article:
        gone === null
          ? null
          : {
              title: gone.title,
              date: formatDate(gone.retiredAt, locale, config.timezone),
              sectionName: gone.sectionName,
            },
      more: (section?.articles ?? [])
        .slice(0, RELATED_COUNT)
        .map((article) => articleItem(context, article)),
    }),
    410,
  );
};

/** The internal-only wall (`HelpCenter/States-EN` panel 2): 401 and noindex, on every page. */
export const renderWall = (context: PageContext, returnPath: string): Rendered => {
  const { config, links, locale } = context;
  const query = new URLSearchParams({ brand: config.brandId, path: returnPath });
  return document(
    context,
    {
      head: stateHead(context, 'states.wall.title'),
      otherLocaleHref: links.home(OTHER[locale]),
      headerSearch: false,
      nav: false,
      widget: false,
    },
    wallMain({
      t: tOf(context),
      locale,
      brandName: config.brandName,
      signInHref: context.adminUrl(`/help-center/open?${query.toString()}`),
    }),
    401,
  );
};
