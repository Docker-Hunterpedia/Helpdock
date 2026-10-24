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
  missingSenderSystemStatus,
  productMetrics,
  QUEUE_BOARD_PASS,
  smtpSettingsFixture,
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

test('pages import readings, retries a failed page and treats expiration as unknown', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  const brands = Array.from({ length: 51 }, (_, index) => ({
    brandId: `019a0000-0000-7000-8000-${String(index + 10).padStart(12, '0')}`,
    brandName: `Migration brand ${index + 1}`,
    active: 1,
    paused: 0,
    lastError: null,
  }));
  const health = {
    configured: true as const,
    snapshotId: '019a0000-0000-7000-8000-000000000001',
    observedAt: '2026-10-18T00:00:00.000Z',
    totalBrands: 51,
    active: 51,
    paused: 0,
    brands: brands.slice(0, 50),
  };
  let failed = false,
    expired = false;
  await page.route('**/api/install/system/imports?*', (route) => {
    if (!failed) {
      failed = true;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable' } }),
      });
    }
    return route.fulfill(
      json(
        expired
          ? { configured: false }
          : { ...health, brands: brands.slice(50), page: 2, hasNext: false },
      ),
    );
  });
  await openSystem(page, locale, { ...healthySystemStatus(), imports: health });
  const card = page.getByRole('region', { name: t('system:imports.title'), exact: true });
  await expect(card.getByText('Migration brand 1', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: t('system:imports.next') }).click();
  await expect(card.getByRole('alert')).toContainText(t('system:imports.failed'));
  expect(await violations(page)).toEqual([]);
  await card.getByRole('button', { name: t('system:imports.retry') }).click();
  await expect(card.getByText('Migration brand 51', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: t('system:imports.next') })).toBeDisabled();
  expired = true;
  await card.getByRole('button', { name: t('system:imports.latest') }).click();
  await expect(card.getByText('Migration brand 1', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: t('system:imports.next') }).click();
  await expect(card.getByText(t('system:imports.unavailable'), { exact: true })).toBeVisible();
  await expect(card.getByRole('table')).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

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
  await page.route('**/api/install/settings/smtp', (route) =>
    route.fulfill(json(smtpSettingsFixture())),
  );
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

    for (const card of ['api', 'worker', 'postgres', 'redis', 'smtp'] as const) {
      await expect(
        // Exact: the settings card's own region is named "Outgoing email
        // settings", which contains the health card's name.
        page.getByRole('region', { name: t(`system:cards.${card}.title`), exact: true }),
      ).toBeVisible();
    }

    // The system sender, where an operator who skipped the wizard's step edits it.
    await expect(page.getByLabel(t('system:smtp.host'))).toBeVisible();

    await expect(page.getByRole('table', { name: t('system:queues.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:channels.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:storage.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:llm.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:pending.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: t('system:audit.title') })).toBeVisible();

    // The version string is Latin in both locales (DESIGN §7).
    await expect(page.getByText('helpdock 0.1.0 · a2cf2b3 · node v24.18.0')).toBeVisible();
  });

  test('warns while no outgoing email is set up, and offers the card that fixes it (#369)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await stubSystem(page, missingSenderSystemStatus());
    await page.route('**/api/install/settings/smtp', (route) =>
      route.fulfill(
        json(
          smtpSettingsFixture({
            configured: false,
            host: '',
            user: '',
            passwordConfigured: false,
            fromAddress: '',
            fromName: '',
          }),
        ),
      ),
    );
    await signIn(page, locale);
    await page.getByRole('link', { name: new RegExp(strings(locale)('admin:nav.system')) }).click();

    // The banner names what is not being sent and anchors to the card.
    await expect(page.getByText(t('system:smtp.missingBanner'))).toBeVisible();
    await expect(
      page.getByRole('link', { name: t('system:smtp.missingBannerAction') }),
    ).toHaveAttribute('href', '#outgoing-email');

    // The health card says it in words, not only in a hue.
    const health = page.getByRole('region', {
      name: t('system:cards.smtp.title'),
      exact: true,
    });
    await expect(health.getByText(t('system:cards.smtp.notConfigured'))).toBeVisible();

    // The card the link points at carries the form, ready for the relay.
    await expect(page.getByLabel(t('system:smtp.host'))).toBeVisible();
    await expect(page.getByLabel(t('system:smtp.fromAddress'))).toHaveValue('');
    await expect(page.getByRole('button', { name: t('system:smtp.test') })).toBeVisible();

    // A warning must read as well to axe as a healthy card does.
    expect(await violations(page)).toEqual([]);
  });

  test('sends a test email against the stubbed server and draws what it said (#369)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    let sent: unknown;
    await stubSystem(page, healthySystemStatus());
    await page.route('**/api/install/settings/smtp/test', (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill(
        json({ delivered: true, response: '250 2.0.0 OK queued', recipient: 'lina@helpdock.com' }),
      );
    });
    await signIn(page, locale);
    await page.getByRole('link', { name: new RegExp(strings(locale)('admin:nav.system')) }).click();

    // The stored password is a placeholder, and it is not sent back.
    await expect(page.getByLabel(t('system:smtp.password'))).toHaveAttribute(
      'placeholder',
      t('system:smtp.passwordPlaceholder'),
    );
    await page.getByRole('button', { name: t('system:smtp.test') }).click();

    await expect(
      page.getByText(
        t('system:smtp.testDeliveredWithResponse', {
          recipient: 'lina@helpdock.com',
          response: '250 2.0.0 OK queued',
        }),
      ),
    ).toBeVisible();
    expect(sent).not.toHaveProperty('password');
    expect(await violations(page)).toEqual([]);
  });

  test('draws a rate-limited test as a wait in seconds (#369)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await stubSystem(page, healthySystemStatus());
    await page.route('**/api/install/settings/smtp/test', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'retry-after': '40' },
        body: JSON.stringify({
          error: { code: 'rate_limited', message: 'slow down', requestId: 'r' },
        }),
      }),
    );
    await signIn(page, locale);
    await page.getByRole('link', { name: new RegExp(strings(locale)('admin:nav.system')) }).click();

    await page.getByRole('button', { name: t('system:smtp.test') }).click();

    await expect(page.getByText(t('system:smtp.testRateLimited', { seconds: '40' }))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('says which variable pins a field when a save is refused, and asks for the password again (#369)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await stubSystem(page, healthySystemStatus());
    let refusal: { status: number; error: object } = {
      status: 409,
      error: { code: 'conflict', message: 'HD_SMTP_HOST locks this setting', requestId: 'r' },
    };
    await page.route('**/api/install/settings/smtp', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: refusal.status,
            contentType: 'application/json',
            body: JSON.stringify({ error: refusal.error }),
          })
        : route.fulfill(json(smtpSettingsFixture())),
    );
    await signIn(page, locale);
    await page.getByRole('link', { name: new RegExp(strings(locale)('admin:nav.system')) }).click();

    const fromName = page.getByLabel(t('system:smtp.fromName'));
    await fromName.fill('Helpdock Support');
    await page.getByRole('button', { name: t('system:smtp.save') }).click();
    await expect(
      page.getByText(t('system:smtp.pinnedSaveFailed', { envKey: 'HD_SMTP_HOST' })),
    ).toBeVisible();

    refusal = {
      status: 400,
      error: {
        code: 'validation_failed',
        message: 'type it again',
        requestId: 'r',
        setup: { reason: 'smtp-password-required' },
        fields: [{ path: 'body.password', message: 'type it again' }],
      },
    };
    await page.getByLabel(t('system:smtp.host')).fill('other.example.com');
    await page.getByRole('button', { name: t('system:smtp.save') }).click();
    await expect(page.getByText(t('system:smtp.errors.passwordRequired'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
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

  test('draws LLM spend per brand, the Postgres size, the newest migrations and who deleted a brand', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openSystem(page, locale, measuredSystemStatus());

    const llm = page.getByRole('table', { name: t('system:llm.title') });
    await expect(llm.getByRole('row').filter({ hasText: 'Acme Store' })).toContainText(
      t('system:llm.pastAlert', { percent: 86, budget: '$100.00', alert: 80 }),
    );
    await expect(llm.getByRole('row').last()).toContainText(t('system:llm.install'));
    const storage = page.getByRole('region', { name: t('system:storage.title') });
    await expect(storage.getByText(t('system:storage.postgresCaption'))).toBeVisible();
    await expect(
      page.getByRole('list', { name: t('system:versionCard.recent') }).getByRole('listitem'),
    ).toHaveText([
      '0003_outbox_notify_relay',
      '0002_tenant_rls_policies',
      '0001_app_role_and_ticket_sequences',
    ]);
    const pending = page.getByRole('region', { name: t('system:pending.title') });
    await expect(pending.getByText(/Lina Haddad/)).toBeVisible();
    await expect(pending.getByText(new RegExp(t('system:pending.removedAccount')))).toBeVisible();

    expect(await violations(page)).toEqual([]);
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
