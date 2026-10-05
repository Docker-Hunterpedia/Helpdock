import { createI18n } from '@helpdock/i18n';
import { describe, expect, it } from 'vitest';
import type { useT } from '../../../../app/i18n.js';
import { createRequestOf, EMPTY_DRAFT, fileProblem } from './add-source-draft.js';
import { logLineText, whereOf } from './log-format.js';
import { sizeOf } from './source-format.js';

const i18n = createI18n({ lng: 'en' });
const t = i18n.getFixedT('en') as unknown as ReturnType<typeof useT>;
const ar = createI18n({ lng: 'ar' }).getFixedT('ar') as unknown as ReturnType<typeof useT>;

describe('logLineText', () => {
  it('turns each code into a sentence with its params', () => {
    expect(logLineText(t, { code: 'sitemap.read', params: { found: 538, kept: 520 } })).toBe(
      'Sitemap read · 538 URLs, 520 after patterns',
    );
    expect(
      logLineText(t, {
        code: 'page.indexed',
        params: { url: 'https://docs.example.com/docs/billing/refunds', chunks: 4 },
      }),
    ).toBe('/docs/billing/refunds · 4 chunks');
    expect(logLineText(t, { code: 'sync.started', params: { trigger: 'manual' } })).toBe(
      'Sync started by hand (Sync now)',
    );
  });

  it('says why a page was skipped, one at a time or counted', () => {
    expect(
      logLineText(t, {
        code: 'page.skipped',
        params: { url: 'https://x.test/docs/legacy', reason: 'status', detail: '404' },
      }),
    ).toBe('/docs/legacy skipped: the page returned 404');
    expect(
      logLineText(t, { code: 'page.skipped', params: { reason: 'excluded', count: 18 } }),
    ).toBe('Skipped 18 pages: matching an exclude pattern');
  });

  it('reads in Arabic too, and survives a line missing its params', () => {
    expect(logLineText(ar, { code: 'robots.read', params: { rules: 2 } })).toContain('robots.txt');
    expect(logLineText(t, { code: 'sync.failed', params: {} })).toBe('Sync failed: ');
  });
});

describe('whereOf', () => {
  it('prefers a URL’s path, then a title, then a name', () => {
    expect(whereOf({ url: 'https://a.test/x/y', title: 'T' })).toBe('/x/y');
    expect(whereOf({ title: 'Refunds' })).toBe('Refunds');
    expect(whereOf({ name: 'Policies.pdf' })).toBe('Policies.pdf');
  });
});

describe('the add-source draft', () => {
  it('refuses a crawl without a web address or with too many pages', () => {
    expect(createRequestOf({ ...EMPTY_DRAFT, url: 'ftp://x', maxPages: '9000' })).toEqual({
      ok: false,
      problems: [
        { field: 'url', key: 'urlInvalid' },
        { field: 'maxPages', key: 'maxPagesInvalid' },
      ],
    });
  });

  it('builds a crawl with one pattern per line', () => {
    const outcome = createRequestOf({
      ...EMPTY_DRAFT,
      url: 'https://docs.example.com/sitemap.xml',
      include: '/docs/*\n\n /guides/* ',
    });

    expect(outcome).toMatchObject({
      ok: true,
      request: { kind: 'crawl', config: { include: ['/docs/*', '/guides/*'], maxPages: 600 } },
    });
  });

  it('sends a Notion token only when one was typed, and names a connector', () => {
    expect(createRequestOf({ ...EMPTY_DRAFT, kind: 'gdrive' })).toMatchObject({ ok: false });
    expect(createRequestOf({ ...EMPTY_DRAFT, kind: 'notion', name: 'Playbook' })).toEqual({
      ok: true,
      request: { kind: 'notion', name: 'Playbook', visibility: 'internal', schedule: 'daily' },
    });
  });

  it('refuses no file, an unread type and a file over 25 MB', () => {
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });

    expect(fileProblem([])).toEqual({ field: 'files', key: 'filesRequired' });
    expect(fileProblem([new File(['x'], 'a.png', { type: 'image/png' })])).toMatchObject({
      key: 'fileType',
    });
    expect(fileProblem([big])).toMatchObject({ key: 'fileTooBig', name: 'big.pdf' });
    expect(fileProblem([pdf])).toBeNull();
  });
});

describe('sizeOf', () => {
  it('says megabytes from a million bytes, kilobytes below', () => {
    expect(sizeOf(2_400_000)).toBe('2.4 MB');
    expect(sizeOf(180_000)).toBe('180 KB');
  });
});
