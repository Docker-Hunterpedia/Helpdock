import { MOCK_EMAIL, MOCK_MAGIC_LINK_TOKEN } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { submitTotp } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/SignIn-MagicLink` and `-AR` (M9-01 F6): a sign-in link opens a
 * confirm screen, and only the click on it spends the link.
 */
test.describe('the sign-in link confirm screen', () => {
  test('a live link names the account, and Continue leads through the code into the app', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await page.goto(`/sign-in/magic#token=${MOCK_MAGIC_LINK_TOKEN}`);

    await expect(
      page.getByRole('heading', { name: t('auth:magicLinkConfirm.title'), level: 1 }),
    ).toBeVisible();
    await expect(page.locator('bdi', { hasText: MOCK_EMAIL })).toBeVisible();
    await expect(page.getByText(t('auth:magicLinkConfirm.note', { count: 10 }))).toBeVisible();
    await expect(
      page.getByRole('link', { name: t('auth:magicLinkConfirm.notYou') }),
    ).toHaveAttribute('href', '/sign-in');

    await page.getByRole('button', { name: t('auth:magicLinkConfirm.continue') }).click();
    await expect(page.getByRole('heading', { name: t('auth:totp.title') })).toBeVisible();

    await submitTotp(page, locale);
    await expect(
      page.getByRole('heading', { name: t('tickets:views.myOpen'), level: 1 }),
    ).toBeVisible();
  });

  test('an expired or used link says so and offers the way back', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await page.goto('/sign-in/magic#token=used-already');

    await expect(page.getByRole('alert')).toHaveText(t('auth:magicLinkConfirm.invalid'));
    await expect(
      page.getByRole('button', { name: t('auth:magicLinkConfirm.continue') }),
    ).toHaveCount(0);

    await page.getByRole('link', { name: t('auth:backToSignIn') }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
