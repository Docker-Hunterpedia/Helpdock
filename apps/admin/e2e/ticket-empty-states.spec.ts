import { MOCK_SINGLE_KEY_STORAGE } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-06 (`Admin/Tickets-Empty`), in both languages: what an empty ticket
 * view says, the keyboard hints under it, and that they go with the
 * single-key switch.
 */

test.describe('empty ticket views', () => {
  test('a search that matches nothing names the term, hints at the keys, and Clear search returns', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);

    const search = page.getByRole('searchbox', { name: t('tickets:list.searchLabel') });
    await search.fill('invoice 88');
    await expect(
      page.getByRole('heading', { name: t('tickets:empty.searchHeading', { term: 'invoice 88' }) }),
    ).toBeVisible();

    const hints = page.getByRole('list', { name: t('tickets:keyboard.hintsLabel') });
    await expect(hints.getByRole('listitem')).toHaveCount(3);
    await expect(hints).toContainText(t('tickets:keyboard.shortcut.general.newTicket'));
    await expect(hints).toContainText(t('tickets:keyboard.shortcut.goTo.unassigned'));
    // The caps keep their Latin letters and left-to-right order in Arabic.
    await expect(hints.locator('kbd')).toHaveText(['c', 'g', 'u', '?']);
    await expect(hints.locator('[dir="ltr"]').first()).toBeVisible();

    await page.getByRole('button', { name: t('tickets:empty.clearSearch') }).click();
    await expect(search).toHaveValue('');
    await expect(
      page.getByRole('heading', { name: t('tickets:empty.searchHeading', { term: 'invoice 88' }) }),
    ).toBeHidden();
  });

  test('"All shortcuts" shows a focus ring on keyboard focus', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);
    await page
      .getByRole('searchbox', { name: t('tickets:list.searchLabel') })
      .fill('nothing at all');

    const button = page
      .getByRole('list', { name: t('tickets:keyboard.hintsLabel') })
      .getByRole('button', { name: t('tickets:keyboard.shortcut.general.shortcuts') });
    await button.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');

    await expect(button).toBeFocused();
    await expect(button).toHaveCSS('outline-style', 'solid');
    await expect(button).toHaveCSS('outline-width', '2px');
  });

  test('"All shortcuts" opens the sheet', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);
    await page
      .getByRole('searchbox', { name: t('tickets:list.searchLabel') })
      .fill('nothing at all');

    await page
      .getByRole('list', { name: t('tickets:keyboard.hintsLabel') })
      .getByRole('button', { name: t('tickets:keyboard.shortcut.general.shortcuts') })
      .click();

    await expect(page.getByRole('dialog', { name: t('tickets:keyboard.label') })).toBeVisible();
  });

  test('filters that exclude everything say so, and Edit filters opens them', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    // A filter set the fixture holds no ticket for, arrived at the way a shared link does.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/tickets?view=all&custom=1&priority=low&state=escalated');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await expect(
      page.getByRole('heading', { name: t('tickets:empty.filteredHeading') }),
    ).toBeVisible();
    await page.getByRole('button', { name: t('tickets:empty.editFilters') }).click();
    await expect(page.getByRole('region', { name: t('tickets:filters.title') })).toBeVisible();
  });

  test('draws no hints while single-key shortcuts are off', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, 'off');
    }, MOCK_SINGLE_KEY_STORAGE);
    await signIn(page, locale);
    await openTickets(page, locale);
    await page
      .getByRole('searchbox', { name: t('tickets:list.searchLabel') })
      .fill('nothing at all');

    await expect(page.getByRole('button', { name: t('tickets:empty.clearSearch') })).toBeVisible();
    await expect(page.getByRole('list', { name: t('tickets:keyboard.hintsLabel') })).toBeHidden();
  });
});
