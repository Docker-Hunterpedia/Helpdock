import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * Brand › Domains (M5-07, `AdminBrandDomains`) in a real browser, in both
 * languages: the three states, adding a domain and reading its records, the
 * refusal under the field, "Check now", the Cloudflare flag, removing a domain,
 * and the General tab it sits beside. Host names stay left-to-right inside the
 * Arabic layout (DESIGN §7).
 */

test.use({ reducedMotion: 'reduce' });

/** Through the sidebar: the fixture keeps its session in memory, so a reload signs out. */
const openDomains = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: t('admin:nav.brand'), exact: true }).click();
  await page.getByRole('tab', { name: t('brand:tabs.domains') }).click();
  await page.getByRole('heading', { name: t('brand:domains.heading') }).waitFor();
};

const itemFor = (page: Page, locale: Locale, domain: string) =>
  page
    .getByRole('list', { name: strings(locale)('brand:domains.listLabel') })
    .getByRole('listitem')
    .filter({ hasText: domain });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
};

test.describe('custom domains', () => {
  test('shows each domain’s state, and the records a pending one still needs', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openDomains(page, locale);

    await expect(page.getByRole('tab', { name: t('brand:tabs.domains') })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      itemFor(page, locale, 'help.helpdock.com').getByText(t('brand:domains.primary')),
    ).toBeVisible();

    const records = itemFor(page, locale, 'support.helpdock.com').getByRole('table', {
      name: t('brand:domains.records.tableLabel', { domain: 'support.helpdock.com' }),
    });
    await expect(records.getByText('_helpdock.support.helpdock.com')).toBeVisible();
    await expect(records.getByText(t('brand:domains.records.notYet'))).toBeVisible();
    await expect(itemFor(page, locale, 'help.helpdock.sa').getByRole('alert')).toContainText(
      '104.21.48.12',
    );
  });

  test('adds a domain and shows the records to create', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openDomains(page, locale);

    await page.getByLabel(t('brand:domains.add.label')).fill('docs.acme.com');
    await page.getByRole('button', { name: t('brand:domains.add.action') }).click();

    await expect(
      page.getByText(t('brand:domains.toast.added', { domain: 'docs.acme.com' })),
    ).toBeVisible();
    await expect(
      page.getByRole('table', {
        name: t('brand:domains.records.tableLabel', { domain: 'docs.acme.com' }),
      }),
    ).toBeVisible();

    await itemFor(page, locale, 'docs.acme.com')
      .getByRole('button', { name: new RegExp(t('brand:domains.checkNow')) })
      .click();
    await expect(
      page.getByText(t('brand:domains.toast.checking', { domain: 'docs.acme.com' })),
    ).toBeVisible();
  });

  test('refuses a name that can never be public, and says why', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openDomains(page, locale);

    const field = page.getByLabel(t('brand:domains.add.label'));
    await field.fill('printer.local');
    await page.getByRole('button', { name: t('brand:domains.add.action') }).click();

    await expect(page.getByText(t('brand:domains.refusals.domain-not-public'))).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  test('flags a domain as proxied by Cloudflare, then removes one', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openDomains(page, locale);

    await itemFor(page, locale, 'help.helpdock.sa')
      .getByRole('checkbox', { name: t('brand:domains.cloudflare.label') })
      .click();
    await expect(
      itemFor(page, locale, 'help.helpdock.sa').getByText(t('brand:domains.state.cloudflare')),
    ).toBeVisible();

    await page
      .getByRole('button', {
        name: t('brand:domains.actionsFor', { domain: 'support.helpdock.com' }),
      })
      .click();
    await page.getByRole('menuitem', { name: t('brand:domains.remove') }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: t('brand:domains.removeConfirm.action') }).click();

    await expect(itemFor(page, locale, 'support.helpdock.com')).toHaveCount(0);
  });

  test('keeps host names left to right in either language', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openDomains(page, locale);

    await expect(page.getByLabel(t('brand:domains.add.label'))).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  });

  test('has no accessibility violations, with or without a refusal showing', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openDomains(page, locale);
    expect(await violations(page)).toEqual([]);

    await page.getByLabel(t('brand:domains.add.label')).fill('https://nope');
    await page.getByRole('button', { name: t('brand:domains.add.action') }).click();
    await page.getByText(t('brand:domains.refusals.domain-invalid')).waitFor();

    expect(await violations(page)).toEqual([]);
  });
});

test.describe('brand identity', () => {
  test('saves the brand’s name from the General tab', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await page.getByRole('link', { name: t('admin:nav.brand'), exact: true }).click();
    await page.getByRole('heading', { name: t('brand:general.heading') }).waitFor();

    await page.getByLabel(t('brand:general.name')).fill('Acme Support');
    await page.getByRole('button', { name: t('brand:general.save') }).click();

    await expect(page.getByText(t('brand:general.saved'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('refuses an empty name', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await page.getByRole('link', { name: t('admin:nav.brand'), exact: true }).click();

    await page.getByLabel(t('brand:general.name')).fill('');

    await expect(page.getByText(t('brand:general.nameRequired'))).toBeVisible();
    await expect(page.getByRole('button', { name: t('brand:general.save') })).toBeDisabled();
  });
});
