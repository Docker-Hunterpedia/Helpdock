import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  openTicket,
  openTicketing,
  openTicketingTab,
  openTickets,
  settingsTab,
  signIn,
} from './flows.js';
import { strings } from './strings.js';

/**
 * M14-16 in a real browser, in both languages (`Admin/Ticketing-FieldFilters`):
 * the custom-field rows of the Filter popover, the chips and the saved view
 * they become, the pinned field's chip on the row and in the ticket header, and
 * the same rows in the Views tab's editor.
 *
 * The fixture's ticket fields are "Plan tier" (a select; HD-1042 is gold),
 * "Renews on" (a date) and "Order id" (text), so these specs filter by them
 * where the artboard filters by Severity.
 */

test.use({ reducedMotion: 'reduce' });

const TIER = { en: 'Plan tier', ar: 'فئة الاشتراك' } as const;
const RENEWS = { en: 'Renews on', ar: 'يتجدد في' } as const;
const ORDER_ID = { en: 'Order id', ar: 'رقم الطلب' } as const;

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const openPopover = async (page: Page, locale: 'en' | 'ar') => {
  const t = strings(locale);
  await page.getByRole('button', { name: new RegExp(`^${t('tickets:filters.open')}`) }).click();

  return page.getByRole('region', { name: t('tickets:filters.title') });
};

const addFieldFilter = async (page: Page, locale: 'en' | 'ar', field: string) => {
  const t = strings(locale);
  const popover = page.getByRole('region', { name: t('tickets:filters.title') });
  await popover.getByRole('button', { name: t('tickets:fieldFilters.add') }).click();
  await page.getByRole('menuitem', { name: field, exact: true }).click();

  return popover;
};

const rows = (page: Page) => page.getByRole('list').locator('li[data-ticket-id]');

test('pins the select field, and its value shows on the row and in the ticket header', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicketingTab(page, locale, 'custom-fields');

  await page
    .getByRole('button', { name: t('ticketing:customFields.table.select', { name: 'Plan tier' }) })
    .click();
  const pin = page.getByRole('checkbox', { name: t('ticketing:customFields.editor.pinned') });
  await expect(pin).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await pin.check();
  await page
    .getByRole('button', { name: t('ticketing:customFields.editor.save'), exact: true })
    .click();
  await expect(page.getByText(t('ticketing:customFields.pinned'), { exact: true })).toBeVisible();

  await openTickets(page, locale, 'all');
  // Only the ticket that has a value carries the chip, named by its field.
  await expect(
    rows(page).filter({ hasText: t('tickets:pinned.name', { field: TIER[locale] }) }),
  ).toHaveCount(1);
  const row = page.getByRole('link', { name: /HD-1042/ });
  await expect(row).toContainText('gold');
  expect(await violations(page)).toEqual([]);

  await row.click();
  const header = page.getByRole('region', { name: t('tickets:header.label') });
  await expect(header).toContainText('gold');
  expect(await violations(page)).toEqual([]);
});

test('unpinned, no row or header carries the chip', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale);

  await expect(page.getByRole('region', { name: t('tickets:header.label') })).not.toContainText(
    t('tickets:pinned.name', { field: TIER[locale] }),
  );
});

