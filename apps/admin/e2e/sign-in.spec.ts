import { MOCK_EMAIL } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { fillSignIn, submitPassword, submitTotp } from './flows.js';
import { strings } from './strings.js';

test.describe('signing in', () => {
  test('a correct password leads to the code screen and then the shell', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await submitPassword(page, locale);

    await expect(page.getByRole('heading', { name: t('auth:totp.title') })).toBeVisible();
    await expect(page.getByText(t('auth:totp.subtitle', { email: MOCK_EMAIL }))).toBeVisible();

    await submitTotp(page, locale);

    await expect(
      page.getByRole('heading', { name: t('tickets:views.myOpen'), level: 1 }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/tickets$/);
  });

  test('a wrong password is announced and keeps the visitor on the form', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await submitPassword(page, locale, 'wrong horse');

    await expect(page.getByRole('alert')).toHaveText(t('auth:signIn.invalidCredentials'));
    await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toHaveValue(MOCK_EMAIL);
  });

  test('a provider account that is not connected yet says how to connect it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    const provider = t('auth:signIn.github');

    await page.goto('/oauth/callback?error=oauth-link-required&provider=github');

    await expect(
      page.getByRole('heading', {
        level: 1,
        name: t('auth:oauth.refusals.oauth-link-required.title', { provider }),
      }),
    ).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveText([
      t('auth:oauth.refusals.oauth-link-required.steps.signIn'),
      t('auth:oauth.refusals.oauth-link-required.steps.open'),
      t('auth:oauth.refusals.oauth-link-required.steps.connect', { provider }),
    ]);
    await page.getByRole('link', { name: t('auth:backToSignIn') }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('offers the three providers in one row, Google then Microsoft then GitHub', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto('/sign-in');

    const links = page.getByRole('link', {
      name: new RegExp(
        `^(${t('auth:signIn.google')}|${t('auth:signIn.microsoft')}|${t('auth:signIn.github')})$`,
      ),
    });

    await expect(links).toHaveText([
      t('auth:signIn.google'),
      t('auth:signIn.microsoft'),
      t('auth:signIn.github'),
    ]);
    await expect(links.nth(1)).toHaveAttribute('href', /provider=microsoft/);
  });

  test('a Microsoft account from another tenant is turned away', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const provider = t('auth:signIn.microsoft');

    await page.goto('/oauth/callback?error=oauth-tenant-mismatch&provider=microsoft');

    await expect(
      page.getByRole('heading', {
        level: 1,
        name: t('auth:oauth.refusals.oauth-tenant-mismatch.title', { provider }),
      }),
    ).toBeVisible();
    await expect(
      page.getByText(t('auth:oauth.refusals.oauth-tenant-mismatch.body', { provider })),
    ).toBeVisible();
    await page.getByRole('link', { name: t('auth:backToSignIn') }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('a Google account outside the allowed domains is turned away', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const provider = t('auth:signIn.google');

    await page.goto('/oauth/callback?error=oauth-domain-not-allowed&provider=google');

    await expect(
      page.getByRole('heading', {
        level: 1,
        name: t('auth:oauth.refusals.oauth-domain-not-allowed.title', { provider }),
      }),
    ).toBeVisible();
    await expect(
      page.getByText(t('auth:oauth.refusals.oauth-domain-not-allowed.body', { provider })),
    ).toBeVisible();
  });

  test('the sign-in link confirms where it was sent and can be sent again', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await page.goto('/sign-in');
    await page.getByLabel(t('auth:signIn.emailLabel')).fill(MOCK_EMAIL);
    await page.getByRole('button', { name: t('auth:signIn.magicLink') }).click();

    await expect(page.getByRole('heading', { name: t('auth:magicLink.title') })).toBeVisible();
    await expect(page.getByText(t('auth:magicLink.subtitle', { email: MOCK_EMAIL }))).toBeVisible();

    await page.getByRole('button', { name: t('auth:magicLink.resend') }).click();

    await expect(page.getByRole('alert')).toHaveText(t('auth:magicLink.resent'));
  });

  test('the email and password fields stay left-to-right in both languages', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await page.goto('/sign-in');

    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toHaveAttribute('dir', 'ltr');
    await expect(page.getByLabel(t('auth:signIn.passwordLabel'))).toHaveAttribute('dir', 'ltr');
  });

  test('a protected screen asks for a sign-in and then opens', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await page.goto('/settings/install/authentication');

    await expect(page).toHaveURL(/returnTo=%2Fsettings%2Finstall%2Fauthentication/);
    await expect(
      page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }),
    ).toBeVisible();

    await fillSignIn(page, locale);
    await submitTotp(page, locale);

    await expect(page).toHaveURL(/\/settings\/install\/authentication$/);
  });
});
