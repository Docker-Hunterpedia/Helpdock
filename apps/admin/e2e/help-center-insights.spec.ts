import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * Help center › Insights in a real browser, in both languages (M5-08,
 * `Admin/HelpCenter-Settings` board 2): the two search tables and the Articles
 * table, the filters, an empty table, a draft written from a search nothing
 * answered, and axe over the tab.
 */

test.use({ reducedMotion: 'reduce' });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

const openInsights = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.helpCenter')) }).click();
  await page.getByRole('tab', { name: t('helpCenter:tabs.insights') }).click();
  await page.getByRole('table', { name: t('helpCenter:insights.top.heading') }).waitFor();
};

test('shows what visitors search for and how articles are rated', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openInsights(page, locale);

  const top = page.getByRole('table', { name: t('helpCenter:insights.top.heading') });
  await expect(top.getByRole('row').nth(1)).toContainText('refund');
  await expect(top.getByRole('row').nth(1)).toContainText('68 %');
  const zero = page.getByRole('table', { name: t('helpCenter:insights.zero.heading') });
  await expect(zero.getByRole('row').nth(1)).toContainText('klarna');
  const articles = page.getByRole('table', { name: t('helpCenter:insights.articles.heading') });
  await expect(articles.getByRole('row').nth(1)).toContainText('Refund timelines');
  await expect(articles.getByRole('row').nth(1)).toContainText('86 %');

  await page.getByRole('combobox', { name: t('helpCenter:insights.language') }).click();
  await page.getByRole('option', { name: t('helpCenter:insights.languages.ar') }).click();
  await expect(top.getByRole('row')).toHaveCount(2);
  await expect(top.getByText('استرداد')).toHaveAttribute('dir', 'rtl');

  expect(await violations(page)).toEqual([]);
});

test('says when a period has no search that went unanswered', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openInsights(page, locale);

  await page.getByRole('combobox', { name: t('helpCenter:insights.period') }).click();
  await page.getByRole('option', { name: t('helpCenter:insights.periods.7') }).click();

  await expect(page.getByText(t('helpCenter:insights.zero.empty'))).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('writes an article for a search nothing answered', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await openInsights(page, locale);

  await page
    .getByRole('button', { name: t('helpCenter:insights.zero.writeLabel', { query: 'klarna' }) })
    .click();

  await expect(page).toHaveURL(/\/help-center\/articles\//);
});
