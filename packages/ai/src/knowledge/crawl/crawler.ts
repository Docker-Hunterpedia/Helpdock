import type { ExtractedDocument } from '../chunker.js';
import { htmlToText } from '../html.js';
import { urlFilter } from './patterns.js';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsRules } from './robots.js';
import { parseSitemap } from './sitemap.js';

/**
 * The website crawl (M7-03, REQUIREMENTS §4.7): from a sitemap or from a seed
 * URL whose links are followed, with cheerio by default and a headless
 * browser when the source asks for JavaScript rendering.
 *
 * **Every request goes through {@link CrawlDeps.fetch}**, which the api binds
 * to the SSRF-safe client (DOMAIN-RULES §13): this module never opens a
 * connection of its own. A renderer, when there is one, routes the browser's
 * own requests through the same client.
 *
 * Rules, in the order a URL meets them:
 *
 * 1. Same origin as the start URL; anything else is ignored, not crawled.
 * 2. Include and exclude patterns (`patterns.ts`). Exclude wins. The seed URL
 *    of a link-following crawl is always read for its links, and indexed only
 *    when the patterns include it.
 * 3. `robots.txt` of the origin (`robots.ts`).
 * 4. HTML only; a page that answers anything but 2xx is skipped.
 * 5. At most `maxPages` pages are indexed, and requests are spaced by the
 *    source's rate limit or the site's `Crawl-delay`, whichever is longer.
 *
 * The crawl is a stream of {@link CrawlEvent}s, so the sync job can store each
 * page as it comes and write the log the admin's drawer shows.
 */

export interface CrawlResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** After redirects. */
  readonly url: string;
}

export type CrawlFetch = (url: string) => Promise<CrawlResponse>;

/** A headless browser behind the same safe client. Returns the rendered document. */
export interface PageRenderer {
  render(url: string): Promise<{ readonly html: string; readonly url: string }>;
}

