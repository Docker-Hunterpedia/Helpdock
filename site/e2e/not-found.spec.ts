import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('404 page', () => {
  test('a missing address gets the site’s own 404, searched by its words', async ({ page }) => {
    const response = await page.goto('/does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle('Page not found · Helpdock');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'We could not find that page.',
    );
    await expect(page.getByRole('group', { name: 'Request for this page' })).toContainText(
      '/does-not-exist',
    );
    await expect(page.getByLabel('Search the site')).toHaveValue('does not exist');
    const start = page.locator('.nf-links:visible');
    for (const name of ['Install guide', 'Docs', 'Channels', 'Compare']) {
      await expect(start.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
  });

  test('a misspelt address is offered the page it meant', async ({ page }) => {
    await page.goto('/docs/instal');
    const suggestion = page.getByRole('link', { name: '/docs/install/' });
    await expect(suggestion).toBeVisible();
    await expect(page.locator('[data-nf-results] a').first()).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Top results' })).toHaveText(
      'Top results for “instal”',
    );
    await suggestion.click();
    await expect(page).toHaveURL(/\/docs\/install\/$/);
  });

  test('Search everything opens the site search with the same words', async ({ page }) => {
    await page.goto('/docs/instal');
    await page.getByLabel('Search the site').fill('telegram');
    await page.getByRole('button', { name: 'Search everything' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox')).toHaveValue('telegram');
    await expect(dialog.getByRole('option').first()).toBeVisible();
  });

  test('under /ar/ the page is Arabic and right to left before it paints', async ({ page }) => {
    const response = await page.goto('/ar/does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page).toHaveTitle('الصفحة غير موجودة · Helpdock');
    const headings = page.getByRole('heading', { level: 1 });
    await expect(headings).toHaveCount(1);
    await expect(headings).toHaveText('لم نجد هذه الصفحة.');
    await expect(page.getByLabel('ابحث في الموقع')).toBeVisible();
    await expect(
      page.locator('.nf-links:visible').getByRole('link', { name: /^القنوات/ }),
    ).toHaveAttribute('href', '/ar/channels/');
  });

  test('an address typed without its slash still reaches the page', async ({ page }) => {
    const response = await page.goto('/docs/install');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/docs\/install\/$/);
  });

  for (const path of ['/does-not-exist', '/ar/does-not-exist']) {
    test(`${path} passes axe`, async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
