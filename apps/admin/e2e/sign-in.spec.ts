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
      page.getByRole('heading', { name: t('admin:nav.tickets'), level: 1 }),
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

    await page.goto('/admin/settings');

    await expect(page).toHaveURL(/returnTo=%2Fadmin%2Fsettings/);
    await expect(
      page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }),
    ).toBeVisible();

    await fillSignIn(page, locale);
    await submitTotp(page, locale);

    await expect(page).toHaveURL(/\/admin\/settings$/);
  });
});