export interface CrawlDeps {
  readonly fetch: CrawlFetch;
  readonly renderer?: PageRenderer | undefined;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CrawlOptions {
  readonly mode: 'sitemap' | 'seed';
  /** The sitemap's URL, or the page to start from. */
  readonly url: string;
  readonly maxPages: number;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** The source's own rate limit: the least time between two requests. */
  readonly minDelayMs?: number;
}

export type SkipReason = 'robots' | 'excluded' | 'not-included' | 'status' | 'not-html' | 'error';

export type CrawlEvent =
  | { readonly type: 'robots'; readonly rules: number; readonly readable: boolean }
  | { readonly type: 'sitemap'; readonly found: number; readonly kept: number }
  | {
      readonly type: 'page';
      readonly url: string;
      readonly document: ExtractedDocument;
      /** One-based position among the pages indexed. */
      readonly index: number;
      /** The pages this crawl will index, when known up front (a sitemap). */
      readonly total: number | undefined;
    }
  | {
      readonly type: 'skipped';
      readonly url: string;
      readonly reason: SkipReason;
      readonly detail?: string;
    };

export const DEFAULT_CRAWL_DELAY_MS = 1_000;
/** A site's `Crawl-delay` is honoured up to this; beyond it the crawl would never finish. */
export const MAX_CRAWL_DELAY_MS = 10_000;
/** Sitemaps read, nested indexes included. */
export const MAX_SITEMAPS = 25;

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

const isHtml = (contentType: string): boolean =>
  HTML_TYPES.some((type) => contentType.toLowerCase().startsWith(type));

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'the request failed';

const pathOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

export async function* crawlSite(
  options: CrawlOptions,
  deps: CrawlDeps,
): AsyncGenerator<CrawlEvent, void, undefined> {
  const start = new URL(options.url);
  const origin = start.origin;
  const sleep = deps.sleep ?? sleepFor;
  const filter = urlFilter(options.include, options.exclude);
  const robotsResponse = await deps.fetch(`${origin}/robots.txt`);
  const robots: RobotsRules =
    robotsResponse.status >= 200 && robotsResponse.status < 300
      ? parseRobots(robotsResponse.body)
      : robotsResponse.status >= 400 && robotsResponse.status < 500
        ? ALLOW_ALL
        : DISALLOW_ALL;
  yield { type: 'robots', rules: robots.ruleCount, readable: robots !== DISALLOW_ALL };
  const delay = Math.min(
    MAX_CRAWL_DELAY_MS,
    Math.max(options.minDelayMs ?? DEFAULT_CRAWL_DELAY_MS, (robots.crawlDelay ?? 0) * 1_000),
  );
  // Every request after `robots.txt` waits its turn.
  const paced = async <T>(request: () => Promise<T>): Promise<T> => {
    await sleep(delay);
    return request();
  };

  const sameOrigin = (url: string): boolean => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  /** Why a URL may not be indexed, or null when it may. */
  const refusal = (url: string): SkipReason | null => {
    const verdict = filter.verdict(url);
    if (verdict !== 'included') {
      return verdict;
    }
    return robots.isAllowed(pathOf(url)) ? null : 'robots';
  };

  const read = async (
    url: string,
  ): Promise<
    | { ok: true; html: string; url: string }
    | { ok: false; reason: SkipReason; detail: string | undefined }
  > => {
    try {
      if (deps.renderer !== undefined) {
        const renderer = deps.renderer;
        const rendered = await paced(() => renderer.render(url));
        return { ok: true, html: rendered.html, url: rendered.url };
      }
      const response = await paced(() => deps.fetch(url));
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: 'status', detail: String(response.status) };
      }
      if (!isHtml(response.contentType)) {
        return { ok: false, reason: 'not-html', detail: response.contentType };
      }
      return { ok: true, html: response.body, url: response.url };
    } catch (error) {
      return { ok: false, reason: 'error', detail: errorText(error) };
    }
  };

  let indexed = 0;

  if (options.mode === 'sitemap') {
    const found = new Set<string>();
    const queue = [start.href];
    let readSitemaps = 0;
    while (queue.length > 0 && readSitemaps < MAX_SITEMAPS) {
      const sitemapUrl = queue.shift() ?? '';
      readSitemaps += 1;
      const response = await paced(() => deps.fetch(sitemapUrl));
      if (response.status < 200 || response.status >= 300) {
        yield { type: 'skipped', url: sitemapUrl, reason: 'status', detail: String(response.status) };
        continue;
      }
      const sitemap = parseSitemap(response.body);
      queue.push(...sitemap.sitemaps.filter(sameOrigin));
      for (const page of sitemap.pages.filter(sameOrigin)) {
        found.add(page);
      }
    }

    const kept: string[] = [];
    for (const url of found) {
      const reason = refusal(url);
      if (reason === null) {
        kept.push(url);
      } else {
        yield { type: 'skipped', url, reason };
      }
    }
    const planned = kept.slice(0, options.maxPages);
    yield { type: 'sitemap', found: found.size, kept: planned.length };

    for (const url of planned) {
      const page = await read(url);
      if (!page.ok) {
        yield { type: 'skipped', url, reason: page.reason, ...detailOf(page.detail) };
        continue;
      }
      indexed += 1;
      yield { type: 'page', url, document: documentOf(page.html, page.url), index: indexed, total: planned.length };
    }
    return;
  }

  const seen = new Set<string>([start.href]);
  const queue = [start.href];
  // Requests are bounded too, so a site of broken links cannot keep a crawl going.
  let attempts = 0;
  const maxAttempts = options.maxPages * 3 + 1;

  while (queue.length > 0 && indexed < options.maxPages && attempts < maxAttempts) {
    const url = queue.shift() ?? '';
    const isSeed = url === start.href;
    const reason = refusal(url);
    if (reason !== null && !(isSeed && reason !== 'robots')) {
      yield { type: 'skipped', url, reason };
      continue;
    }
    attempts += 1;
    const page = await read(url);
    if (!page.ok) {
      yield { type: 'skipped', url, reason: page.reason, ...detailOf(page.detail) };
      continue;
    }
    const { links } = htmlToText(page.html, page.url);
    for (const link of links) {
      if (sameOrigin(link) && !seen.has(link)) {
        seen.add(link);
        queue.push(link);
      }
    }
    if (reason === null) {
      indexed += 1;
      yield { type: 'page', url, document: documentOf(page.html, page.url), index: indexed, total: undefined };
    }
  }
}

const detailOf = (detail: string | undefined): { detail?: string } =>
  detail === undefined ? {} : { detail };

const documentOf = (html: string, url: string): ExtractedDocument => {
  const { title, text } = htmlToText(html, url);
  return { title: title === '' ? url : title, parts: [{ text }] };
};
