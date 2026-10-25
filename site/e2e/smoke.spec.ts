import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const theme = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.dataset.theme ?? 'system');

test.describe('theme switch', () => {
  test('a stored choice survives a reload and System clears it', async ({ page }) => {
    await page.goto('/');
    const group = page.getByRole('group', { name: 'Colour theme' });
    await group.getByRole('button', { name: 'Dark' }).click();
    await expect(group.getByRole('button', { name: 'Dark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await theme(page)).toBe('dark');

    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(await theme(page)).toBe('dark');

    await page
      .getByRole('group', { name: 'Colour theme' })
      .getByRole('button', { name: 'System' })
      .click();
    expect(await theme(page)).toBe('system');
    expect(await page.evaluate(() => localStorage.getItem('helpdock-theme'))).toBeNull();
  });

  test('without a stored choice the page follows the system', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto('/ar/');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(21, 23, 27)');
    await context.close();
  });

  test('still renders and switches when storage is blocked', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page
      .getByRole('group', { name: 'Colour theme' })
      .getByRole('button', { name: 'Light' })
      .click();
    expect(await theme(page)).toBe('light');
    expect(errors).toEqual([]);
  });
});

test('the pages load nothing from another origin', async ({ page, baseURL }) => {
  const foreign: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(baseURL ?? '')) foreign.push(request.url());
  });
  for (const path of [
    '/',
    '/ar/',
    '/compare/helpdock-vs-zendesk/',
    '/channels/email/',
    '/docs/install/',
  ]) {
    await page.goto(path, { waitUntil: 'networkidle' });
  }
  expect(foreign).toEqual([]);
});

test('the Arabic home is right to left and points at its English counterpart', async ({ page }) => {
  await page.goto('/ar/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
    'href',
    'https://helpdock.oday-bakkour.com/',
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
});

for (const path of ['/', '/ar/']) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${path} passes axe in ${colorScheme}`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(path, { waitUntil: 'networkidle' });
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((violation) => violation.id)).toEqual([]);
      await context.close();
    });
  }
}
