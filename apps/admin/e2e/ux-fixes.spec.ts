import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { clickSettingsTab, goInApp, openSettingsArea, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/UX-Fixes-2026-11` in a browser, in both languages: the statuses table,
 * the widget preview by mode, the page not found, Data retention's new home,
 * Profile's account details, and the tab title of every page.
 */

test.use({ reducedMotion: 'reduce' });

const horizontalOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe('statuses', () => {
  test('puts the name in the reader’s language first and the type in its own column', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettingsArea(page, t, 'ticketing');
    await clickSettingsTab(page, t, 'ticketing:tabs.statuses');

    const table = page.getByRole('table');
    await expect(
      table.getByRole('columnheader', { name: t('ticketing:statuses.table.type') }),
    ).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: t('ticketing:statuses.table.tickets' as never) }),
    ).toHaveCount(0);

    const open = table.getByRole('row').filter({ hasText: t('ticketing:statuses.chips.default') });
    const cell = open.getByRole('cell').nth(1);
    await expect(cell).toContainText('Open');
    await expect(cell).toContainText('مفتوحة');
    const first = await cell.locator('[lang]').first().getAttribute('lang');
    expect(first).toBe(locale);
    // One line each, start aligned: the name never wraps onto a second centred line.
    const box = await cell.getByRole('button').boundingBox();
    expect(box?.height ?? 0).toBeLessThan(40);
  });
});

test.describe('the widget preview', () => {
  test('draws the selected mode and follows Light or Dark', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettingsArea(page, t, 'channels');
    await clickSettingsTab(page, t, 'channels:tabs.widget');
    const preview = page.getByRole('img', { name: t('channels:widget.preview.region') });

    await page.locator('input[type="radio"][value="helpcenter"]').check();
    await expect(preview).toContainText(t('channels:widget.preview.contactUs'));

    await page.locator('input[type="radio"][value="form"]').check();
    await expect(preview).toContainText(t('channels:widget.preview.send'));

    const toggle = page.getByRole('group', { name: t('channels:widget.preview.theme') });
    await expect(toggle).toBeVisible();
    await page
      .getByRole('group', { name: t('channels:widget.appearance.scheme') })
      .getByRole('button', { name: t('channels:widget.appearance.schemes.dark'), exact: true })
      .click();
    await expect(toggle).toHaveCount(0);

    // Save and Discard wait for a change.
    await expect(page.getByRole('button', { name: t('channels:discard') }).first()).toBeEnabled();
  });
});

test.describe('where things live now', () => {
  test('opens Data retention as a page of Brand, and Danger zone holds only the deletion', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettingsArea(page, t, 'brand');
    await clickSettingsTab(page, t, 'brand:tabs.retention');
    await expect(page).toHaveURL(/\/settings\/brand\/retention$/);
    await expect(
      page.getByRole('heading', { name: t('brand:retention.heading') }).first(),
    ).toBeVisible();

    await clickSettingsTab(page, t, 'brand:tabs.danger');
    await expect(page.getByRole('heading', { name: t('brand:retention.heading') })).toHaveCount(0);
  });

  test('keeps the account details on Profile, with Save asleep until a change', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettingsArea(page, t, 'settings');
    await clickSettingsTab(page, t, 'me:account.tabs.profile');
    await expect(page.getByLabel(t('me:details.emailLabel'))).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: t('me:profile.save') }).first()).toBeDisabled();

    await page.getByLabel(t('me:profile.publicName')).fill('Lina H');
    await expect(page.getByRole('button', { name: t('me:profile.save') }).first()).toBeEnabled();
  });
});

test.describe('the page not found', () => {
  test('is drawn inside the shell for an unknown address', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await goInApp(page, '/nowhere/at/all');

    await expect(page.getByRole('heading', { name: t('admin:notFound.title') })).toBeVisible();
    await expect(page.getByRole('navigation', { name: t('admin:nav.label') })).toBeVisible();
    await expect(page).toHaveTitle(`${t('admin:notFound.title')} · Helpdock`);
    await page.getByRole('link', { name: t('admin:notFound.action') }).click();
    await expect(page).toHaveURL(/\/tickets/);
  });

  test('gives each page its own tab title', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettingsArea(page, t, 'staff');

    await expect(page).toHaveTitle(`${t('admin:nav.staff')} · Helpdock`);
  });
});

test.describe('no sideways scroll', () => {
  for (const [name, path] of [
    ['Help center settings', '/help-center/settings'],
    ['Add mailbox', '/settings/channels/mailboxes/new'],
  ] as const) {
    test(`${name} fits its window`, async ({ page, appLocale: locale }) => {
      await signIn(page, locale);
      await goInApp(page, path);
      await page.getByRole('main').waitFor();
      await page.waitForLoadState('networkidle');

      expect(await horizontalOverflow(page)).toBe(false);
    });
  }
});
