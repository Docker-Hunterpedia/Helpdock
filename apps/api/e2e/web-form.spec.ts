import AxeBuilder from '@axe-core/playwright';
import { createI18n } from '@helpdock/i18n';
import { test as base, expect, type Page } from '@playwright/test';
import { BROKEN_POW_BRAND, CLOSED_BRAND, OPEN_BRAND, POW_BRAND, REFERENCE } from './fixtures.ts';

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

const fillAndSend = async (page: Page, t: ReturnType<typeof strings>): Promise<void> => {
  await page.getByLabel(t('fields.name')).fill('Omar Khalil');
  await page.getByLabel(t('fields.email')).fill('omar.k@example.com');
  await page.getByLabel(t('fields.subject')).fill('Refund for order 8841');
  await page.getByLabel(t('fields.message')).fill('Refund for order 8841 not received.');
  await page.getByRole('button', { name: t('submit') }).click();
};

test.describe('the built-in check (ADR 0052, HelpCenter/WebForm-Verify)', () => {
  test('checks in the background, then sends with the solution', async ({ page, pageLocale }) => {
    const t = strings(pageLocale);
    const outside: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1')) outside.push(request.url());
    });
    await open(page, pageLocale, POW_BRAND);

    const check = page.getByRole('status', { name: t('captcha.label') });
    await expect(check).toContainText(t('captcha.verified'));
    await expect(check).toContainText(t('captcha.builtIn'));
    await expect(page.getByRole('button', { name: t('submit') })).toBeEnabled();
    expect(await violations(page)).toEqual([]);

    await fillAndSend(page, t);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(REFERENCE);
    // Nothing is fetched from a third party.
    expect(outside).toEqual([]);
  });

  test('checks without WebCrypto, as on a form served over http://', async ({
    page,
    pageLocale,
  }) => {
    const t = strings(pageLocale);
    await page.addInitScript(() => {
      Object.defineProperty(window.crypto, 'subtle', { get: () => undefined });
    });
    await open(page, pageLocale, POW_BRAND);

    await expect(page.getByRole('status', { name: t('captcha.label') })).toContainText(
      t('captcha.verified'),
      { timeout: 15_000 },
    );
    await fillAndSend(page, t);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(REFERENCE);
  });

  test('keeps the page responsive while it solves without WebCrypto', async ({
    page,
    pageLocale,
  }) => {
    const t = strings(pageLocale);
    await page.addInitScript(() => {
      Object.defineProperty(window.crypto, 'subtle', { get: () => undefined });
      const record = window as unknown as { ticks: number[]; states: [string, number][] };
      record.ticks = [];
      record.states = [];
      setInterval(() => record.ticks.push(performance.now()), 5);
      new MutationObserver(() => {
        const box = document.getElementById('wf-pow');
        if (box?.dataset.state) record.states.push([box.dataset.state, performance.now()]);
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
    });
    // Its first challenge has no solution, so the plain digest runs all 50,000 numbers.
    await open(page, pageLocale, BROKEN_POW_BRAND);
    await expect(page.getByRole('alert', { name: t('captcha.label') })).toContainText(
      t('captcha.failed'),
      { timeout: 30_000 },
    );

    const { ticks, states } = await page.evaluate(() => {
      const record = window as unknown as { ticks: number[]; states: [string, number][] };
      return { ticks: record.ticks, states: record.states };
    });
    const began = states.find(([state]) => state === 'checking')?.[1] ?? 0;
    const ended = states.find(([state]) => state === 'failed')?.[1] ?? 0;
    const during = [began, ...ticks.filter((at) => at > began && at < ended), ended];
    const longestTask = Math.max(...during.slice(1).map((at, i) => at - (during[i] ?? at)));
    // A solve that never yielded would be one task as long as the whole solve.
    expect(ended - began).toBeGreaterThan(longestTask * 3);
    expect(longestTask).toBeLessThan(100);
  });

  test('says when the check failed, keeps Send off, and passes on Try again', async ({
    page,
    pageLocale,
  }) => {
    const t = strings(pageLocale);
    await open(page, pageLocale, BROKEN_POW_BRAND);

    const failed = page.getByRole('alert', { name: t('captcha.label') });
    await expect(failed).toContainText(t('captcha.failed'), { timeout: 30_000 });
    await expect(page.getByRole('button', { name: t('submit') })).toBeDisabled();
    expect(await violations(page)).toEqual([]);

    await failed.getByRole('button', { name: t('captcha.retry') }).click();
    await expect(page.getByRole('status', { name: t('captcha.label') })).toContainText(
      t('captcha.verified'),
    );
    await fillAndSend(page, t);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(REFERENCE);
  });
});
