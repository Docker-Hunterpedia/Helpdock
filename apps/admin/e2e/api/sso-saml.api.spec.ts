import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { LOCALE_STORAGE_KEY } from '../../src/app/preferences.js';
import { strings } from '../strings.js';
import { ACCOUNT_EMAIL_ENV, SAML_CONNECTION_ENV, SKIP_ENV, TOTP_SECRET_ENV } from './install.js';
import { freshTotpCode } from './totp.js';

test.skip(Boolean(process.env[SKIP_ENV]), 'Docker is required for the real-api SAML flow.');
for (const locale of ['en', 'ar'] as const) {
  const t = strings(locale);
  test(`SAML proves identity and preserves local TOTP (${locale})`, async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key ?? '', value ?? ''),
      [LOCALE_STORAGE_KEY, locale],
    );
    await page.goto(`/api/auth/sso/${process.env[SAML_CONNECTION_ENV]}/start`);
    await expect(page.getByRole('heading', { name: t('auth:totp.title') })).toBeVisible();
    await expect(
      page.getByText(t('auth:totp.subtitle', { email: process.env[ACCOUNT_EMAIL_ENV] })),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page
      .getByLabel(t('auth:totp.codeLabel'))
      .fill(await freshTotpCode(process.env[TOTP_SECRET_ENV] ?? ''));
    await page.getByRole('button', { name: t('auth:totp.submit') }).click();
    await expect(
      page.getByRole('heading', { name: t('tickets:views.myOpen'), level: 1 }),
    ).toBeVisible();
    expect(
      (await page.context().cookies()).some(
        (cookie) => cookie.name === 'hd_refresh' && cookie.httpOnly,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => JSON.stringify(window.localStorage))).not.toContain('eyJ');
  });

  test(`SAML rejects a callback without its browser nonce (${locale})`, async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key ?? '', value ?? ''),
      [LOCALE_STORAGE_KEY, locale],
    );
    const start = await page.request.get(
      `/api/auth/sso/${process.env[SAML_CONNECTION_ENV]}/start`,
      {
        maxRedirects: 0,
      },
    );
    expect(start.status()).toBe(302);
    await page.context().clearCookies();
    await page.goto(start.headers().location ?? '');
    await expect(page.getByRole('alert')).toHaveText(t('auth:completing.failed'));
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'hd_refresh')).toBe(
      false,
    );
  });
}
