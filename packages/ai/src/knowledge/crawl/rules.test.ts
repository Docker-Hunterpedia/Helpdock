import { describe, expect, it } from 'vitest';
import { urlFilter } from './patterns.js';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots } from './robots.js';
import { parseSitemap } from './sitemap.js';

describe('parseRobots', () => {
  const robots = `
# comment
User-agent: *
Disallow: /private/
Allow: /private/faq
Crawl-delay: 2

User-agent: OtherBot
Disallow: /

Sitemap: https://docs.example.com/sitemap.xml
`;

  it('applies the * group: longest rule wins, allow wins a tie', () => {
    const rules = parseRobots(robots);

    expect(rules.isAllowed('/docs/a')).toBe(true);
    expect(rules.isAllowed('/private/notes')).toBe(false);
    expect(rules.isAllowed('/private/faq')).toBe(true);
    expect(rules.crawlDelay).toBe(2);
    expect(rules.sitemaps).toEqual(['https://docs.example.com/sitemap.xml']);
    expect(rules.ruleCount).toBe(2);
  });

  it('prefers a group naming this crawler, with wildcards and end anchors', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: helpdockbot\nUser-agent: other\nDisallow: /*.pdf$\nAllow: /\n',
    );

    expect(rules.isAllowed('/docs/guide')).toBe(true);
    expect(rules.isAllowed('/files/a.pdf')).toBe(false);
    expect(rules.isAllowed('/files/a.pdf?x=1')).toBe(true);
  });

  it('ignores rules before any user-agent line and empty disallows', () => {
    const rules = parseRobots('Disallow: /\nUser-agent: *\nDisallow:\nCrawl-delay: soon\n');

    expect(rules.isAllowed('/anything')).toBe(true);
    expect(rules.crawlDelay).toBeUndefined();
  });

  it('has the two fixed answers for a missing and an unreadable file', () => {
    expect(ALLOW_ALL.isAllowed('/x')).toBe(true);
    expect(DISALLOW_ALL.isAllowed('/x')).toBe(false);
  });
});

describe('urlFilter', () => {
  const filter = urlFilter(['/docs/*', '/guides/*'], ['/docs/internal/*', '*/changelog']);

  it('keeps what an include matches and drops what an exclude matches', () => {
    expect(filter.verdict('https://x.test/docs/billing')).toBe('included');
    expect(filter.verdict('https://x.test/docs/internal/keys')).toBe('excluded');
    expect(filter.verdict('https://x.test/guides/changelog')).toBe('excluded');
    expect(filter.verdict('https://x.test/blog/post')).toBe('not-included');
  });

  it('includes everything when there is no include pattern', () => {
    expect(urlFilter([], []).verdict('https://x.test/any?page=2')).toBe('included');
  });
});

describe('parseSitemap', () => {
  it('reads page URLs from a urlset and sitemap URLs from an index', () => {
    expect(
      parseSitemap(
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc> https://x.test/a </loc></url><url><loc></loc></url></urlset>',
      ),
    ).toEqual({ pages: ['https://x.test/a'], sitemaps: [] });
    expect(
      parseSitemap(
        '<sitemapindex><sitemap><loc>https://x.test/docs.xml</loc></sitemap></sitemapindex>',
      ),
    ).toEqual({ pages: [], sitemaps: ['https://x.test/docs.xml'] });
  });
});
