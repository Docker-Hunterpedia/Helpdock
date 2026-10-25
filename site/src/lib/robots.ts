/** The robots meta of every indexable page: large previews and full snippets. */
export const INDEX_ROBOTS =
  'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

/** Search engines that would otherwise index the Markdown copies as duplicates. */
export const SEARCH_ENGINES = ['Googlebot', 'Bingbot'] as const;

/** Duplicates of the HTML guides, kept from search engines and open to AI agents. */
export const DUPLICATES = ['/*.md$', '/llms-full.txt'] as const;

/**
 * robots.txt: everyone may read everything, so AI agents still get the
 * Markdown; the named search engines skip the duplicates and index the HTML.
 */
export function robotsTxt(siteUrl: string): string {
  const engines = SEARCH_ENGINES.map((agent) =>
    [`User-agent: ${agent}`, ...DUPLICATES.map((path) => `Disallow: ${path}`), 'Allow: /'].join(
      '\n',
    ),
  );
  return `${[
    'User-agent: *\nAllow: /',
    ...engines,
    `Sitemap: ${new URL('/sitemap-index.xml', siteUrl).href}`,
  ].join('\n\n')}\n`;
}
