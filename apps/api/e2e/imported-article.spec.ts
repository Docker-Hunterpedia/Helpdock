import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { createI18n } from '@helpdock/i18n';
import { test as base, expect } from '@playwright/test';
import { HC_BRAND } from '../src/testing/help-center-site.ts';
import { HELP_CENTER_URL } from './fixtures.ts';
import { IMPORTED_FILE_BYTES, IMPORTED_FILE_DOWNLOAD_PATH } from './imported-article.ts';

const test = base.extend<{ pageLocale: 'en' | 'ar' }>({ pageLocale: ['en', { option: true }] });
test.use({ baseURL: HELP_CENTER_URL, reducedMotion: 'reduce' });

test('reads a managed imported file and the explicit unavailable-file state', async ({
  page,
  pageLocale,
}) => {
  await page.goto(`/hc/${HC_BRAND}/${pageLocale}/articles/imported-source-files`);
  await expect(page.locator('html')).toHaveAttribute('dir', pageLocale === 'ar' ? 'rtl' : 'ltr');
  const main = page.getByRole('main');
  const available = main.getByRole('link', { name: 'original-manual.pdf', exact: true });
  await expect(available).toHaveAttribute('href', IMPORTED_FILE_DOWNLOAD_PATH);
  const label = createI18n({ lng: pageLocale }).t('imports:articleAssetUnavailable');
  await expect(main.getByText(`${label}: missing-manual.pdf`, { exact: true })).toBeVisible();
  await expect(main.getByRole('link', { name: /missing-manual/ })).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  const [download] = await Promise.all([page.waitForEvent('download'), available.click()]);
  expect(download.suggestedFilename()).toBe('original-manual.pdf');
  expect(download.url()).toBe(new URL(IMPORTED_FILE_DOWNLOAD_PATH, HELP_CENTER_URL).href);
  const destination = await download.path();
  if (!destination) throw new Error('Missing downloaded fixture file');
  expect(await readFile(destination)).toEqual(IMPORTED_FILE_BYTES);
});
