import { describe, expect, it } from 'vitest';
import { parseSitePath, SiteLinks } from './paths.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

describe('parseSitePath', () => {
  it.each([
    ['/', { kind: 'root' }],
    ['', { kind: 'root' }],
    ['/en', { kind: 'home', locale: 'en' }],
    ['/ar/', { kind: 'home', locale: 'ar' }],
    ['/en/categories/returns', { kind: 'category', locale: 'en', slug: 'returns' }],
    ['/ar/sections/refunds', { kind: 'section', locale: 'ar', slug: 'refunds' }],
    ['/en/articles/refund-timelines', { kind: 'article', locale: 'en', slug: 'refund-timelines' }],
    ['/en/search', { kind: 'search', locale: 'en' }],
    ['/sitemap.xml', { kind: 'sitemap' }],
    ['/robots.txt', { kind: 'robots' }],
    ['/_hd/staff', { kind: 'staff-session' }],
  ])('reads %s', (path, route) => {
    expect(parseSitePath(path)).toEqual(route);
  });

  it.each([
    ['/fr', null],
    ['/en/articles/Not_A_Slug', 'en'],
    ['/en/articles/refunds/extra', 'en'],
    ['/en/whatever/refunds', 'en'],
    ['/ar/articles', 'ar'],
  ])('answers %s as unknown, in the language it names', (path, locale) => {
    expect(parseSitePath(path)).toEqual({ kind: 'unknown', locale });
  });
});

describe('SiteLinks', () => {
  const host = new SiteLinks({ base: '', origin: 'https://help.acme.test/', brandId: BRAND });
  const fallback = new SiteLinks({
    base: `/hc/${BRAND}`,
    origin: 'https://desk.acme.test',
    brandId: BRAND,
  });

  it('builds the pages at the root of the brand’s host', () => {
    expect(host.article('ar', 'refunds')).toBe('/ar/articles/refunds');
    expect(host.search('en', { q: 'refund status', topic: 'orders' })).toBe(
      '/en/search?q=refund+status&topic=orders',
    );
    expect(host.search('en', { q: '' })).toBe('/en/search');
    expect(host.url(host.home('en'))).toBe('https://help.acme.test/en');
    expect(host.contact('en', 'refunds')).toBe('/contact?lang=en&article=refunds');
  });

  it('puts the brand’s base in front on the install’s fallback path', () => {
    expect(fallback.fallback).toBe(true);
    expect(fallback.category('en', 'orders')).toBe(`/hc/${BRAND}/en/categories/orders`);
    expect(fallback.sitemap()).toBe(`/hc/${BRAND}/sitemap.xml`);
    expect(fallback.contact('ar')).toBe(`/contact/${BRAND}?lang=ar`);
    expect(fallback.feedback()).toBe(`/hc/${BRAND}/_hd/feedback`);
    expect(fallback.signOut()).toBe(`/hc/${BRAND}/_hd/sign-out`);
  });

  it('rebases a link between articles only on the fallback, and leaves other paths alone', () => {
    expect(fallback.bodyHref('/en/articles/refunds')).toBe(`/hc/${BRAND}/en/articles/refunds`);
    expect(fallback.bodyHref('/contact')).toBe('/contact');
    expect(host.bodyHref('/en/articles/refunds')).toBe('/en/articles/refunds');
  });
});
