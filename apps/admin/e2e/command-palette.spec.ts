import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_ROLE_STORAGE, MOCK_SINGLE_KEY_STORAGE } from '../src/auth/mock-api.js';
import { MOCK_QUICK_SEARCH_FAIL_STORAGE } from '../src/palette/api.js';
import { MOCK_TICKET_REFUND } from '../src/tickets/mock-api.js';
import { expect, test } from './fixtures.js';
import { openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-05 in a real browser, in both languages (`Admin/CommandPalette`): ⌘K,
 * finding by number and by a setting's name in Arabic, the arrows, a section
 * that fails, the Viewer, and the single-key switch. The rules are unit-tested
 * (`apps/admin/src/palette`).
 */

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const seed = async (page: Page, key: string, value: string): Promise<void> => {
  await page.addInitScript(
    ([storageKey, storageValue]) => {
      window.localStorage.setItem(storageKey as string, storageValue as string);
    },
    [key, value],
  );
};

test.use({ reducedMotion: 'reduce' });

test.describe('the command palette', () => {
  test('finds a ticket by its number, passes axe, and Enter opens it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    await page.keyboard.press('ControlOrMeta+k');

    const dialog = page.getByRole('dialog', { name: t('admin:palette.label') });
    const input = dialog.getByRole('combobox');
    await expect(input).toBeFocused();
    await input.fill('1042');

    const first = dialog.getByRole('option').first();
    await expect(first).toContainText('HD-1042');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute(
      'aria-activedescendant',
      (await first.getAttribute('id')) ?? '',
    );
    expect(await violations(page)).toEqual([]);

    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(new RegExp(MOCK_TICKET_REFUND));
    await expect(dialog).toBeHidden();
  });

  test('finds a settings page by its Arabic name in either language', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);

    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: t('admin:palette.label') });
    await dialog.getByRole('combobox').fill('اتفاقية مستوى الخدمة');

    const title = `${t('admin:settings.groups.inbox')} › ${t('admin:settings.entries.slas')}`;
    await expect(dialog.getByRole('option', { name: title })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/settings\/inbox\/slas$/);
  });

  test('moves with the arrows, and Esc closes and returns focus to where it was', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');
    const opener = page.getByRole('link', { name: /HD-1042/ }).first();
    await opener.focus();

    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: t('admin:palette.label') });
    const input = dialog.getByRole('combobox');
    await input.fill('invoice');
    await expect(dialog.getByRole('option').nth(1)).toBeVisible();

    await page.keyboard.press('ArrowDown');
    const second = dialog.getByRole('option').nth(1);
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute(
      'aria-activedescendant',
      (await second.getAttribute('id')) ?? '',
    );
    await expect(input).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('keeps Tab inside the dialog', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);

    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: t('admin:palette.label') });
    await dialog.getByRole('combobox').fill('invoice');
    for (let press = 0; press < 4; press += 1) {
      await page.keyboard.press('Tab');
    }

    await expect(dialog.locator(':focus')).toHaveCount(1);
  });

  test('replaces a failed section with a notice and a retry, and the others still show', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, MOCK_QUICK_SEARCH_FAIL_STORAGE, 'articles');
    await signIn(page, locale);

    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: t('admin:palette.label') });
    await dialog.getByRole('combobox').fill('invoice');

    const notice = dialog.getByRole('status').filter({
      hasText: t('admin:palette.failed', { section: t('admin:palette.groups.articles') }),
    });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: t('admin:palette.retry') })).toBeVisible();
    await expect(dialog.getByRole('option', { name: /HD-/ }).first()).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('offers a Viewer navigation only and says the rest is not listed', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, MOCK_ROLE_STORAGE, 'viewer');
    await signIn(page, locale);

    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: t('admin:palette.label') });
    await dialog.getByRole('combobox').fill(t('tickets:keyboard.shortcut.general.newTicket'));

    await expect(dialog.getByText(t('admin:palette.viewerNote'))).toBeVisible();
    await expect(
      dialog.getByRole('option', { name: t('admin:palette.actions.general.newTicket') }),
    ).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });

  test('draws an action’s single-key cap only while single-key shortcuts are on', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: t('admin:palette.label') });
    const newTicket = dialog.getByRole('option', {
      name: t('admin:palette.actions.general.newTicket'),
    });
    await expect(newTicket.locator('kbd')).toHaveText('c');
  });

  test('draws no single-key cap once the account has them off', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, MOCK_SINGLE_KEY_STORAGE, 'off');
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: t('admin:palette.label') });
    const newTicket = dialog.getByRole('option', {
      name: t('admin:palette.actions.general.newTicket'),
    });
    await expect(newTicket).toBeVisible();
    await expect(newTicket.locator('kbd')).toHaveCount(0);
  });

  test('opens from the sidebar’s Search, expanded and collapsed to the rail', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    const dialog = page.getByRole('dialog', { name: t('admin:palette.label') });
    const search = page.getByRole('button', {
      name: t('admin:palette.sidebarSearch'),
      exact: true,
    });

    await expect(search.locator('kbd').first()).toBeVisible();
    await search.click();
    await expect(dialog.getByRole('combobox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(search).toBeFocused();

    await page.getByRole('button', { name: t('admin:nav.collapse') }).click();
    await expect(search.locator('kbd')).toHaveCount(0);
    await search.click();
    await expect(dialog).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});
