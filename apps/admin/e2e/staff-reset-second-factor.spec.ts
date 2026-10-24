import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  MOCK_CURRENT_PASSWORD,
  MOCK_RESET_BLOCKED_PASSWORD,
  MOCK_RESET_CHANGED_PASSWORD,
} from '../src/staff/mock-api.js';
import { expect, test } from './fixtures.js';
import { openStaff, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Staff-ResetSecondFactor` in a real browser, in both languages (#398):
 * the row-menu item, the step-up, the destructive confirm with the server's
 * counts, the refusal for the last break-glass admin, and axe on each dialog.
 */

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
};

const OMAR = 'omar@helpdock.com';

// Axe reads colours mid-fade otherwise.
test.use({ reducedMotion: 'reduce' });

test.describe('resetting a second factor', () => {
  test('resets after a step-up and a confirm that lists what goes', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);
    const row = page.getByRole('row').filter({ hasText: OMAR });
    await row
      .getByRole('button', { name: t('staff:table.rowActions', { name: 'Omar Nasser' }) })
      .click();

    await page
      .getByRole('menuitem', { name: new RegExp(t('staff:actions.resetSecondFactor')) })
      .click();
    const stepUp = page.getByRole('dialog');
    await expect(stepUp.getByText(t('staff:reset.stepUp', { name: 'Omar Nasser' }))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await stepUp.getByLabel(t('me:passkeys.proofLabel')).fill(MOCK_CURRENT_PASSWORD);
    await stepUp.getByRole('button', { name: t('me:passkeys.continue') }).click();

    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText(t('staff:reset.title', { name: 'Omar Nasser' }))).toBeVisible();
    await expect(confirm.getByText(t('staff:reset.app'))).toBeVisible();
    await expect(confirm.getByText(t('staff:reset.passkeys', { count: 2 }))).toBeVisible();
    await expect(confirm.getByText(t('staff:reset.codes', { count: 6 }))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await confirm.getByRole('button', { name: t('staff:reset.submit') }).click();

    await expect(
      page.getByText(t('staff:toast.secondFactorResetOptional', { name: 'Omar Nasser' })),
    ).toBeVisible();
    await expect(row.getByText(t('staff:twoFactor.pending'))).toBeVisible();
  });

  test('says the last break-glass admin cannot be reset, and changes nothing', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);
    const row = page.getByRole('row').filter({ hasText: OMAR });
    await row
      .getByRole('button', { name: t('staff:table.rowActions', { name: 'Omar Nasser' }) })
      .click();
    await page
      .getByRole('menuitem', { name: new RegExp(t('staff:actions.resetSecondFactor')) })
      .click();
    await page.getByLabel(t('me:passkeys.proofLabel')).fill(MOCK_RESET_BLOCKED_PASSWORD);
    await page.getByRole('button', { name: t('me:passkeys.continue') }).click();
    await page.getByRole('button', { name: t('staff:reset.submit') }).click();

    await expect(
      page.getByText(t('staff:toast.lastBreakGlass', { name: 'Omar Nasser' })),
    ).toBeVisible();
    await expect(row.getByText(t('staff:twoFactor.enrolled'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('is not offered on a person with no second factor', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);
    const row = page.getByRole('row').filter({ hasText: 'yara@helpdock.com' });
    await row
      .getByRole('button', { name: t('staff:table.rowActions', { name: 'Yara Salem' }) })
      .click();

    await expect(page.getByRole('menu')).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: new RegExp(t('staff:actions.resetSecondFactor')) }),
    ).toHaveCount(0);
  });

  test('sends a wrong proof back to step 1 and removes nothing', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);
    const row = page.getByRole('row').filter({ hasText: OMAR });
    await row
      .getByRole('button', { name: t('staff:table.rowActions', { name: 'Omar Nasser' }) })
      .click();
    await page
      .getByRole('menuitem', { name: new RegExp(t('staff:actions.resetSecondFactor')) })
      .click();
    await page.getByLabel(t('me:passkeys.proofLabel')).fill('not the password');
    await page.getByRole('button', { name: t('me:passkeys.continue') }).click();
    await page.getByRole('button', { name: t('staff:reset.submit') }).click();

    const stepUp = page.getByRole('dialog');
    await expect(stepUp.getByText(t('me:passkeys.proofWrong'))).toBeVisible();
    await expect(stepUp.getByRole('button', { name: t('me:passkeys.continue') })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await stepUp.getByRole('button', { name: t('common:actions.cancel') }).click();
    await expect(row.getByText(t('staff:twoFactor.enrolled'))).toBeVisible();
  });

  test('says the factors changed while confirming, and removes nothing', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);
    const row = page.getByRole('row').filter({ hasText: OMAR });
    await row
      .getByRole('button', { name: t('staff:table.rowActions', { name: 'Omar Nasser' }) })
      .click();
    await page
      .getByRole('menuitem', { name: new RegExp(t('staff:actions.resetSecondFactor')) })
      .click();
    await page.getByLabel(t('me:passkeys.proofLabel')).fill(MOCK_RESET_CHANGED_PASSWORD);
    await page.getByRole('button', { name: t('me:passkeys.continue') }).click();
    await page.getByRole('button', { name: t('staff:reset.submit') }).click();

    await expect(
      page.getByText(t('staff:toast.secondFactorChanged', { name: 'Omar Nasser' })),
    ).toBeVisible();
    await expect(row.getByText(t('staff:twoFactor.enrolled'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});
