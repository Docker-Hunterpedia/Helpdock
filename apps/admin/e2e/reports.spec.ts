import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { OMAR, previousSummary, reportSummary } from '../src/screens/reports/fixtures.js';
import { isoDay } from '../src/screens/reports/report-range.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Reports` (M8-04) in a real browser, in both languages. The app runs
 * on the mock auth adapter, so the two report routes are answered here from
 * the fixture the unit tests use: the summary (current period and the one
 * before it) and the CSV export.
 */

test.use({ reducedMotion: 'reduce' });

const isSummary = (url: URL): boolean => /\/api\/brands\/[^/]+\/reports$/.test(url.pathname);
const isExport = (url: URL): boolean =>
  /\/api\/brands\/[^/]+\/reports\/exports\/[a-z_]+$/.test(url.pathname);

async function stubReports(page: Page, status = 200): Promise<void> {
  await page.route(isSummary, async (route) => {
    const url = new URL(route.request().url());
    const query = {
      from: url.searchParams.get('from') ?? '',
      to: url.searchParams.get('to') ?? '',
    };
    const agentId = url.searchParams.get('agentId');
    const summary = query.to === isoDay(new Date()) ? reportSummary(query) : previousSummary(query);
    const body = { ...summary, filters: { ...summary.filters, agentId } };
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(status === 200 ? body : { error: { code: 'internal_error' } }),
    });
  });
  await page.route(isExport, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/csv; charset=utf-8',
      body: 'day,created,resolved\r\n2026-10-04,38,30\r\n',
    });
  });
}

async function openReports(page: Page, locale: Locale, status = 200): Promise<void> {
  await stubReports(page, status);
  await signIn(page, locale);
  await page.getByRole('link', { name: new RegExp(strings(locale)('admin:nav.reports')) }).click();
}

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
}

test.describe('the Reports page', () => {
  test('draws the KPI tiles and every card of the artboard', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openReports(page, locale);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('reports:title'));
    const created = page.getByRole('region', { name: t('reports:kpi.created.label') });
    await expect(created.getByText('1,020')).toBeVisible();
    await expect(
      created.getByText(t('reports:kpi.created.up', { percent: 8, count: 30 })),
    ).toBeVisible();

    for (const title of [
      'reports:volume.title',
      'reports:times.title',
      'reports:sla.title',
      'reports:backlog.title',
      'reports:csat.title',
      'reports:agents.title',
      'reports:hours.title',
      'reports:searches.topTitle',
      'reports:searches.zeroTitle',
      'reports:ai.deflectionTitle',
      'reports:ai.costTitle',
    ] as const) {
      await expect(page.getByRole('region', { name: t(title) })).toBeVisible();
    }
    await expect(
      page
        .getByRole('region', { name: t('reports:ai.costTitle') })
        .getByText(t('reports:ai.unavailable')),
    ).toBeVisible();
  });

  test('swaps a chart for its table, and exports its rows as CSV', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openReports(page, locale);
    const volume = page.getByRole('region', { name: t('reports:volume.title') });

    await volume
      .getByRole('button', { name: t('reports:card.table', { chart: t('reports:volume.title') }) })
      .click();
    await expect(volume.getByRole('table')).toBeVisible();
    await expect(volume.getByRole('table').getByRole('row')).toHaveCount(31);

    const download = page.waitForEvent('download');
    await volume
      .getByRole('button', { name: t('reports:card.export', { chart: t('reports:volume.title') }) })
      .click();
    expect((await download).suggestedFilename()).toMatch(
      /^helpdock-volume-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });

  test('stacks the volume by status and exports that breakdown', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openReports(page, locale);
    const volume = page.getByRole('region', { name: t('reports:volume.title') });

    await volume.getByRole('button', { name: t('reports:volume.by.status') }).click();

    await expect(volume.getByRole('list').getByRole('listitem')).toHaveText(['Closed', 'Open']);
    const download = page.waitForEvent('download');
    await volume
      .getByRole('button', { name: t('reports:card.export', { chart: t('reports:volume.title') }) })
      .click();
    expect((await download).suggestedFilename()).toMatch(/^helpdock-volume-by-status-/);
  });

  test('shows SLA by priority, and per-agent figures with the unassigned row', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openReports(page, locale);

    await expect(
      page
        .getByRole('region', { name: t('reports:sla.title') })
        .getByRole('heading', { name: t('reports:sla.byPriority') }),
    ).toBeVisible();
    const agents = page.getByRole('region', { name: t('reports:agents.title') });
    const lina = agents.getByRole('row').filter({ hasText: 'Lina Haddad' });
    await expect(lina.getByRole('cell')).toHaveText([
      'Lina Haddad',
      '18',
      '214',
      '486',
      '31m',
      '7h 20m',
      '95.1 %',
      '4.7',
    ]);
    await expect(agents.getByRole('cell', { name: t('reports:agents.unassigned') })).toBeVisible();
  });

  test("filters by agent, leaving the unassigned row out of one agent's report", async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openReports(page, locale);
    const agents = page.getByRole('region', { name: t('reports:agents.title') });
    await expect(agents.getByRole('cell', { name: t('reports:agents.unassigned') })).toBeVisible();

    const asked = page.waitForRequest((request) =>
      new URL(request.url()).searchParams.has('agentId'),
    );
    await page.getByRole('combobox', { name: t('reports:filters.agent') }).click();
    await page.getByRole('option', { name: 'Omar' }).click();

    expect(new URL((await asked).url()).searchParams.get('agentId')).toBe(OMAR);
    await expect(
      agents.getByRole('cell', { name: t('reports:agents.unassigned') }),
    ).not.toBeVisible();
  });

  test('says the reports could not be read when the api fails', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openReports(page, locale, 500);

    await expect(page.getByRole('heading', { name: t('reports:error.heading') })).toBeVisible();
  });

  test('has no accessibility violations', async ({ page, appLocale: locale }) => {
    await openReports(page, locale);
    await page.getByRole('region', { name: strings(locale)('reports:hours.title') }).waitFor();

    expect(await violations(page)).toEqual([]);
  });
});
