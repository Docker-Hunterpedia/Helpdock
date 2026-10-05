import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { MOCK_BRANDS } from '../src/auth/mock-api.js';
import { activeDeletion, pendingDeletion } from '../src/screens/admin/system/fixtures.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * Brand › Danger zone's "Delete this brand" and the pending-deletion banner
 * (M8-07), in a real browser, in both languages. The install-admin deletion
 * route is answered here: it starts active, a POST with the right prefix
 * starts the grace, and DELETE restores.
 */

test.use({ reducedMotion: 'reduce' });

const BRAND = MOCK_BRANDS[0];

async function stubDeletion(page: Page, refuse = false): Promise<void> {
  let deletion = activeDeletion(BRAND?.id ?? '');
  await page.route('**/api/install/brands/*/deletion', async (route) => {
    const method = route.request().method();
    if (method === 'POST' && refuse) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'bad_request' } }),
      });
      return;
    }
    if (method === 'POST') {
      deletion = pendingDeletion(deletion.brandId, Date.now());
    }
    if (method === 'DELETE') {
      deletion = activeDeletion(deletion.brandId);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(deletion),
    });
  });
}

async function openDangerZone(page: Page, locale: Locale): Promise<void> {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: t('admin:nav.brand'), exact: true }).click();
  await page.getByRole('tab', { name: t('brand:tabs.danger') }).click();
  await page.getByRole('heading', { name: t('brand:deletion.heading') }).waitFor();
}

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

test.describe('deleting a brand', () => {
  test('deletes once the prefix is typed, then restores from the banner', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await stubDeletion(page);
    await openDangerZone(page, locale);
    const submit = page.getByRole('button', { name: t('brand:deletion.submit') });
    await expect(submit).toBeDisabled();

    await page
      .getByRole('textbox', { name: t('brand:deletion.confirm', { prefix: BRAND?.ticketPrefix }) })
      .fill(BRAND?.ticketPrefix ?? '');
    await submit.click();

    const banner = page
      .getByRole('status')
      .filter({ has: page.getByRole('button', { name: t('brand:deletion.restore') }) });
    await expect(banner).toBeVisible();
    // Read-only during the grace, on this tab and the others.
    await expect(
      page.getByRole('spinbutton', {
        name: t('brand:retention.daysLabel', { row: t('brand:retention.rows.spamTickets') }),
      }),
    ).toBeDisabled();
    expect(await violations(page)).toEqual([]);

    await banner.getByRole('button', { name: t('brand:deletion.restore') }).click();

    await expect(page.getByRole('heading', { name: t('brand:deletion.heading') })).toBeVisible();
  });

  test('says why when the api refuses the prefix', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await stubDeletion(page, true);
    await openDangerZone(page, locale);

    await page
      .getByRole('textbox', { name: t('brand:deletion.confirm', { prefix: BRAND?.ticketPrefix }) })
      .fill(BRAND?.ticketPrefix ?? '');
    await page.getByRole('button', { name: t('brand:deletion.submit') }).click();

    await expect(page.getByRole('alert')).toHaveText(t('brand:deletion.wrongPrefix'));
    expect(await violations(page)).toEqual([]);
  });
});
