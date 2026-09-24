import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Brand · Danger zone` and its Data retention card (M1-14), in a real
 * browser, in both languages: a select that opens where it can be clicked, a
 * number field typed into for real, and an Arabic layout that is a different
 * layout rather than the same one mirrored by hand (DESIGN §7).
 */

test.use({ reducedMotion: 'reduce' });

type Locale = 'en' | 'ar';

/** Through the sidebar: the fixture keeps its session in memory, so a reload signs out. */
const openBrand = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: t('admin:nav.brand'), exact: true }).click();
  await page.getByRole('heading', { name: t('brand:retention.heading') }).waitFor();
};

const rowFor = (page: Page, label: string) =>
  page.getByRole('row').filter({ has: page.getByText(label, { exact: true }) });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
};

test.describe('data retention', () => {
  test('shows each window and what the next run would purge', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openBrand(page, locale);

    await expect(page.getByRole('tab', { name: t('brand:tabs.danger') })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      rowFor(page, t('brand:retention.rows.spamTickets')).getByText(
        t('brand:retention.rowCount', { count: 62 }),
      ),
    ).toBeVisible();
    await expect(page.getByText(t('brand:erasure.heading'))).toBeVisible();
  });

  test('keeps closed tickets forever once "Forever" is saved', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openBrand(page, locale);

    await page.getByRole('combobox', { name: t('brand:retention.closedMode.label') }).click();
    await page.getByRole('option', { name: t('brand:retention.closedMode.never') }).click();
    await page.getByRole('button', { name: t('brand:retention.save') }).click();

    await expect(page.getByText(t('brand:retention.saved'))).toBeVisible();
    await expect(
      rowFor(page, t('brand:retention.rows.closedTickets')).getByText(
        t('brand:retention.nothingToCount'),
      ),
    ).toBeAttached();
  });

  test('refuses an audit log shorter than 90 days, and says why', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openBrand(page, locale);

    const days = page.getByRole('spinbutton', {
      name: t('brand:retention.daysLabel', { row: t('brand:retention.rows.auditLog') }),
    });
    await days.fill('30');

    await expect(
      page.getByText(t('brand:retention.errors.days', { min: 90, max: 3650 })),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: t('brand:retention.save') })).toBeDisabled();
  });

  test('has no accessibility violations, with or without an error showing', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openBrand(page, locale);
    expect(await violations(page)).toEqual([]);

    await page
      .getByRole('spinbutton', {
        name: t('brand:retention.daysLabel', { row: t('brand:retention.rows.spamTickets') }),
      })
      .fill('0');
    await page.getByRole('alert').first().waitFor();

    expect(await violations(page)).toEqual([]);
  });
});
