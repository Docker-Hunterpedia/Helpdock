import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_UNSUBSCRIBE_EMAIL, MOCK_UNSUBSCRIBE_TOKENS } from '../src/unsubscribe/mock-api.js';
import { expect, test } from './fixtures.js';
import { strings } from './strings.js';

/**
 * The public unsubscribe page (`Public/Unsubscribe`, en and ar; M14-11) in a
 * real browser. It is reached by its link with no session, which is exactly how
 * a person arrives from a notification email; the account's language wins once
 * the link is known, and `?lang=` (which the email's link carries) is the
 * language of a link that is no good.
 */

test.use({ reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

test.describe('the unsubscribe page', () => {
  test('asks first, then unsubscribes and says what still reaches the person', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const token = locale === 'ar' ? MOCK_UNSUBSCRIBE_TOKENS.arabic : MOCK_UNSUBSCRIBE_TOKENS.valid;
    await page.goto(`/unsubscribe/${token}?lang=${locale}`);

    await expect(
      page.getByRole('heading', { name: t('unsubscribe:confirm.heading') }),
    ).toBeVisible();
    await expect(page.getByText(MOCK_UNSUBSCRIBE_EMAIL)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page).toHaveTitle(t('unsubscribe:title'));
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('unsubscribe:confirm.action') }).click();

    await expect(page.getByRole('status')).toContainText(t('unsubscribe:done.status'));
    await expect(page.getByText(t('unsubscribe:done.body'))).toBeVisible();
    await expect(page.getByRole('link', { name: t('unsubscribe:done.settings') })).toHaveAttribute(
      'href',
      '/me/notifications',
    );
    expect(await violations(page)).toEqual([]);
  });

  test('draws one screen for an expired or made-up link, naming no address', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto(`/unsubscribe/${MOCK_UNSUBSCRIBE_TOKENS.expired}?lang=${locale}`);

    await expect(
      page.getByRole('heading', { name: t('unsubscribe:invalid.heading') }),
    ).toBeVisible();
    await expect(page.getByText(t('unsubscribe:invalid.body'))).toBeVisible();
    await expect(page.getByRole('link', { name: t('unsubscribe:invalid.action') })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    await expect(page.getByText(MOCK_UNSUBSCRIBE_EMAIL)).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    expect(await violations(page)).toEqual([]);
  });

  test('holds at 320 px wide with 44 px targets', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await page.setViewportSize({ width: 320, height: 640 });
    const token = locale === 'ar' ? MOCK_UNSUBSCRIBE_TOKENS.arabic : MOCK_UNSUBSCRIBE_TOKENS.valid;
    await page.goto(`/unsubscribe/${token}?lang=${locale}`);

    const button = page.getByRole('button', { name: t('unsubscribe:confirm.action') });
    await expect(button).toBeVisible();
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});
