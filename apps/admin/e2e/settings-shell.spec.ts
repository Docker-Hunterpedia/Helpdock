import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_ROLE_STORAGE } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { fillSignIn, openSettingsArea, settingsTab, signIn, submitTotp } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Settings-Shell` (M14-21) in a browser, in both languages: the single
 * Settings entry, the grouped navigation, an old address landing in it, what a
 * lower role does not see, and the keyboard. The board defines no layout below
 * 900 px, so none is asserted.
 */

test.use({ reducedMotion: 'reduce' });

const seed = async (page: Page, key: string, value: string): Promise<void> => {
  await page.addInitScript(
    ([storageKey, storageValue]) => {
      window.localStorage.setItem(storageKey as string, storageValue as string);
    },
    [key, value],
  );
};

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
};

test.describe('the Settings area', () => {
  test('opens from one sidebar entry and moves between groups', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    const sidebar = page.getByRole('navigation', { name: t('admin:nav.label') });

    await expect(sidebar.getByRole('link', { name: t('admin:nav.system') })).toHaveCount(0);
    await sidebar.getByRole('link', { name: t('admin:nav.settings'), exact: true }).click();

    // Settings opens on the first page the person has: Your account › Profile.
    const nav = page.getByRole('navigation', { name: t('admin:settings.navLabel') });
    await expect(page).toHaveURL(/\/settings\/account\/profile$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t('me:account.tabs.profile'));
    await expect(
      page.getByText(`${t('admin:nav.settings')} › ${t('admin:settings.groups.account')}`),
    ).toBeVisible();

    for (const [area, group, heading] of [
      ['ticketing', 'inbox', t('ticketing:tabs.departments')],
      ['channels', 'channels', t('admin:settings.entries.mailboxes')],
      ['developers', 'developers', t('developers:tabs.apiKeys')],
      ['system', 'install', t('admin:nav.system')],
    ] as const) {
      await openSettingsArea(page, t, area);

      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(
        page.getByText(`${t('admin:nav.settings')} › ${t(`admin:settings.groups.${group}`)}`),
      ).toBeVisible();
      await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
    }

    await settingsTab(page, t, 'ticketing:tabs.slas').click();
    await expect(page).toHaveURL(/\/settings\/inbox\/slas$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      t('admin:settings.entries.slas'),
    );
  });

  test('sends an old address, with its query string, to its new home', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    // A fresh navigation signs the in-memory fixture out, so sign in through
    // the redirect the way a person following a bookmark would.
    await page.goto('/admin/ticketing/slas?from=bookmark');
    await expect(page).toHaveURL(/returnTo=%2Fsettings%2Finbox%2Fslas%3Ffrom%3Dbookmark/);

    await fillSignIn(page, locale);
    await submitTotp(page, locale);

    await expect(page).toHaveURL(/\/settings\/inbox\/slas\?from=bookmark$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      t('admin:settings.entries.slas'),
    );
  });

  test('leaves out what a Team Leader cannot open', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await seed(page, MOCK_ROLE_STORAGE, 'teamLeader');
    await signIn(page, locale);
    await page
      .getByRole('navigation', { name: t('admin:nav.label') })
      .getByRole('link', { name: t('admin:nav.settings'), exact: true })
      .click();
    const nav = page.getByRole('navigation', { name: t('admin:settings.navLabel') });

    await expect(
      nav.getByRole('link', { name: t('ticketing:tabs.views'), exact: true }),
    ).toBeVisible();
    await expect(nav.getByRole('link', { name: t('admin:nav.staff'), exact: true })).toBeVisible();
    for (const hidden of [
      t('brand:tabs.general'),
      t('developers:tabs.apiKeys'),
      t('admin:nav.system'),
      t('admin:settings.entries.mailboxes'),
      t('aiSettings:tabs.providers'),
    ]) {
      await expect(nav.getByRole('link', { name: hidden, exact: true })).toHaveCount(0);
    }
  });

  test('leaves a Viewer with their own account', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await seed(page, MOCK_ROLE_STORAGE, 'viewer');
    await signIn(page, locale);
    await page
      .getByRole('navigation', { name: t('admin:nav.label') })
      .getByRole('link', { name: t('admin:nav.settings'), exact: true })
      .click();
    const nav = page.getByRole('navigation', { name: t('admin:settings.navLabel') });

    await expect(nav.getByRole('link')).toHaveCount(4);
    await expect(
      nav.getByRole('link', { name: t('me:account.tabs.security'), exact: true }),
    ).toBeVisible();
  });

  test('puts the navigation at the inline start and is reachable with the keyboard', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettingsArea(page, t, 'ticketing');
    const nav = page.getByRole('navigation', { name: t('admin:settings.navLabel') });
    const main = page.getByRole('heading', { level: 1 });

    // The page re-renders as its data arrives, so the boxes are read until they hold.
    await expect(async () => {
      const navBox = await nav.boundingBox();
      const mainBox = await main.boundingBox();
      expect(navBox).not.toBeNull();
      expect(mainBox).not.toBeNull();
      // The navigation sits beside the sidebar, before the page in reading order.
      expect(
        locale === 'ar'
          ? (navBox?.x ?? 0) > (mainBox?.x ?? 0)
          : (navBox?.x ?? 0) < (mainBox?.x ?? 0),
      ).toBe(true);
    }).toPass();

    const target = nav.getByRole('link', { name: t('ticketing:tabs.statuses'), exact: true });
    await target.focus();
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings\/inbox\/statuses$/);
    await expect(nav.locator('a[aria-current="page"]')).toHaveText(t('ticketing:tabs.statuses'));
  });

  test('has no accessibility violations', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettingsArea(page, t, 'ticketing');
    await settingsTab(page, t, 'ticketing:tabs.slas').click();
    await page.getByRole('heading', { level: 1, name: t('admin:settings.entries.slas') }).waitFor();

    expect(await violations(page)).toEqual([]);
  });
});
