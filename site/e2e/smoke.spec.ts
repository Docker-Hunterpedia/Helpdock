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

test.describe('search', () => {
  test('finds a guide from the keyboard and opens it', async ({ page }) => {
    await page.goto('/docs/');
    await page.keyboard.press('/');
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Search' }).fill('telegram');
    const first = dialog.getByRole('option').first();
    await expect(first).toContainText(/telegram/i);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/(docs|channels)\/[^/]*telegram/);
  });

  test('says so when nothing matches, and returns focus on Escape', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Search' }).first();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await dialog.getByRole('combobox').fill('zzqqxxnothing');
    await expect(dialog.getByRole('status')).toContainText('No results');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test('the docs AI menu copies the page and links to its Markdown', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/telegram/');
  await page.getByText('Use with AI').click();
  await expect(page.getByRole('link', { name: 'View as Markdown' })).toHaveAttribute(
    'href',
    '/docs/telegram.md',
  );
  await expect(page.getByRole('link', { name: 'Open in Claude' })).toHaveAttribute(
    'href',
    /^https:\/\/claude\.ai\/new\?q=Read%20https%3A%2F%2Fhelpdock\.oday-bakkour\.com%2Fdocs%2Ftelegram\.md/,
  );
  await page.getByRole('button', { name: 'Copy page as Markdown' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^# Telegram/);
});

test('the API reference lists the endpoints from the OpenAPI document', async ({ page }) => {
  await page.goto('/docs/api-reference/');
  await expect(page.getByRole('heading', { name: 'POST /api/v1/tickets', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Webhook events' })).toBeVisible();
  const response = await page.request.get('/docs/api-reference/openapi.json');
  expect((await response.json()).openapi).toBe('3.1.0');
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
