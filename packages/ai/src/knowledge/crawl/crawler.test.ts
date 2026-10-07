import { describe, expect, it } from 'vitest';
import { type CrawlEvent, type CrawlOptions, type CrawlResponse, crawlSite } from './crawler.js';

const html = (title: string, body: string): CrawlResponse['body'] =>
  `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

/** A site as a map of URL to response; anything else is a 404. */
const site = (pages: Record<string, Partial<CrawlResponse> | Error>) => {
  const requested: string[] = [];
  const fetch = (url: string): Promise<CrawlResponse> => {
    requested.push(url);
    const page = pages[url];
    if (page instanceof Error) {
      return Promise.reject(page);
    }
    return Promise.resolve({
      status: 404,
      contentType: 'text/html',
      body: '',
      url,
      ...(page === undefined ? {} : { status: 200 }),
      ...page,
    });
  };
  return { fetch, requested };
};

const collect = async (
  options: Partial<CrawlOptions> & Pick<CrawlOptions, 'mode' | 'url'>,
  pages: Record<string, Partial<CrawlResponse> | Error>,
) => {
  const fake = site(pages);
  const sleeps: number[] = [];
  const events: CrawlEvent[] = [];
  for await (const event of crawlSite(
    { maxPages: 10, include: [], exclude: [], ...options },
    {
      fetch: fake.fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  )) {
    events.push(event);
  }
  return { events, requested: fake.requested, sleeps };
};

const pagesOf = (events: readonly CrawlEvent[]) =>
  events.flatMap((event) => (event.type === 'page' ? [event.url] : []));
const skipsOf = (events: readonly CrawlEvent[]) =>
  events.flatMap((event) => (event.type === 'skipped' ? [[event.url, event.reason]] : []));

const origin = 'https://docs.example.com';

describe('crawlSite from a sitemap', () => {
  it('reads nested sitemaps and indexes what robots and the patterns allow', async () => {
    const { events, sleeps } = await collect(
      { mode: 'sitemap', url: `${origin}/sitemap.xml`, exclude: ['/docs/internal/*'] },
      {
        [`${origin}/robots.txt`]: { body: 'User-agent: *\nDisallow: /private\nCrawl-delay: 3' },
        [`${origin}/sitemap.xml`]: {
          body: `<sitemapindex><sitemap><loc>${origin}/docs.xml</loc></sitemap><sitemap><loc>https://evil.test/x.xml</loc></sitemap></sitemapindex>`,
        },
        [`${origin}/docs.xml`]: {
          body: `<urlset><url><loc>${origin}/docs/refunds</loc></url><url><loc>${origin}/docs/internal/keys</loc></url><url><loc>${origin}/private/a</loc></url><url><loc>${origin}/docs/old</loc></url><url><loc>${origin}/docs/pdf</loc></url></urlset>`,
        },
        [`${origin}/docs/refunds`]: { body: html('Refunds', '<h1>Refunds</h1><p>Five days.</p>') },
        [`${origin}/docs/pdf`]: { contentType: 'application/pdf' },
      },
    );

    expect(events[0]).toEqual({ type: 'robots', rules: 1, readable: true });
    expect(pagesOf(events)).toEqual([`${origin}/docs/refunds`]);
    expect(skipsOf(events)).toEqual([
      [`${origin}/docs/internal/keys`, 'excluded'],
      [`${origin}/private/a`, 'robots'],
      [`${origin}/docs/old`, 'status'],
      [`${origin}/docs/pdf`, 'not-html'],
    ]);
    expect(events.find((event) => event.type === 'sitemap')).toEqual({
      type: 'sitemap',
      found: 5,
      kept: 3,
    });
    const page = events.find((event) => event.type === 'page');
    expect(page).toMatchObject({
      index: 1,
      total: 3,
      document: { title: 'Refunds', parts: [{ text: '# Refunds\n\nFive days.' }] },
    });
    expect(new Set(sleeps)).toEqual(new Set([3_000]));
  });

  it('stops at the page limit and records a sitemap that would not load', async () => {
    const { events } = await collect(
      { mode: 'sitemap', url: `${origin}/sitemap.xml`, maxPages: 1 },
      {
        [`${origin}/sitemap.xml`]: {
          body: `<urlset><url><loc>${origin}/a</loc></url><url><loc>${origin}/b</loc></url></urlset>`,
        },
        [`${origin}/a`]: { body: html('A', '<p>a</p>') },
        [`${origin}/b`]: { body: html('B', '<p>b</p>') },
      },
    );
    const missing = await collect({ mode: 'sitemap', url: `${origin}/gone.xml` }, {});

    expect(pagesOf(events)).toEqual([`${origin}/a`]);
    expect(skipsOf(missing.events)).toEqual([[`${origin}/gone.xml`, 'status']]);
  });
});

describe('crawlSite from a seed', () => {
  it('follows same-origin links within the patterns and reads the seed for links only', async () => {
    const { events, requested } = await collect(
      { mode: 'seed', url: `${origin}/`, include: ['/docs/*'] },
      {
        [`${origin}/`]: {
          body: html(
            'Home',
            `<a href="/docs/a">a</a><a href="/blog">b</a><a href="https://else.test/">x</a>`,
          ),
        },
        [`${origin}/docs/a`]: {
          body: html('A', '<p>A.</p><a href="/docs/b">b</a><a href="/docs/a">self</a>'),
        },
        [`${origin}/docs/b`]: new Error('destination blocked: 10.0.4.12'),
      },
    );

    expect(pagesOf(events)).toEqual([`${origin}/docs/a`]);
    expect(skipsOf(events)).toEqual([
      [`${origin}/blog`, 'not-included'],
      [`${origin}/docs/b`, 'error'],
    ]);
    expect(
      events.find((event) => event.type === 'skipped' && event.reason === 'error'),
    ).toMatchObject({ detail: 'destination blocked: 10.0.4.12' });
    expect(requested).not.toContain('https://else.test/');
  });

  it('crawls nothing when robots.txt cannot be read, and everything when it is missing', async () => {
    const unreadable = await collect(
      { mode: 'seed', url: `${origin}/` },
      {
        [`${origin}/robots.txt`]: { status: 503 },
        [`${origin}/`]: { body: html('H', '<p>h</p>') },
      },
    );
    const missing = await collect(
      { mode: 'seed', url: `${origin}/` },
      { [`${origin}/`]: { body: html('H', '<p>h</p>') } },
    );

    expect(unreadable.events[0]).toEqual({ type: 'robots', rules: 1, readable: false });
    expect(skipsOf(unreadable.events)).toEqual([[`${origin}/`, 'robots']]);
    expect(pagesOf(missing.events)).toEqual([`${origin}/`]);
  });

  it('renders pages through the renderer when the source asks for it', async () => {
    const events: CrawlEvent[] = [];
    const fake = site({});
    for await (const event of crawlSite(
      { mode: 'seed', url: `${origin}/`, maxPages: 1, include: [], exclude: [] },
      {
        fetch: fake.fetch,
        sleep: () => Promise.resolve(),
        renderer: {
          render: (url) => Promise.resolve({ html: html('Rendered', '<p>Built by JS.</p>'), url }),
        },
      },
    )) {
      events.push(event);
    }

    expect(events.find((event) => event.type === 'page')).toMatchObject({
      document: { title: 'Rendered' },
    });
  });
});
