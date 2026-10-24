import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  MOCK_CURRENT_PASSWORD,
  MOCK_ENROLMENT_CODE,
  MOCK_STALE_ROTATION_CODE,
} from '../src/staff/mock-api.js';
import { expect, test } from './fixtures.js';
import { openSecurity, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `/me/security` in a browser, in both languages. Every action here weakens or
 * replaces a credential, so each test is really "does it ask for one first".
 */

const axeViolations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
};

// A dialog still fading in is blended with the scrim, which axe reads as low contrast.
test.use({ reducedMotion: 'reduce' });

test.describe('the security page', () => {
  test('is reached from the account menu', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);

    await openSecurity(page, locale);

    await expect(
      page.getByRole('heading', { name: t('me:account.title'), level: 1 }),
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

  test('replaces the authenticator app: proof, then a code from the new app (#373)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByRole('button', { name: t('me:twoFactor.replace') }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(t('me:passkeys.stepUpTitle'))).toBeVisible();
    await expect(axeViolations(page)).resolves.toEqual([]);

    await dialog.getByLabel(t('me:twoFactor.replaceProofLabel')).fill(MOCK_ENROLMENT_CODE);
    await dialog.getByRole('button', { name: t('me:passkeys.continue') }).click();

    await expect(dialog.getByText(t('me:twoFactor.scanTitle'))).toBeVisible();
    // The key reads left to right in both languages.
    await expect(dialog.getByText(t('me:twoFactor.keyLabel'))).toBeVisible();
    await expect(dialog.getByText('JBSW Y3DP EHPK 3PXP')).toHaveAttribute('dir', 'ltr');
    await expect(axeViolations(page)).resolves.toEqual([]);

    // The fixture answers its one code for the new app, as the real api takes
    // a live code from whichever app was scanned.
    await dialog.getByLabel(t('me:twoFactor.newCodeLabel')).fill(MOCK_ENROLMENT_CODE);
    await dialog.getByRole('button', { name: t('me:twoFactor.replace') }).click();

    await expect(page.getByText(t('me:twoFactor.replaced'))).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('says start again when the replacement went stale (#373)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByRole('button', { name: t('me:twoFactor.replace') }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('me:twoFactor.replaceProofLabel')).fill(MOCK_ENROLMENT_CODE);
    await dialog.getByRole('button', { name: t('me:passkeys.continue') }).click();
    await dialog.getByLabel(t('me:twoFactor.newCodeLabel')).fill(MOCK_STALE_ROTATION_CODE);
    await dialog.getByRole('button', { name: t('me:twoFactor.replace') }).click();

    const banner = page.getByRole('status').filter({ hasText: t('me:twoFactor.replaceStale') });
    await expect(banner).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(axeViolations(page)).resolves.toEqual([]);
  });

  test('says so in the field when the proof to replace the app is wrong (#373)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByRole('button', { name: t('me:twoFactor.replace') }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('me:twoFactor.replaceProofLabel')).fill('000000');
    await dialog.getByRole('button', { name: t('me:passkeys.continue') }).click();

    await expect(dialog.getByText(t('me:passkeys.proofWrong'))).toBeVisible();
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

  test('keeps each session action on one line beside a long browser name', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);

    const list = page.getByRole('list', { name: t('me:sessions.listLabel') });
    const current = list.getByRole('listitem').first();
    const button = current.getByRole('button');
    const details = current.locator('div').first();

    await expect(button).toHaveCSS('white-space', 'nowrap');
    const detailsBox = await details.boundingBox();
    const buttonBox = await button.boundingBox();
    if (detailsBox === null || buttonBox === null) {
      throw new Error('The session details and action must have browser layout boxes');
    }

    if (locale === 'ar') {
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(detailsBox.x);
    } else {
      expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(buttonBox.x);
    }
  });

  test('connects a sign-in provider after confirming it is you, then disconnects it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const provider = t('auth:signIn.github');
    await signIn(page, locale);
    await openSecurity(page, locale);
    const card = page.getByRole('region', { name: t('me:signInProviders.title') });

    await expect(card.getByText(t('me:signInProviders.notice'))).toBeVisible();
    await card.getByRole('button', { name: t('me:signInProviders.connect', { provider }) }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('me:signInProviders.proofLabel')).fill(MOCK_ENROLMENT_CODE);
    await dialog.getByRole('button', { name: t('me:signInProviders.continue') }).click();

    await expect(
      page.getByText(t('me:signInProviders.connectedToast', { provider })),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/me\/security$/);
    await expect(card.getByText(t('me:signInProviders.notice'))).toBeHidden();

    await card
      .getByRole('button', { name: t('me:signInProviders.disconnect', { provider }) })
      .click();
    await dialog.getByLabel(t('me:signInProviders.proofLabel')).fill(MOCK_CURRENT_PASSWORD);
    await dialog.getByRole('button', { name: t('me:signInProviders.continue') }).click();

    await expect(
      page.getByText(t('me:signInProviders.disconnectedToast', { provider })),
    ).toBeVisible();
    await expect(
      card.getByRole('button', { name: t('me:signInProviders.connect', { provider }) }),
    ).toBeVisible();
  });

  test('refuses to connect a provider with the wrong password', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const provider = t('auth:signIn.google');
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByRole('button', { name: t('me:signInProviders.connect', { provider }) }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('me:signInProviders.proofLabel')).fill('not the password');
    await dialog.getByRole('button', { name: t('me:signInProviders.continue') }).click();

    await expect(dialog.getByText(t('me:signInProviders.proofWrong'))).toBeVisible();
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
