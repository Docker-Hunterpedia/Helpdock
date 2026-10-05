import {
  MOCK_BREACHED_PASSWORD,
  MOCK_CURRENT_PASSWORD,
  MOCK_INVITE_TOKEN,
} from '../src/staff/mock-api.js';
import { expect, test } from './fixtures.js';
import { openSecurity, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/PasswordField` on every screen that chooses a password, in both
 * languages (ASVS 2.1.7, 2.1.12): the show/hide toggle, and the api's
 * breached-list refusal drawn on the field after it answers. The fixtures
 * answer `password-breached` for {@link MOCK_BREACHED_PASSWORD}; the api's own
 * list is proved in `apps/api/src/auth/auth.service.test.ts`.
 */

test.describe('choosing a password', () => {
  test('shows and hides what was typed, and hides it again on send', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto(`/invite/${MOCK_INVITE_TOKEN}`);
    const field = page.getByLabel(t('auth:invite.passwordLabel'));
    await field.fill('short');

    await expect(field).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: t('auth:passwordField.show') }).click();
    await expect(field).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: t('auth:passwordField.hide') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: t('auth:invite.submit') }).click();

    await expect(field).toHaveAttribute('type', 'password');
    await expect(page.getByRole('alert')).toHaveText(
      t('auth:invite.passwordTooShort', { count: 12 }),
    );
    await expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  test('refuses a breached password on an invitation, on the field', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto(`/invite/${MOCK_INVITE_TOKEN}`);

    await page.getByLabel(t('auth:invite.nameLabel')).fill('Karim Aziz');
    await page.getByLabel(t('auth:invite.passwordLabel')).fill(MOCK_BREACHED_PASSWORD);
    await page.getByRole('button', { name: t('auth:invite.submit') }).click();

    await expect(page.getByRole('alert')).toHaveText(t('auth:passwordField.breached'));
    await expect(page.getByText(t('auth:passwordField.breachedNote'))).toBeVisible();
    await expect(page.getByText(t('auth:unavailable'))).toHaveCount(0);
  });

  test('refuses a breached password on a reset, and keeps the link', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto('/sign-in/reset?token=mock-reset-token');
    const field = page.getByLabel(t('auth:passwordReset.passwordLabel'));

    await field.fill(MOCK_BREACHED_PASSWORD);
    await page.getByRole('button', { name: t('auth:passwordReset.submit') }).click();

    await expect(page.getByRole('alert')).toHaveText(t('auth:passwordField.breached'));
    await expect(field).toHaveAttribute('aria-invalid', 'true');

    await field.fill('a long enough password');
    await page.getByRole('button', { name: t('auth:passwordReset.submit') }).click();
    await expect(
      page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }),
    ).toBeVisible();
  });

  test('refuses a breached password on the security page', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByLabel(t('me:password.currentLabel')).fill(MOCK_CURRENT_PASSWORD);
    await page.getByLabel(t('me:password.newLabel')).fill(MOCK_BREACHED_PASSWORD);
    await page.getByRole('button', { name: t('me:password.submit') }).click();

    await expect(page.getByRole('alert')).toHaveText(t('auth:passwordField.breached'));
    await expect(page.getByLabel(t('me:password.newLabel'))).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});
