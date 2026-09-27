import AxeBuilder from '@axe-core/playwright';
import { createI18n } from '@helpdock/i18n';
import { test as base, expect, type Page } from '@playwright/test';
import { CLOSED_BRAND, OPEN_BRAND, REFERENCE } from './fixtures.ts';

/**
 * The hosted web form (M4-09, artboards `WebFormEN` and `WebFormAR`) in a real
 * browser, in both languages: the form, the error summary, the thank-you page,
 * the closed page, and axe on each.
 */

const test = base.extend<{ pageLocale: 'en' | 'ar' }>({
  pageLocale: ['en', { option: true }],
});

test.use({ reducedMotion: 'reduce' });

const strings = (locale: 'en' | 'ar') => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'webform');
  return (key: string, options?: Record<string, unknown>): string =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);
};

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

const open = async (page: Page, locale: 'en' | 'ar', brand = OPEN_BRAND): Promise<void> => {
  await page.goto(`/contact/${brand}?lang=${locale}`);
};

test('shows the form in the page’s language and direction', async ({ page, pageLocale }) => {
  const t = strings(pageLocale);
  await open(page, pageLocale);

  await expect(page.getByRole('heading', { level: 1, name: t('heading') })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', pageLocale === 'ar' ? 'rtl' : 'ltr');
  await expect(page).toHaveTitle(t('title', { brand: 'Helpdock' }));
  await expect(page.getByLabel(pageLocale === 'ar' ? 'رقم الطلب' : 'Order number')).toBeVisible();
  await expect(page.getByLabel(t('fields.attachments'))).toBeVisible();
  // The other language is one link away, named in its own language.
  await expect(page.getByRole('link', { name: t('otherLanguage') })).toHaveAttribute(
    'lang',
    pageLocale === 'ar' ? 'en' : 'ar',
  );
  expect(await violations(page)).toEqual([]);
});

test('names what needs attention, focuses the summary and keeps what was typed', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await open(page, pageLocale);

  await page.getByLabel(t('fields.name')).fill('Omar Khalil');
  await page.getByLabel(t('fields.email')).fill('omar.k@example');
  await page.getByRole('button', { name: t('submit') }).click();

  const summary = page.getByRole('alert').filter({ hasText: t('summary', { count: 3 }) });
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(page.getByLabel(t('fields.email'))).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText(t('errors.email'))).toBeVisible();
  await expect(page.getByLabel(t('fields.name'))).toHaveValue('Omar Khalil');

  await summary.getByRole('link', { name: t('fields.message') }).click();
  await expect(page).toHaveURL(/#wf-message$/);
  expect(await violations(page)).toEqual([]);
});

test('sends and shows the reference with the brand’s thank-you message', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await open(page, pageLocale);

  await page.getByLabel(t('fields.name')).fill('Omar Khalil');
  await page.getByLabel(t('fields.email')).fill('omar.k@example.com');
  await page.getByLabel(t('fields.subject')).fill('Refund for order 8841');
  await page.getByLabel(t('fields.message')).fill('The refund never arrived.');
  await page.getByLabel(t('fields.attachments')).setInputFiles({
    name: 'receipt.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n'),
  });
  await page.getByRole('button', { name: t('submit') }).click();

  await expect(page.getByRole('status')).toHaveText(t('success.status'));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(REFERENCE);
  await expect(page.getByText(REFERENCE, { exact: false }).nth(1)).toBeVisible();
  await expect(page.getByRole('link', { name: t('success.another') })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('refuses a file of a type the brand does not take', async ({ page, pageLocale }) => {
  const t = strings(pageLocale);
  await open(page, pageLocale);

  await page.getByLabel(t('fields.name')).fill('Omar');
  await page.getByLabel(t('fields.email')).fill('omar@example.com');
  await page.getByLabel(t('fields.subject')).fill('Hello');
  await page.getByLabel(t('fields.message')).fill('Hi');
  await page.getByLabel(t('fields.attachments')).setInputFiles({
    name: 'setup.exe',
    mimeType: 'application/x-msdownload',
    buffer: Buffer.from('MZ'),
  });
  await page.getByRole('button', { name: t('submit') }).click();

  await expect(page.getByText(t('errors.file_type'))).toBeVisible();
  await expect(page.getByLabel(t('fields.attachments'))).toHaveAttribute('aria-invalid', 'true');
});

test('says the form is closed when the brand turned it off', async ({ page, pageLocale }) => {
  const t = strings(pageLocale);
  const response = await page.goto(`/contact/${CLOSED_BRAND}?lang=${pageLocale}`);

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: t('closed.heading') })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
