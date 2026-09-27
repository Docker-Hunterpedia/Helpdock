import {
  HC_SURFACE_TONES,
  HC_THEME_DEFAULTS,
  HC_THEME_FONTS,
  HC_THEME_MODES,
} from '@helpdock/schemas';
import { BRAND_FONTS } from '@helpdock/ui/resolve';
import { describe, expect, it, vi } from 'vitest';
import {
  createPageCacheHandler,
  HC_PAGE_EVENTS,
  PAGE_CACHE_SUBSCRIBER,
  registerPageCacheHandlers,
} from './cache-events.js';
import { imageSourcesOf } from './site-content.js';
import { themeContrastError, themeStylesheet } from './theme.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

describe('the page cache’s subscription', () => {
  it('drops the brand’s pages on every help center event, under its own name', () => {
    const register = vi.fn();
    registerPageCacheHandlers({ invalidate: vi.fn() }, { register });

    expect(register.mock.calls.map(([event, , subscriber]) => [event, subscriber])).toEqual(
      HC_PAGE_EVENTS.map((event) => [event, PAGE_CACHE_SUBSCRIBER]),
    );
  });

  it('invalidates the brand the event came from', async () => {
    const invalidate = vi.fn(() => Promise.resolve());
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await createPageCacheHandler({ invalidate })({
      outboxId: 'o1',
      brandId: BRAND,
      event: 'help_center.article_changed',
      payload: {},
      tx: {} as never,
      log: log as never,
    });

    expect(invalidate).toHaveBeenCalledWith(BRAND);
  });
});

describe('the theme', () => {
  it('accepts exactly what the brand resolver accepts', () => {
    expect([...HC_THEME_FONTS]).toEqual(Object.keys(BRAND_FONTS));
    expect([...HC_THEME_MODES]).toEqual(['light', 'dark', 'auto']);
    expect([...HC_SURFACE_TONES]).toEqual(['warm', 'neutral', 'cool']);
  });

  it('writes the brand’s accent into the tokens, once per theme', () => {
    const css = themeStylesheet({ ...HC_THEME_DEFAULTS, accent: '#2B5FB3' });

    expect(css).toContain('--hd-action-primary: #2B5FB3;');
    expect(themeStylesheet({ ...HC_THEME_DEFAULTS, accent: '#2B5FB3' })).toBe(css);
  });

  it('blocks an accent below 3:1 on the surface', () => {
    expect(themeContrastError({ ...HC_THEME_DEFAULTS, accent: '#FFFF00', mode: 'light' })).toBe(
      true,
    );
    expect(themeContrastError(HC_THEME_DEFAULTS)).toBe(false);
  });
});

describe('imageSourcesOf', () => {
  it('names the bucket as a path or as a subdomain of the endpoint', () => {
    expect(
      imageSourcesOf({
        S3_ENDPOINT: 'http://minio:9000',
        S3_BUCKET: 'hd',
        S3_FORCE_PATH_STYLE: true,
      }),
    ).toEqual(['http://minio:9000']);
    expect(
      imageSourcesOf({
        S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
        S3_BUCKET: 'hd',
        S3_FORCE_PATH_STYLE: false,
      }),
    ).toEqual(['https://hd.s3.eu-west-1.amazonaws.com']);
  });
});
