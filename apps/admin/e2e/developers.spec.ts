import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * Developers (M8-01, M8-03; `Admin/Developers-ApiKeys`, `Admin/Developers-Webhooks`)
 * in a real browser, in both languages: creating an API key and seeing it
 * once, revoking one, adding a webhook endpoint with its secret and a test
 * ping, the refusals under the URL field, the delivery log and one delivery
 * as it was sent. Keys, URLs and headers stay left-to-right inside the Arabic
 * layout (DESIGN §7).
 */

test.use({ reducedMotion: 'reduce' });

const ACME = 'https://ops.acme-shop.com/hooks/helpdock';

/** Through the sidebar: the fixture keeps its session in memory, so a reload signs out. */
const openDevelopers = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: t('admin:nav.developers'), exact: true }).click();
  await page.getByRole('heading', { level: 1, name: t('developers:title') }).waitFor();
};

const openWebhooks = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await openDevelopers(page, locale);
  await page.getByRole('tab', { name: t('developers:tabs.webhooks') }).click();
  await page.getByRole('heading', { name: t('developers:webhooks.heading') }).waitFor();
};

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
};

test.describe('API keys', () => {
  test('creates a key, shows it once, and lists only its prefix', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openDevelopers(page, locale);

    await page
      .getByRole('button', { name: t('developers:keys.create') })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: t('developers:keys.dialog.title') });
    await dialog.getByLabel(t('developers:keys.dialog.name')).fill('Shop checkout');
    await dialog.getByRole('checkbox', { name: 'tickets:write' }).check();
    await dialog.getByRole('button', { name: t('developers:keys.dialog.submit') }).click();

    const reveal = page.getByRole('dialog', { name: t('developers:keys.reveal.title') });
    const secret = await reveal.getByLabel('Shop checkout').inputValue();
    expect(secret).toMatch(/^hd_live_/);
    await expect(reveal.getByLabel('Shop checkout')).toHaveAttribute('dir', 'ltr');
    expect(await violations(page)).toEqual([]);

    await reveal.getByRole('button', { name: t('developers:done') }).click();
    const table = page.getByRole('table', { name: t('developers:keys.tableLabel') });
    await expect(table.getByText(`${secret.slice(0, 12)}…`)).toBeVisible();
    await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  });

  test('refuses a key with no name or scope', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openDevelopers(page, locale);

    await page
      .getByRole('button', { name: t('developers:keys.create') })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: t('developers:keys.dialog.title') });
    await dialog.getByRole('button', { name: t('developers:keys.dialog.submit') }).click();

    await expect(dialog.getByText(t('developers:keys.dialog.nameRequired'))).toBeVisible();
    await expect(dialog.getByText(t('developers:keys.dialog.scopesRequired'))).toBeVisible();
    await expect(dialog.getByLabel(t('developers:keys.dialog.name'))).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  test('revokes a key behind its confirmation, and the page passes axe', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openDevelopers(page, locale);
    expect(await violations(page)).toEqual([]);

    await page
      .getByRole('button', { name: t('developers:keys.revokeLabel', { name: 'Zapier sync' }) })
      .click();
    const confirm = page.getByRole('dialog', {
      name: t('developers:keys.revokeConfirm.title', { name: 'Zapier sync' }),
    });
    await confirm.getByRole('button', { name: t('developers:keys.revokeConfirm.action') }).click();

    await expect(
      page.getByText(t('developers:keys.toast.revoked', { name: 'Zapier sync' })),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: t('developers:keys.revokeLabel', { name: 'Zapier sync' }) }),
    ).toHaveCount(0);
  });
});

test.describe('webhooks', () => {
  test('shows the turned-off banner, the log and a delivery as it was sent', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openWebhooks(page, locale);

    await expect(page.getByRole('alert')).toContainText('hooks.legacy-crm.example');
    const log = page.getByRole('table', {
      name: t('developers:webhooks.log.tableLabel', { url: ACME }),
    });
    await expect(log.getByRole('row').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('mark')).toContainText('X-Helpdock-Signature: t=');
    await expect(page.locator('pre[dir="ltr"]').first()).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('developers:webhooks.detail.replayLabel') }).click();
    await expect(page.getByText(t('developers:webhooks.toast.replayed'))).toBeVisible();
  });

  test('refuses plain http and a private address, then adds an endpoint and pings it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openWebhooks(page, locale);

    await page
      .getByRole('button', { name: t('developers:webhooks.add') })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: t('developers:webhooks.form.addTitle') });
    const url = dialog.getByLabel(t('developers:webhooks.form.url'));
    await url.fill('http://hooks.example.com/helpdock');
    await dialog.getByRole('checkbox', { name: 'ticket.created' }).check();
    await dialog.getByRole('button', { name: t('developers:webhooks.add') }).click();
    await expect(
      dialog.getByText(t('developers:webhooks.refusals.webhook-https-required')),
    ).toBeVisible();

    await url.fill('https://billing.internal.acme-shop.com/hooks');
    await dialog.getByRole('button', { name: t('developers:webhooks.add') }).click();
    await expect(dialog.getByText(/10\.0\.4\.12/)).toBeVisible();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(await violations(page)).toEqual([]);

    await url.fill('https://hooks.example.com/helpdock');
    await dialog.getByRole('button', { name: t('developers:webhooks.add') }).click();

    const reveal = page.getByRole('dialog', { name: t('developers:webhooks.created.title') });
    await expect(reveal.getByLabel(t('developers:webhooks.created.secretLabel'))).toHaveValue(
      /^whsec_/,
    );
    await reveal.getByRole('button', { name: t('developers:webhooks.test.send') }).click();
    await expect(reveal.getByRole('status').last()).toContainText('200');
    await reveal.getByRole('button', { name: t('developers:done') }).click();

    await expect(
      page.getByRole('heading', { level: 2, name: 'https://hooks.example.com/helpdock' }),
    ).toBeVisible();
  });
});
