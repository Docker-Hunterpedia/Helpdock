import type { HcLocale, HcSitemapEntry } from '@helpdock/schemas';
import type { SiteLinks } from '../paths.js';
import type { Alternate } from './layout.js';
import { esc } from './text.js';

/**
 * What the help center tells search engines (M5-04, ARCHITECTURE §11): the
 * canonical address and its language alternates, structured data, the
 * sitemap and `robots.txt`.
 *
 * Only a published page read by the **public** audience is indexable. Every
 * state (404, 410, the internal-only wall), search results, and anything
 * rendered for staff carry `noindex` and no canonical; an internal-only help
 * center has no sitemap and disallows everything.
 */

export const X_DEFAULT = 'x-default';

/**
 * `hreflang` links for a page readable in `locales`: one per language and an
 * `x-default` on the brand's default language (or the first there is).
 */
export const alternatesFor = (
  locales: readonly HcLocale[],
  defaultLocale: HcLocale,
  href: (locale: HcLocale) => string,
  links: SiteLinks,
): Alternate[] => {
  if (locales.length === 0) {
    return [];
  }
  const fallback = locales.includes(defaultLocale) ? defaultLocale : (locales[0] as HcLocale);
  return [
    ...locales.map((locale) => ({ hreflang: locale, href: links.url(href(locale)) })),
    { hreflang: X_DEFAULT, href: links.url(href(fallback)) },
  ];
};

export interface Crumbed {
  readonly name: string;
  readonly url: string;
}

export const breadcrumbList = (items: readonly Crumbed[]): object => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map((item, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: item.name,
    item: item.url,
  })),
});

export const articleData = (article: {
  readonly headline: string;
  readonly description: string;
  readonly url: string;
  readonly locale: HcLocale;
  readonly modified: string;
  readonly publisher: string;
  readonly logo: string | null;
}): object => ({
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: article.headline,
  ...(article.description === '' ? {} : { description: article.description }),
  inLanguage: article.locale,
  dateModified: article.modified,
  mainEntityOfPage: article.url,
  publisher: {
    '@type': 'Organization',
    name: article.publisher,
    ...(article.logo === null ? {} : { logo: { '@type': 'ImageObject', url: article.logo } }),
  },
});

/** The home page's `WebSite`, with the search box search engines may offer (`HelpCenter/Home-EN`). */
export const websiteData = (site: {
  readonly name: string;
  readonly url: string;
  readonly locale: HcLocale;
  readonly searchUrl: string;
}): object => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: site.name,
  url: site.url,
  inLanguage: site.locale,
  potentialAction: {
    '@type': 'SearchAction',
    target: { '@type': 'EntryPoint', urlTemplate: `${site.searchUrl}?q={search_term_string}` },
    'query-input': 'required name=search_term_string',
  },
});

/**
 * `sitemap.xml`: one `<url>` per article and language a visitor may read,
 * each with its `hreflang` alternates, plus the two home pages. The entries
 * come from `HelpCenterContentService.sitemap`, which reads the public
 * audience only, so an internal article can never be in it.
 */
export const sitemapXml = (
  entries: readonly HcSitemapEntry[],
  links: SiteLinks,
  homeLocales: readonly HcLocale[],
): string => {
  const alternateLinks = (locales: readonly HcLocale[], href: (locale: HcLocale) => string) =>
    locales
      .map(
        (locale) =>
          `<xhtml:link rel="alternate" hreflang="${locale}" href="${esc(links.url(href(locale)))}"/>`,
      )
      .join('');
  const homes = homeLocales.map(
    (locale) =>
      `<url><loc>${esc(links.url(links.home(locale)))}</loc>${alternateLinks(homeLocales, (other) => links.home(other))}</url>`,
  );
  const articles = entries.map(
    (entry) =>
      `<url><loc>${esc(links.url(links.article(entry.locale, entry.slug)))}</loc><lastmod>${entry.lastModified}</lastmod>${
        entry.alternates.length > 1
          ? alternateLinks(entry.alternates, (locale) => links.article(locale, entry.slug))
          : ''
      }</url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${[...homes, ...articles].join('\n')}
</urlset>
`;
};

/**
 * `robots.txt`. A public help center is open to crawlers except its search
 * results, and names its sitemap; an internal-only one disallows everything.
 */
export const robotsTxt = (options: {
  readonly internalOnly: boolean;
  readonly links: SiteLinks;
}): string =>
  options.internalOnly
    ? 'User-agent: *\nDisallow: /\n'
    : [
        'User-agent: *',
        `Disallow: ${options.links.base}/*/search`,
        `Disallow: ${options.links.base}/_hd/`,
        '',
        `Sitemap: ${options.links.url(options.links.sitemap())}`,
        '',
      ].join('\n');
