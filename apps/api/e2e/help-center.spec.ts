import AxeBuilder from '@axe-core/playwright';
import { createI18n } from '@helpdock/i18n';
import { test as base, expect, type Page } from '@playwright/test';
import { HELP_CENTER_URL } from './fixtures.ts';

/**
 * The published help center (M5-03, M5-04; artboards `HelpCenter/Home-EN|AR`,
 * `Category-EN|AR`, `Help center · article`, `Article-AR`, `Search-EN|AR`,
 * `States-EN`) in a real browser, in both languages: home, a category, an
 * article and its "Was this helpful?", search with results and without, and
 * a 404 — each through axe.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

const test = base.extend<{ pageLocale: 'en' | 'ar' }>({
  pageLocale: ['en', { option: true }],
});

test.use({ reducedMotion: 'reduce', baseURL: HELP_CENTER_URL });

const strings = (locale: 'en' | 'ar') => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'hcSite');
  return (key: string, options?: Record<string, unknown>): string =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);
};

const RETURNS = { en: 'Returns & refunds', ar: 'الإرجاع والاسترداد' } as const;
const TIMELINES = { en: 'Refund timelines', ar: 'مواعيد استرداد المبلغ' } as const;

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // The article's video is a third-party player; its frame is not ours to audit.
    .exclude('iframe')
    .analyze();
  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
}

const open = (page: Page, path: string) => page.goto(`/hc/${BRAND}${path}`);

test('the home page lists the topics in the page’s language and direction', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  const response = await open(page, `/${pageLocale}`);

  expect(response?.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('dir', pageLocale === 'ar' ? 'rtl' : 'ltr');
  await expect(page.getByRole('heading', { level: 1, name: t('home.title') })).toBeVisible();
  await expect(
    page.getByRole('link', { name: new RegExp(RETURNS[pageLocale]) }).first(),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: t('home.featured') })).toBeVisible();
  await expect(page.getByRole('link', { name: t('otherLanguage') })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('a category shows its sections and leads to an article', async ({ page, pageLocale }) => {
  const t = strings(pageLocale);
  await open(page, `/${pageLocale}/categories/returns-and-refunds`);

  await expect(page.getByRole('heading', { level: 1, name: RETURNS[pageLocale] })).toBeVisible();
  await expect(page.getByRole('navigation', { name: t('nav.breadcrumb') })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await page.getByRole('main').getByRole('link', { name: TIMELINES[pageLocale] }).click();
  await expect(page.getByRole('heading', { level: 1, name: TIMELINES[pageLocale] })).toBeVisible();
});

test('an article takes a "Was this helpful?" answer and thanks the reader', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await open(page, `/${pageLocale}/articles/refund-timelines`);

  await expect(page.getByRole('heading', { level: 1, name: TIMELINES[pageLocale] })).toBeVisible();
  await expect(page.getByRole('group', { name: t('article.feedback.question') })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await page.getByRole('button', { name: t('article.feedback.yes') }).click();
  await expect(page.getByRole('status')).toContainText(t('article.feedback.thanks'));
  await expect(page).toHaveURL(/feedback=1#feedback$/);
});

test('an article missing in Arabic is shown in English with a notice', async ({
  page,
  pageLocale,
}) => {
  test.skip(pageLocale !== 'ar', 'the fallback is the Arabic reader’s');
  const t = strings('ar');
  await open(page, '/ar/articles/how-to-start-a-return');

  await expect(page.getByRole('note')).toContainText(
    t('article.fallback.title', { language: t('languageName.ar') }),
  );
  await expect(page.locator('article')).toHaveAttribute('lang', 'en');
  expect(await violations(page)).toEqual([]);
});

test('search marks what it found, and says so when it found nothing', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await open(page, `/${pageLocale}`);

  await page
    .getByRole('searchbox', { name: t('search.label') })
    .first()
    .fill('refund');
  await page.getByRole('button', { name: t('search.submit') }).click();
  await expect(page.getByRole('heading', { level: 1, name: t('search.title') })).toBeVisible();
  await expect(page.locator('mark').first()).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await page.getByRole('searchbox', { name: t('search.label') }).fill('warranty');
  await page.getByRole('button', { name: t('search.submit') }).click();
  await expect(
    page.getByRole('heading', { name: t('search.empty.heading', { q: 'warranty' }) }),
  ).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('an unknown page answers 404 with a way back', async ({ page, pageLocale }) => {
  const t = strings(pageLocale);
  const response = await open(page, `/${pageLocale}/articles/approving-large-refunds`);

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: t('states.notFound.heading') })).toBeVisible();
  await expect(page.getByRole('link', { name: t('states.notFound.home') })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
