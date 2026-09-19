import { expect, test } from '@playwright/test';
import { generate } from 'otplib';
import { strings } from '../strings.js';
import { ACCOUNT_EMAIL_ENV, ACCOUNT_PASSWORD_ENV, SKIP_ENV, TOTP_SECRET_ENV } from './install.js';

/**
 * The exit criterion of M0: sign in, answer the second factor, land in the
 * shell, sign out — against the real api, the real database and the real
 * Redis, with no fixture anywhere in the path.
 *
 * The mock suite covers the screens in both languages. What this adds is
 * everything under them: argon2, the challenge in Redis, the signed access
 * token, the `httpOnly` refresh cookie, and the session read through row-level
 * security.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

const t = strings('en');

const account = () => ({
  email: process.env[ACCOUNT_EMAIL_ENV] ?? '',
  password: process.env[ACCOUNT_PASSWORD_ENV] ?? '',
  totpSecret: process.env[TOTP_SECRET_ENV] ?? '',
});

test.describe('against the real api', () => {
  test('signs in through the second factor and out again', async ({ page }) => {
    const { email, password, totpSecret } = account();

    await page.goto('/sign-in');
    await page.getByLabel(t('auth:signIn.emailLabel')).fill(email);
    await page.getByLabel(t('auth:signIn.passwordLabel')).fill(password);
    await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();

    await expect(page.getByRole('heading', { name: t('auth:totp.title') })).toBeVisible();
    await expect(page.getByText(t('auth:totp.subtitle', { email }))).toBeVisible();

    await page.getByLabel(t('auth:totp.codeLabel')).fill(await generate({ secret: totpSecret }));
    await page.getByRole('button', { name: t('auth:totp.submit') }).click();

    await expect(
      page.getByRole('heading', { name: t('admin:nav.tickets'), level: 1 }),
    ).toBeVisible();

    // The refresh token is a cookie the page cannot read, and the access token
    // is not in storage at all.
    const cookies = await page.context().cookies();
    const refresh = cookies.find((cookie) => cookie.name === 'hd_refresh');
    expect(refresh?.httpOnly).toBe(true);
    expect(refresh?.path).toBe('/api/auth');
    expect(await page.evaluate(() => JSON.stringify(window.localStorage))).not.toContain('eyJ');

    await page
      .getByRole('button', { name: t('admin:currentUser.menuLabel', { name: 'Dev Admin' }) })
      .click();
    await page.getByRole('menuitem', { name: t('admin:currentUser.signOut') }).click();

    await expect(
      page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }),
    ).toBeVisible();
    // The session is really gone: a reload does not walk back in.
    await page.goto('/tickets');
    await expect(
      page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }),
    ).toBeVisible();
  });

  test('refuses a wrong password and says so without naming the account', async ({ page }) => {
    const { email } = account();

    await page.goto('/sign-in');
    await page.getByLabel(t('auth:signIn.emailLabel')).fill(email);
    await page.getByLabel(t('auth:signIn.passwordLabel')).fill('not the password');
    await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();

    await expect(page.getByRole('alert')).toHaveText(t('auth:signIn.invalidCredentials'));
  });

  test('hides the provider buttons this install has not configured', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }).waitFor();

    await expect(page.getByRole('link', { name: t('auth:signIn.google') })).toHaveCount(0);
    await expect(page.getByRole('link', { name: t('auth:signIn.github') })).toHaveCount(0);
  });
});
