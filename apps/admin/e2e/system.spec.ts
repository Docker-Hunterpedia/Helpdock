import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import {
  activeDeletion,
  brandDeletionOf,
  degradedSystemStatus,
  healthySystemStatus,
  installBrands,
  measuredSystemStatus,
  productMetrics,
  QUEUE_BOARD_PASS,
} from '../src/screens/admin/system/fixtures.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * The System page in a real browser, in both languages.
 *
 * The api is stubbed with Playwright's own `route`, not MSW: the app runs
 * against the mock auth adapter here, there is no api to talk to, and one
 * fulfilled request needs no service worker and no extra dependency. The body
 * comes from the same fixture the unit tests use, so the two cannot drift.
 */

/**
 * Transitions are off: a card caught mid-fade reads as low contrast to axe, and
 * DESIGN §4 drops every duration to zero under reduced motion anyway.
 */
test.use({ reducedMotion: 'reduce' });

const SYSTEM_ENDPOINT = '**/api/install/system';

type Fixture = ReturnType<typeof healthySystemStatus>;

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * Answers the status read with the body a test chose, and the M8 reads the
 * page makes beside it (product metrics, brands and their deletions, the
 * queue board pass) from the shared fixtures.
 */
async function stubSystem(page: Page, body: Fixture): Promise<void> {
  await page.route(SYSTEM_ENDPOINT, (route) => route.fulfill(json(body)));
  await page.route('**/api/install/system/metrics', (route) =>
    route.fulfill(json(productMetrics())),
  );
  await page.route('**/api/install/system/queue-board', (route) =>
    route.fulfill(json({ url: QUEUE_BOARD_PASS })),
  );
  await page.route(QUEUE_BOARD_PASS, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Bull Board</title>' }),
  );
  await page.route('**/api/install/brands', (route) =>
    route.fulfill(json({ brands: installBrands() })),
  );
  await page.route('**/api/install/brands/*/deletion', (route) => {
    const brandId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    return route.fulfill(
      json(
        route.request().method() === 'DELETE' ? activeDeletion(brandId) : brandDeletionOf(brandId),
      ),
    );
  });
}

async function openSystem(page: Page, locale: Locale, body: Fixture): Promise<void> {
  await stubSystem(page, body);
  await signIn(page, locale);
  await page.getByRole('link', { name: new RegExp(strings(locale)('admin:nav.system')) }).click();
}

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
}

test.describe('the System page', () => {
  test('draws every card of the artboard', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openSystem(page, locale, healthySystemStatus());

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('system:title'));

    for (const card of ['api', 'worker', 'postgres', 'redis'] as const) {
      await expect(
        page.getByRole('region', { name: t(`system:cards.${card}.title`) }),
      ).toBeVisible();
    }

    await expect(page.getByRole('table', { name: t('system:queues.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:channels.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:storage.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:llm.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:pending.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:audit.title') })).toBeVisible();

    // The version string is Latin in both locales (DESIGN §7).
    await expect(page.getByText('helpdock 0.1.0 · a2cf2b3 · node v24.18.0')).toBeVisible();
  });

  test('shows a degraded Redis as a warning in words', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openSystem(page, locale, degradedSystemStatus());

    const redis = page.getByRole('region', { name: t('system:cards.redis.title') });

    await expect(redis.getByText(t('system:status.warning'))).toBeVisible();
    await expect(
      redis.getByText(t('system:cards.redis.aofRewrite', { latency: '38' })),
    ).toBeVisible();

    // A warning must read as well to axe as a healthy card does.
    expect(await violations(page)).toEqual([]);
  });

  test('says what is not measured or set up rather than showing a zero', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openSystem(page, locale, healthySystemStatus());

    await expect(
      page
        .getByRole('region', { name: t('system:storage.title') })
        .getByText(t('system:storage.pending')),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: t('system:llm.title') })
        .getByText(t('system:llm.unavailable')),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: t('system:channels.title') })
        .getByText(t('system:channels.empty')),
    ).toBeVisible();
  });

  test('draws the product metrics, storage per brand and the brands pending deletion', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openSystem(page, locale, measuredSystemStatus());

    const activation = page.getByRole('region', { name: t('system:metrics.activation.label') });
    await expect(
      activation.getByText(t('system:metrics.activation.day', { day: 2 }), { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('table', { name: t('system:storage.byBrand') })
        .getByText(t('system:storage.pendingDeletion'), { exact: false }),
    ).toBeVisible();
    const pending = page.getByRole('region', { name: t('system:pending.title') });
    await expect(pending.getByText(t('system:pending.daysLeft', { count: 26 }))).toBeVisible();
    await expect(pending.getByText(t('system:pending.daysLeft', { count: 3 }))).toBeVisible();
  });

  test('restores a brand pending deletion', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openSystem(page, locale, measuredSystemStatus());

    await page
      .getByRole('button', { name: t('system:pending.restoreBrand', { name: 'Old Store' }) })
      .click();

    await expect(page.getByText(t('system:pending.restored', { name: 'Old Store' }))).toBeVisible();
  });

  test('expands the queue table in place', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openSystem(page, locale, healthySystemStatus());

    const table = page.getByRole('table', { name: t('system:queues.title') });
    await expect(table.getByRole('row')).toHaveCount(6);

    await page.getByRole('button', { name: t('system:queues.showAll') }).click();

    await expect(page.getByRole('button', { name: t('system:queues.showFewer') })).toBeVisible();
  });

  test('opens Bull Board in a new tab with a one-use pass', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openSystem(page, locale, healthySystemStatus());

    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: t('system:queueBoard.open') }).click();
    const board = await popup;

    await expect(board).toHaveURL(new RegExp(`${QUEUE_BOARD_PASS}$`));
  });

  test('draws a refusal as "Not allowed"', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    // The session lives in memory until M0-05, so the page is reached by
    // navigating inside the app rather than by loading the url again.
    await page.route(SYSTEM_ENDPOINT, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'forbidden', message: 'Not allowed' } }),
      });
    });

    await signIn(page, locale);
    await page.getByRole('link', { name: new RegExp(t('admin:nav.system')) }).click();

    await expect(page.getByRole('heading', { name: t('system:notAllowed.heading') })).toBeVisible();
  });

  test('has no accessibility violations when everything is healthy', async ({
    page,
    appLocale: locale,
  }) => {
    await openSystem(page, locale, healthySystemStatus());
    await page.getByRole('table', { name: strings(locale)('system:queues.title') }).waitFor();

    expect(await violations(page)).toEqual([]);
  });
});
