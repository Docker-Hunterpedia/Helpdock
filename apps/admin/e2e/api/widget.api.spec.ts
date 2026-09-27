import type { Page } from '@playwright/test';
import { strings } from '../strings.js';
import { E2E_API_ORIGIN, E2E_WEB_ORIGIN, SKIP_ENV } from './install.js';
import { expect, openAdmin, test } from './widget-helpers.js';

/**
 * M4-03's exit criterion against the real api: "requests from a non-allowed
 * origin are rejected", from a real browser page, whose `Origin` the page
 * cannot choose. This is the api-level E2E test; the widget's own screens
 * are M4-01's, and the socket handshake's refusal is proved in
 * `apps/api/src/widget/widget.integration.test.ts`.
 *
 * The page at the admin's dev origin asks the api for the widget config and
 * a visitor session, is refused while that origin is not on the brand's
 * list, and is served once an Admin adds it on Channels › Widget.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

const t = strings('en');

/** Called from the page, so the browser sets `Origin` itself: this page's origin. */
const fromThePage = (page: Page, path: string, method: 'GET' | 'POST') =>
  page.evaluate(
    async ({ url, method: verb }) => {
      const response = await fetch(url, {
        method: verb,
        headers: { 'content-type': 'application/json' },
        ...(verb === 'POST' ? { body: '{}' } : {}),
      });
      const body = (await response.json()) as { error?: { widget?: { reason?: string } } };
      return { status: response.status, reason: body.error?.widget?.reason ?? null };
    },
    { url: `${E2E_API_ORIGIN}${path}`, method },
  );

test.describe('the widget origin allow-list against the real api', () => {
  test('refuses a page on an origin the brand has not allowed, and serves it once allowed', async ({
    admin: page,
  }) => {
    await openAdmin(page);
    await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
    await page.getByRole('tab', { name: t('channels:tabs.widget') }).click();
    const snippet = await page
      .getByRole('region', { name: t('channels:widget.embed.heading') })
      .locator('pre')
      .textContent();
    const brandId = /data-brand="([^"]+)"/.exec(snippet ?? '')?.[1] ?? '';
    expect(brandId).not.toBe('');

    for (const [path, method] of [
      [`/api/widget/${brandId}/config`, 'GET'],
      [`/api/widget/${brandId}/session`, 'POST'],
    ] as const) {
      expect(await fromThePage(page, path, method)).toEqual({
        status: 403,
        reason: 'origin_not_allowed',
      });
    }

    const access = page.getByRole('region', { name: t('channels:widget.access.heading') });
    await access
      .getByRole('textbox', { name: t('channels:widget.access.addLabel') })
      .fill(E2E_WEB_ORIGIN);
    await access.getByRole('button', { name: t('channels:widget.access.add') }).click();
    await access.getByRole('button', { name: t('channels:widget.save') }).click();
    await expect(
      page.getByRole('status').filter({ hasText: t('channels:widget.access.saved') }),
    ).toBeVisible();

    expect((await fromThePage(page, `/api/widget/${brandId}/config`, 'GET')).status).toBe(200);
    expect((await fromThePage(page, `/api/widget/${brandId}/session`, 'POST')).status).toBe(200);
  });
});
