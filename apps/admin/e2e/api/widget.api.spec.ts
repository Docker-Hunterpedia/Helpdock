import { expect, type Page, test } from '@playwright/test';
import { generate } from 'otplib';
import { strings } from '../strings.js';
import {
  ACCOUNT_EMAIL_ENV,
  ACCOUNT_PASSWORD_ENV,
  E2E_API_ORIGIN,
  E2E_WEB_ORIGIN,
  SKIP_ENV,
  TOTP_SECRET_ENV,
} from './install.js';

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

const signInAsAdmin = async (page: Page): Promise<void> => {
  await page.goto('/sign-in');
  await page.getByLabel(t('auth:signIn.emailLabel')).fill(process.env[ACCOUNT_EMAIL_ENV] ?? '');
  await page
    .getByLabel(t('auth:signIn.passwordLabel'))
    .fill(process.env[ACCOUNT_PASSWORD_ENV] ?? '');
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
  await page
    .getByLabel(t('auth:totp.codeLabel'))
    .fill(await generate({ secret: process.env[TOTP_SECRET_ENV] ?? '' }));
  await page.getByRole('button', { name: t('auth:totp.submit') }).click();
  await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
};

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
    page,
  }) => {
    await signInAsAdmin(page);
    await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
    await page.getByRole('tab', { name: t('channels:tabs.widget') }).click();
    const snippet = await page
      .getByRole('region', { name: t('channels:widget.embed.heading') })
      .locator('pre')
      .textContent();
    const brandId = /brand="([^"]+)"/.exec(snippet ?? '')?.[1] ?? '';
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
