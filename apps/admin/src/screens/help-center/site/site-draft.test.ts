import { HC_THEME_DEFAULTS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  checkAccent,
  EMPTY_LINK,
  linkName,
  linksValid,
  moved,
  openHelpCenterHref,
  openRequestOf,
  radiusOf,
} from './site-draft.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const ARTICLE = '0192c3f0-1a2b-7c3d-8e4f-0000000000a9';

describe('checkAccent', () => {
  it('passes the default teal and reports white text on it', () => {
    expect(checkAccent(HC_THEME_DEFAULTS)).toEqual({ kind: 'pass', ratio: 5.5 });
  });

  it('fails an accent below 3:1 on the page, and refuses what is not a colour', () => {
    expect(checkAccent({ ...HC_THEME_DEFAULTS, accent: '#FFFF00', mode: 'light' }).kind).toBe(
      'fail',
    );
    expect(checkAccent({ ...HC_THEME_DEFAULTS, accent: 'teal' })).toEqual({ kind: 'invalid' });
  });
});

describe('radiusOf', () => {
  it('takes a whole number from 0 to 12', () => {
    expect(radiusOf('0')).toBe(0);
    expect(radiusOf(' 12 ')).toBe(12);
    expect(radiusOf('13')).toBeNull();
    expect(radiusOf('6.5')).toBeNull();
    expect(radiusOf('')).toBeNull();
  });
});

describe('moved', () => {
  it('moves an item one step and stops at the edges', () => {
    expect(moved(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});

describe('links', () => {
  it('needs a label and an absolute address on every link', () => {
    const link = { labelEn: 'Main site', labelAr: '', url: 'https://acme.test' };

    expect(linksValid({ header: [link], footer: [] })).toBe(true);
    expect(linksValid({ header: [EMPTY_LINK], footer: [] })).toBe(false);
    expect(linksValid({ header: [], footer: [{ ...link, url: 'javascript:alert(1)' }] })).toBe(
      false,
    );
  });

  it('names a link in the reader’s language, else the other, else untitled', () => {
    const link = { labelEn: 'Privacy', labelAr: 'الخصوصية', url: 'https://acme.test' };

    expect(linkName(link, 'ar', 'x')).toBe('الخصوصية');
    expect(linkName({ ...link, labelAr: '' }, 'ar', 'x')).toBe('Privacy');
    expect(linkName(EMPTY_LINK, 'en', 'New link')).toBe('New link');
  });
});

describe('opening the help center', () => {
  it('writes and reads back a path and a preview', () => {
    const view = new URL(openHelpCenterHref(BRAND, { path: '/en/articles/x' }), 'https://a.test');
    const preview = new URL(
      openHelpCenterHref(BRAND, { preview: { articleId: ARTICLE, locale: 'ar' } }),
      'https://a.test',
    );

    expect(view.pathname).toBe('/help-center/open');
    expect(openRequestOf(view.searchParams)).toEqual({
      brandId: BRAND,
      request: { path: '/en/articles/x' },
    });
    expect(openRequestOf(preview.searchParams)).toEqual({
      brandId: BRAND,
      request: { preview: { articleId: ARTICLE, locale: 'ar' } },
    });
    expect(openRequestOf(new URLSearchParams({ brand: BRAND }))).toEqual({
      brandId: BRAND,
      request: {},
    });
  });

  it('refuses an address that names another host or no brand', () => {
    expect(openRequestOf(new URLSearchParams({ brand: BRAND, path: '//evil.test/x' }))).toBeNull();
    expect(
      openRequestOf(new URLSearchParams({ brand: BRAND, path: 'https://evil.test' })),
    ).toBeNull();
    expect(openRequestOf(new URLSearchParams({ brand: 'nope' }))).toBeNull();
    expect(
      openRequestOf(new URLSearchParams({ brand: BRAND, article: ARTICLE, locale: 'fr' })),
    ).toBeNull();
  });
});
