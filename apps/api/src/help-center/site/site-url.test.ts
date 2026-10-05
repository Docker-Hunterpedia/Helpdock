import { describe, expect, it } from 'vitest';
import { helpCenterSiteUrl } from './site-url.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

describe('helpCenterSiteUrl', () => {
  it('uses the primary domain with the scheme of APP_URL', () => {
    expect(
      helpCenterSiteUrl('https://desk.example.com', {
        brandId: BRAND,
        primaryDomain: 'help.acme.test',
      }),
    ).toBe('https://help.acme.test/');
    expect(
      helpCenterSiteUrl('http://localhost:3000', { brandId: BRAND, primaryDomain: 'help.local' }),
    ).toBe('http://help.local/');
  });

  it('falls back to /hc/<brandId>/ under APP_URL, with or without its trailing slash', () => {
    const expected = `https://desk.example.com/hc/${BRAND}/`;

    expect(
      helpCenterSiteUrl('https://desk.example.com/', { brandId: BRAND, primaryDomain: null }),
    ).toBe(expected);
    expect(
      helpCenterSiteUrl('https://desk.example.com', { brandId: BRAND, primaryDomain: null }),
    ).toBe(expected);
  });
});
