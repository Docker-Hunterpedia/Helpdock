import { expect, type Page } from '@playwright/test';
import { HELP_CENTER_URL } from './fixtures.ts';
import { path, strings, test } from './help-center-pages.ts';

/**
 * What a screen reader is told on the published help center, asserted on the
 * DOM (M9-04, WCAG 4.1.3 Status Messages; `docs/completed/accessibility-audit.md`):
 * the count of search results sits in a live region, and the thanks after
 * "Was this helpful?" is a status that takes focus, so it is read on the
 * page the answer lands on. The screen reader's own voice stays a person's pass.
 */

test.use({ reducedMotion: 'reduce', baseURL: HELP_CENTER_URL });

/** The live regions in `<main>`, by role and text. */
const liveRegions = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'main [role=status], main [role=alert], main [role=log], main [aria-live]:not([aria-live=off])',
      ),
    ].map(
      (element) =>
        `${element.getAttribute('role') ?? 'aria-live'}: ${(element.textContent ?? '').trim()}`,
    ),
  );

test('the number of search results is the one live region of the page, ahead of the list', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await page.goto(path(`/${pageLocale}/search?q=refund`));

  const count = t('search.count', { count: 1, language: t(`languageName.${pageLocale}`) });
  expect(await liveRegions(page)).toEqual([`status: ${count}`]);
  const status = page.getByRole('status');
  await expect(status).toHaveText(count);
  const [statusBox, listBox] = await Promise.all([
    status.boundingBox(),
    page.locator('main ol.hd-results').boundingBox(),
  ]);
  expect(statusBox?.y, 'the count comes before the list').toBeLessThan(listBox?.y ?? 0);
});

test('a search with no results says so in the one live region, and keeps the heading in the outline', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await page.goto(path(`/${pageLocale}/search?q=warranty`));

  const heading = t('search.empty.heading', { q: 'warranty' });
  expect(await liveRegions(page)).toEqual([`status: ${heading}`]);
  await expect(page.getByRole('status').getByRole('heading', { level: 2 })).toHaveText(heading);
});

test('a search with nothing asked has no live region to announce', async ({ page, pageLocale }) => {
  await page.goto(path(`/${pageLocale}/search`));

  expect(await liveRegions(page)).toEqual([]);
});

test('"Was this helpful?" is a named group, and after a "No" only "No" is pressed', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await page.goto(path(`/${pageLocale}/articles/refund-timelines`));

  const group = page.getByRole('group', { name: t('article.feedback.question') });
  await expect(group.getByRole('button')).toHaveCount(2);
  await expect(group.getByRole('button', { name: t('article.feedback.yes') })).not.toHaveAttribute(
    'aria-pressed',
    /.*/,
  );

  await page.goto(path(`/${pageLocale}/articles/refund-timelines?feedback=no`));
  await expect(page.getByRole('button', { name: t('article.feedback.no') })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: t('article.feedback.yes') })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('after "Yes" the thanks is the one status of the page and has focus, so it is read', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await page.goto(path(`/${pageLocale}/articles/refund-timelines`));

  await page.getByRole('button', { name: t('article.feedback.yes') }).focus();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/feedback=1#feedback$/);
  const thanks = page.getByRole('status');
  await expect(thanks).toHaveCount(1);
  await expect(thanks).toContainText(t('article.feedback.thanks'));
  await expect(thanks).toBeFocused();
  expect(await liveRegions(page)).toHaveLength(1);
});
