import { expect, test } from '@playwright/test';

const SITE = 'https://helpdock.oday-bakkour.com';
const INDEX = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

test('every page in the sitemap is indexable and canonical to itself', async ({ request }) => {
  const sitemap = await (await request.get('/sitemap-0.xml')).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] as string);
  expect(urls.length).toBeGreaterThan(50);
  const problems: string[] = [];
  for (const url of urls) {
    const html = await (await request.get(url.replace(SITE, ''))).text();
    const robots = /<meta name="robots" content="([^"]*)"/.exec(html)?.[1];
    const canonical = /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
    if (robots !== INDEX) problems.push(`${url}: robots ${robots}`);
    if (canonical !== url) problems.push(`${url}: canonical ${canonical}`);
  }
  expect(problems).toEqual([]);
});

test('the 404 page stays out of the index', async ({ request }) => {
  const html = await (await request.get('/does-not-exist')).text();
  expect(html).toContain('<meta name="robots" content="noindex">');
});

test('robots.txt keeps search engines off the Markdown copies, not AI agents', async ({
  request,
}) => {
  const text = await (await request.get('/robots.txt')).text();
  expect(text).toMatch(/^User-agent: \*\nAllow: \/\n/);
  for (const agent of ['Googlebot', 'Bingbot']) {
    expect(text).toContain(
      `User-agent: ${agent}\nDisallow: /*.md$\nDisallow: /llms-full.txt\nAllow: /\n`,
    );
  }
  expect(text).toContain(`Sitemap: ${SITE}/sitemap-index.xml`);
});
