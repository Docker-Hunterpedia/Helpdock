import { load } from 'cheerio';

/**
 * A sitemap (sitemaps.org): either a `<urlset>` of page URLs or a
 * `<sitemapindex>` of further sitemaps, which the crawler reads in turn.
 * Compressed `.xml.gz` sitemaps are not read: the safe client hands back the
 * bytes as sent and a crawl does not decompress what it fetched.
 */

export interface Sitemap {
  readonly pages: readonly string[];
  readonly sitemaps: readonly string[];
}

export const parseSitemap = (xml: string): Sitemap => {
  const $ = load(xml, { xml: true });
  const locs = (selector: string): string[] =>
    $(selector)
      .map((_, element) => $(element).text().trim())
      .get()
      .filter((loc) => loc !== '');
  return { pages: locs('urlset > url > loc'), sitemaps: locs('sitemapindex > sitemap > loc') };
};
