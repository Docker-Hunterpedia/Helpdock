import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { auditLogPage, healthySystemStatus } from '../src/screens/admin/system/fixtures.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * The audit log page in a real browser, in both languages (M3-08, artboard
 * `AdminAuditLog`). The api is stubbed with Playwright's `route`, as the System
 * page's spec does, from the same fixture the unit tests use.
 */

test.use({ reducedMotion: 'reduce' });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

const stub = async (page: Page, status = 200): Promise<void> => {
  await page.route('**/api/install/system', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(healthySystemStatus()),
    });
  });
  await page.route('**/api/install/audit-log**', async (route) => {
    const url = new URL(route.request().url());
    const empty = url.searchParams.get('actor') === 'nobody';
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(
        status === 200
          ? auditLogPage(empty ? { entries: [], nextCursor: null } : {})
          : { error: { code: 'forbidden' } },
      ),
    });
  });
};

/** System, then its audit card's "Open": the path a person takes. */
const openAuditLog = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.system')) }).click();
  await page
    .getByRole('region', { name: t('system:audit.title') })
    .getByRole('link', { name: t('system:audit.open') })
    .click();
  await page.getByRole('heading', { name: t('system:auditLog.title'), level: 1 }).waitFor();
};

test.describe('the audit log', () => {
  test('lists the rows and expands one into its redacted diff', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await stub(page);
    await openAuditLog(page, locale);

    const table = page.getByRole('table', { name: t('system:auditLog.entries') });
    await expect(table.getByText('34.201.18.7')).toBeVisible();

    const toggle = page.getByRole('button', { name: /settings\.updated/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(t('system:auditLog.diff.secret'))).toBeVisible();
    await expect(page.getByText('[redacted]')).toHaveCount(2);
    expect(await violations(page)).toEqual([]);
  });

  test('says so when the filters match nothing', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await stub(page);
    await openAuditLog(page, locale);

    await page.getByRole('searchbox', { name: t('system:auditLog.filters.actor') }).fill('nobody');

    await expect(
      page.getByRole('heading', { name: t('system:auditLog.empty.heading') }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('draws a refusal as "Not allowed"', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await stub(page, 403);
    await openAuditLog(page, locale);

    await expect(page.getByRole('heading', { name: t('system:notAllowed.heading') })).toBeVisible();
  });
});
