import { MOCK_CURRENT_PASSWORD, MOCK_ENROLMENT_CODE } from '../src/staff/mock-api.js';
import { expect, test } from './fixtures.js';
import { openSecurity, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `/me/security` in a browser, in both languages. Every action here weakens or
 * replaces a credential, so each test is really "does it ask for one first".
 */

test.describe('the security page', () => {
  test('is reached from the account menu', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);

    await openSecurity(page, locale);

    await expect(
      page.getByRole('heading', { name: t('me:security.title'), level: 1 }),
    ).toBeVisible();
  });

  test('leaves the sign-in address to an administrator', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await expect(page.getByLabel(t('me:details.emailLabel'))).toHaveAttribute('readonly', '');
    await expect(page.getByText(t('me:details.emailHint'))).toBeVisible();
  });

  test('changes a password and says the other browsers were ended', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByLabel(t('me:password.currentLabel')).fill(MOCK_CURRENT_PASSWORD);
    await page.getByLabel(t('me:password.newLabel')).fill('a long enough password');
    await page.getByRole('button', { name: t('me:password.submit') }).click();

    await expect(page.getByText(t('me:password.done'))).toBeVisible();
  });

  test('refuses a wrong current password', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByLabel(t('me:password.currentLabel')).fill('not the password');
    await page.getByLabel(t('me:password.newLabel')).fill('a long enough password');
    await page.getByRole('button', { name: t('me:password.submit') }).click();

    await expect(page.getByText(t('me:password.wrong'))).toBeVisible();
  });

  test('asks for a live code before turning the second factor off', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByRole('button', { name: t('me:twoFactor.disable'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(t('me:twoFactor.disableTitle'))).toBeVisible();

    await dialog.getByLabel(t('me:twoFactor.codeLabel')).fill(MOCK_ENROLMENT_CODE);
    await dialog.getByRole('button', { name: t('me:twoFactor.disableSubmit') }).click();

    await expect(page.getByText(t('me:twoFactor.disabled'))).toBeVisible();
  });

  test('lists the signed-in browsers and ends one of them', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    const list = page.getByRole('list', { name: t('me:sessions.listLabel') });
    await expect(list.getByRole('listitem')).toHaveCount(2);

    await list
      .getByRole('button', {
        name: t('me:sessions.signOutLabel', { browser: 'Mozilla/5.0 (iPhone) Safari/26' }),
      })
      .click();

    await expect(page.getByText(t('me:sessions.signedOut'))).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(1);
  });

  test('signs out everywhere, which ends this browser too', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByRole('button', { name: t('me:sessions.signOutEverywhere') }).click();

    await expect(
      page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }),
    ).toBeVisible();
  });
});