test('filters the list by a select field, shows the filter as a chip, and saves it as a view', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  // "My open" is where HD-1042 is: a built-in view, so the change is saved as a new one.
  await openTickets(page, locale);
  const before = await rows(page).count();
  expect(before).toBeGreaterThan(0);

  const popover = await openPopover(page, locale);
  await addFieldFilter(page, locale, TIER[locale]);
  // An option has to be chosen before the filter can be applied.
  await expect(
    popover.getByRole('button', { name: t('tickets:fieldFilters.apply') }),
  ).toBeDisabled();
  await popover.getByRole('switch', { name: 'gold' }).click();
  expect(await violations(page)).toEqual([]);
  await popover.getByRole('button', { name: t('tickets:fieldFilters.apply') }).click();
  await page.keyboard.press('Escape');

  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole('link', { name: /HD-1042/ })).toBeVisible();
  const chip = t('tickets:summary.is', { field: TIER[locale], value: 'gold' });
  await expect(
    page.getByRole('button', { name: t('tickets:viewBar.remove', { filter: chip }) }),
  ).toBeVisible();

  // A saved view keeps it.
  const bar = page.getByRole('status').filter({ hasText: t('tickets:viewBar.changed') });
  await bar.getByRole('button', { name: t('tickets:viewBar.saveAsNew') }).click();
  const dialog = page.getByRole('dialog', { name: t('tickets:viewDialog.title') });
  await expect(dialog).toContainText(chip);
  await dialog.getByLabel(t('tickets:viewDialog.name')).fill('Gold plans');
  await dialog.getByRole('button', { name: t('tickets:viewDialog.submit') }).click();
  await expect(page.getByRole('heading', { name: 'Gold plans', level: 1 })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);

  await page
    .getByRole('navigation')
    .first()
    .getByRole('link', { name: new RegExp(`^${t('tickets:views.myOpen')}`) })
    .click();
  await expect(rows(page)).toHaveCount(before);
  await page
    .getByRole('navigation')
    .first()
    .getByRole('link', { name: /^Gold plans/ })
    .click();
  await expect(rows(page)).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: t('tickets:viewBar.remove', { filter: chip }) }),
  ).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('says why a filter cannot be applied yet, and what an empty result means', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  const before = await rows(page).count();

  const popover = await openPopover(page, locale);
  await addFieldFilter(page, locale, RENEWS[locale]);
  const apply = popover.getByRole('button', { name: t('tickets:fieldFilters.apply') });
  // A range that ends before it starts is not a filter.
  await popover
    .getByLabel(t('tickets:fieldFilters.from', { field: RENEWS[locale] }))
    .fill('2026-06-01');
  await popover
    .getByLabel(t('tickets:fieldFilters.to', { field: RENEWS[locale] }))
    .fill('2026-01-01');
  await expect(apply).toBeDisabled();
  await expect(popover.getByRole('status')).toHaveText(t('tickets:fieldFilters.incomplete'));
  expect(await violations(page)).toEqual([]);

  await popover
    .getByRole('button', { name: t('tickets:fieldFilters.remove', { field: RENEWS[locale] }) })
    .click();
  await addFieldFilter(page, locale, ORDER_ID[locale]);
  await popover
    .getByLabel(t('tickets:fieldFilters.valueOf', { field: ORDER_ID[locale] }))
    .fill('zzz-no-such-order');
  await apply.click();
  await page.keyboard.press('Escape');

  await expect(
    page.getByRole('heading', { name: t('tickets:empty.filteredHeading') }),
  ).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // The chip takes it off again.
  const chip = t('tickets:summary.fieldContains', {
    field: ORDER_ID[locale],
    value: 'zzz-no-such-order',
  });
  await page.getByRole('button', { name: t('tickets:viewBar.remove', { filter: chip }) }).click();
  await expect(rows(page)).toHaveCount(before);
});

test('puts the same rows in the Views tab’s editor and prints them in the "Shows" column', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicketing(page, locale);
  await settingsTab(page, t, 'ticketing:tabs.views').click();
  await page.getByRole('button', { name: t('ticketing:views.add'), exact: true }).click();

  const card = page.getByRole('form', { name: t('ticketing:views.editor.newHeading') });
  await card.getByLabel(t('ticketing:views.editor.name'), { exact: true }).fill('Gold, shared');
  await card.getByRole('button', { name: t('tickets:fieldFilters.add') }).click();
  await page.getByRole('menuitem', { name: TIER[locale], exact: true }).click();
  await card.getByRole('switch', { name: 'gold' }).click();
  expect(await violations(page)).toEqual([]);
  await card.getByRole('button', { name: t('ticketing:views.editor.create') }).click();

  const row = page.getByRole('row').filter({ hasText: 'Gold, shared' });
  await expect(row).toContainText(t('tickets:summary.is', { field: TIER[locale], value: 'gold' }));
});

test('stacks a row in the Views tab’s narrow card, so the value keeps room and nothing scrolls sideways', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicketing(page, locale);
  await settingsTab(page, t, 'ticketing:tabs.views').click();
  await page.getByRole('button', { name: t('ticketing:views.add'), exact: true }).click();

  const card = page.getByRole('form', { name: t('ticketing:views.editor.newHeading') });
  await card.getByRole('button', { name: t('tickets:fieldFilters.add') }).click();
  await page.getByRole('menuitem', { name: ORDER_ID[locale], exact: true }).click();

  // The card is about 300 px wide: one cell of a four-column row would be ~20 px.
  const value = card.getByLabel(t('tickets:fieldFilters.valueOf', { field: ORDER_ID[locale] }));
  expect((await value.boundingBox())?.width ?? 0).toBeGreaterThan(150);
  expect(await card.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(false);
  expect(await violations(page)).toEqual([]);
});
