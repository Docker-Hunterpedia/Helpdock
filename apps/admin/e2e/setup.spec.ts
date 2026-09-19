import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  ADMIN_EMAIL,
  BRAND_NAME,
  BRAND_PREFIX,
  completeAccountStep,
  completeBrandStep,
  fillSmtp,
  freshInstall,
  SMTP_HOST,
  SMTP_RESPONSE,
} from './setup-install.js';
import { strings } from './strings.js';

/**
 * The first-run wizard, in both languages, against the four endpoints answered
 * at the network edge (`setup-install.ts`). The api's own half is proved in
 * `apps/api/src/install/setup.integration.test.ts`; what these add is the four
 * screens, the RTL flip, and the one failure an operator is most likely to hit.
 */

test.describe('the first-run wizard', () => {
  test('creates an admin, a brand and outgoing email, then opens Helpdock', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await freshInstall(page);

    // A fresh install has one screen: everything else redirects to it.
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: t('wizard:title'), level: 1 })).toBeVisible();
    await expect(page.getByText(t('wizard:systemStatus', { version: '0.1.0' }))).toBeVisible();

    await completeAccountStep(page, locale);
    await expect(page.getByText(t('wizard:stepsRemaining', { count: 2 }))).toBeVisible();

    // The prefix is the one thing on this screen that cannot be changed, so it
    // is previewed as it is typed.
    await page.getByLabel(t('wizard:brand.prefixLabel')).fill('acme');
    await expect(
      page.getByText(t('wizard:brand.prefixHint', { example: 'ACME-1042' })),
    ).toBeVisible();

    await page.getByLabel(t('wizard:brand.nameLabel')).fill(BRAND_NAME);
    await page.getByRole('button', { name: t('wizard:brand.submit') }).click();

    await expect(page.getByRole('heading', { name: t('wizard:email.title') })).toBeVisible();
    await fillSmtp(page, locale);
    await page.getByRole('button', { name: t('wizard:email.test') }).click();

    await expect(page.getByRole('alert')).toHaveText(
      t('wizard:email.testDeliveredWithResponse', {
        email: ADMIN_EMAIL,
        response: SMTP_RESPONSE,
      }),
    );

    await page.getByRole('button', { name: t('wizard:email.submit') }).click();

    await expect(page.getByRole('heading', { name: t('wizard:done.title') })).toBeVisible();
    await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
    await expect(
      page.getByText(t('wizard:done.brandValue', { name: BRAND_NAME, prefix: BRAND_PREFIX })),
    ).toBeVisible();
    await expect(page.getByText(SMTP_HOST)).toBeVisible();
    await expect(page.getByRole('button', { name: t('wizard:done.submit') })).toBeEnabled();
  });

  test('records a skipped email step and says so in the summary', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await freshInstall(page);

    await page.goto('/setup');
    await completeAccountStep(page, locale);
    await completeBrandStep(page, locale);
    await page.getByRole('button', { name: t('wizard:email.skip') }).click();

    await expect(page.getByRole('heading', { name: t('wizard:done.title') })).toBeVisible();
    await expect(page.getByText(t('wizard:done.emailSkipped'))).toBeVisible();
  });

  test('shows one sentence when the relay refuses the credentials', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await freshInstall(page, { testResult: { delivered: false, error: 'auth-failed' } });

    await page.goto('/setup');
    await completeAccountStep(page, locale);
    await completeBrandStep(page, locale);
    await fillSmtp(page, locale);
    await page.getByRole('button', { name: t('wizard:email.test') }).click();

    await expect(page.getByRole('alert')).toHaveText(t('wizard:email.errors.auth-failed'));
    // A failed test does not block the step: an operator may know better.
    await expect(page.getByRole('button', { name: t('wizard:email.submit') })).toBeEnabled();
  });

  test('says two-factor enrolment is next when the install requires one', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await freshInstall(page, { require2fa: true });

    await page.goto('/setup');
    await completeAccountStep(page, locale);
    await completeBrandStep(page, locale);
    await page.getByRole('button', { name: t('wizard:email.skip') }).click();

    await expect(page.getByText(t('wizard:done.twoFactor'))).toBeVisible();
  });

  test('goes back to the brand step without redoing the account', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await freshInstall(page);

    await page.goto('/setup');
    await completeAccountStep(page, locale);
    await completeBrandStep(page, locale);
    await page.getByRole('button', { name: t('wizard:back') }).click();

    await expect(page.getByRole('heading', { name: t('wizard:brand.title') })).toBeVisible();
    await expect(page.getByRole('heading', { name: t('wizard:account.title') })).toHaveCount(0);
  });

  test('sends every other path to the wizard, because nobody can sign in yet', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await freshInstall(page);

    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: t('wizard:title'), level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/setup$/);
  });
});

test.describe('the language picker on step 1', () => {
  /**
   * The picker changes the app as it is chosen, not on submit: an operator who
   * picks Arabic reads the next three steps in Arabic, right to left. Each
   * project starts in its own language and switches to the other one, so both
   * directions of the flip are covered by the two runs.
   */
  test('turns the whole wizard around as soon as the other language is chosen', async ({
    page,
    appLocale: locale,
  }) => {
    const other = locale === 'en' ? 'ar' : 'en';
    const t = strings(locale);
    const inOther = strings(other);
    await freshInstall(page);

    await page.goto('/setup');
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

    await page.getByLabel(t('wizard:account.languageLabel')).selectOption(other);

    await expect(page.locator('html')).toHaveAttribute('dir', other === 'ar' ? 'rtl' : 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', other);
    await expect(
      page.getByRole('heading', { name: inOther('wizard:title'), level: 1 }),
    ).toBeVisible();

    // And back again, so neither direction is a one-way trip.
    await page.getByLabel(inOther('wizard:account.languageLabel')).selectOption(locale);

    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('heading', { name: t('wizard:title'), level: 1 })).toBeVisible();
  });
});

/** DESIGN §10, checked against WCAG 2.1 A and AA on every step, in both languages. */
async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.flatMap((violation) =>
    violation.nodes.map(
      (node) => `${violation.id}: ${node.target.join(' ')} — ${node.failureSummary ?? ''}`,
    ),
  );
}

test.describe('accessibility', () => {
  test.use({ reducedMotion: 'reduce' });

  test('every step of the wizard has no violations', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await freshInstall(page);

    await page.goto('/setup');
    expect(await violations(page), 'account step').toEqual([]);

    // With every field refused, so the error text is on screen too.
    await page.getByRole('button', { name: t('wizard:account.submit') }).click();
    await page.getByText(t('wizard:account.emailRequired')).waitFor();
    expect(await violations(page), 'account step with errors').toEqual([]);

    await completeAccountStep(page, locale);
    expect(await violations(page), 'brand step').toEqual([]);

    await completeBrandStep(page, locale);
    expect(await violations(page), 'email step').toEqual([]);

    await page.getByRole('button', { name: t('wizard:email.skip') }).click();
    await page.getByRole('heading', { name: t('wizard:done.title') }).waitFor();
    expect(await violations(page), 'done step').toEqual([]);
  });

  test('the SMTP failure banner has no violations either', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await freshInstall(page, { testResult: { delivered: false, error: 'timeout' } });

    await page.goto('/setup');
    await completeAccountStep(page, locale);
    await completeBrandStep(page, locale);
    await fillSmtp(page, locale);
    await page.getByRole('button', { name: t('wizard:email.test') }).click();
    await page.getByRole('alert').waitFor();

    expect(await violations(page)).toEqual([]);
  });
});
