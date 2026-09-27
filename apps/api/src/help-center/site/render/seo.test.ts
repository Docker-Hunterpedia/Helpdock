import { describe, expect, it } from 'vitest';
import { SiteLinks } from '../paths.js';
import {
  alternatesFor,
  articleData,
  breadcrumbList,
  robotsTxt,
  sitemapXml,
  websiteData,
} from './seo.js';

const links = new SiteLinks({ base: '', origin: 'https://help.acme.test', brandId: 'b' });

describe('alternatesFor', () => {
  it('lists each language and an x-default on the brand’s default', () => {
    expect(alternatesFor(['en', 'ar'], 'ar', (locale) => links.home(locale), links)).toEqual([
      { hreflang: 'en', href: 'https://help.acme.test/en' },
      { hreflang: 'ar', href: 'https://help.acme.test/ar' },
      { hreflang: 'x-default', href: 'https://help.acme.test/ar' },
    ]);
  });

  it('points x-default at the only language there is when the default is missing', () => {
    expect(
      alternatesFor(['ar'], 'en', (locale) => links.article(locale, 'x'), links).at(-1),
    ).toEqual({ hreflang: 'x-default', href: 'https://help.acme.test/ar/articles/x' });
    expect(alternatesFor([], 'en', (locale) => links.home(locale), links)).toEqual([]);
  });
});

describe('structured data', () => {
  it('describes an article with its publisher and logo', () => {
    expect(
      articleData({
        headline: 'Refund timelines',
        description: '',
        url: 'https://help.acme.test/en/articles/refunds',
        locale: 'en',
        modified: '2026-09-12T09:00:00.000Z',
        publisher: 'Acme',
        logo: 'https://help.acme.test/logo',
      }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Refund timelines',
      inLanguage: 'en',
      dateModified: '2026-09-12T09:00:00.000Z',
      mainEntityOfPage: 'https://help.acme.test/en/articles/refunds',
      publisher: {
        '@type': 'Organization',
        name: 'Acme',
        logo: { '@type': 'ImageObject', url: 'https://help.acme.test/logo' },
      },
    });
  });

  it('numbers a breadcrumb from one', () => {
    expect(
      breadcrumbList([
        { name: 'Help', url: 'u1' },
        { name: 'Orders', url: 'u2' },
      ]),
    ).toMatchObject({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Help', item: 'u1' },
        { '@type': 'ListItem', position: 2, name: 'Orders', item: 'u2' },
      ],
    });
  });

  it('offers the help center’s search to search engines', () => {
    expect(
      websiteData({ name: 'Acme Help', url: 'u', locale: 'ar', searchUrl: 'https://h/ar/search' }),
    ).toMatchObject({
      '@type': 'WebSite',
      potentialAction: {
        '@type': 'SearchAction',
        target: { urlTemplate: 'https://h/ar/search?q={search_term_string}' },
      },
    });
  });
});

describe('sitemapXml', () => {
  it('lists the homes and every readable article with its alternates, escaped', () => {
    const xml = sitemapXml(
      [
        {
          slug: 'refunds',
          locale: 'en',
          lastModified: '2026-09-12T09:00:00.000Z',
          alternates: ['ar', 'en'],
        },
        {
          slug: 'only-en',
          locale: 'en',
          lastModified: '2026-09-10T09:00:00.000Z',
          alternates: ['en'],
        },
      ],
      new SiteLinks({ base: '/hc/b&c', origin: 'https://desk.acme.test', brandId: 'b' }),
      ['en', 'ar'],
    );

    expect(xml).toContain('<loc>https://desk.acme.test/hc/b&amp;c/en</loc>');
    expect(xml).toContain(
      '<url><loc>https://desk.acme.test/hc/b&amp;c/en/articles/refunds</loc><lastmod>2026-09-12T09:00:00.000Z</lastmod><xhtml:link rel="alternate" hreflang="ar"',
    );
    expect(xml).toContain(
      '<url><loc>https://desk.acme.test/hc/b&amp;c/en/articles/only-en</loc><lastmod>2026-09-10T09:00:00.000Z</lastmod></url>',
    );
  });
});

describe('robotsTxt', () => {
  it('opens a public help center except its search, and names the sitemap', () => {
    expect(robotsTxt({ internalOnly: false, links })).toBe(
      'User-agent: *\nDisallow: /*/search\nDisallow: /_hd/\n\nSitemap: https://help.acme.test/sitemap.xml\n',
    );
  });

  it('closes an internal-only one entirely', () => {
    expect(robotsTxt({ internalOnly: true, links })).toBe('User-agent: *\nDisallow: /\n');
  });
});
