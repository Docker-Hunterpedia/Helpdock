import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-04 in a real browser, in both languages (`Admin/Tickets-Bulk`): ticking
 * with the boxes, `x`, `Shift`+`x` and Shift-click, the header checkbox, the
 * bar, an edit that applies at once and its Undo, the preview that lists what
 * cannot change, and the `bulk-changed` re-preview. The rules are unit-tested
 * (`src/tickets/selection.test.ts`, `bulk.test.ts`); the 429 is a component test
 * because the fixture's budget is twenty applies a minute.
 */

test.use({ reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const rowOf = (page: Page, reference: string): Locator =>
  page.locator('li[data-ticket-id]').filter({ hasText: reference });

const boxOf = (page: Page, locale: 'en' | 'ar', reference: string): Locator =>
  page.getByRole('checkbox', { name: strings(locale)('tickets:bulk.selectRow', { reference }) });

test('ticks with the boxes, Shift-click, x and Shift+x, and Esc clears', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  const bar = page.getByRole('toolbar', { name: t('tickets:bulk.bar.label') });
  const rows = page.locator('li[data-ticket-id]');
  const total = await rows.count();
  expect(total).toBeGreaterThanOrEqual(5);

  // The first box opens the bar.
  await expect(bar).toHaveCount(0);
  await rows.nth(0).getByRole('checkbox').click();
  await expect(bar).toContainText(t('tickets:bulk.bar.count', { count: 1 }));
  expect(await violations(page)).toEqual([]);

  // Shift-click ticks everything between the last one ticked and this row.
  await rows
    .nth(3)
    .getByRole('checkbox')
    .click({ modifiers: ['Shift'] });
  await expect(bar).toContainText(t('tickets:bulk.bar.count', { count: 4 }));
  for (const index of [0, 1, 2, 3]) {
    await expect(rows.nth(index).getByRole('checkbox')).toBeChecked();
  }

  // The header is checked when the whole page is, mixed when some are.
  const header = page.getByRole('checkbox', { name: t('tickets:bulk.selectAll') });
  await expect(header).toHaveJSProperty('indeterminate', true);
  await header.click();
  await expect(bar).toContainText(t('tickets:bulk.bar.count', { count: total }));
  await expect(header).toBeChecked();
  await header.click();
  await expect(bar).toHaveCount(0);

  // `x` ticks the open ticket's row and `Shift`+`x` the range from it.
  await page.getByRole('link', { name: /HD-1042/ }).click();
  await expect(rows.nth(0).getByRole('link')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('x');
  await expect(rowOf(page, 'HD-1042').getByRole('checkbox')).toBeChecked();
  await page.keyboard.press('j');
  await expect(rows.nth(1).getByRole('link')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('j');
  await expect(rows.nth(2).getByRole('link')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Shift+x');
  await expect(bar).toContainText(t('tickets:bulk.bar.count', { count: 3 }));

  // Esc clears and says so.
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(rows.nth(0).getByRole('checkbox')).not.toBeChecked();
});

test('applies at once when every ticket would change, and Undo puts it back', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  await boxOf(page, locale, 'HD-1042').click();
  await boxOf(page, locale, 'HD-1041').click();
  const bar = page.getByRole('toolbar', { name: t('tickets:bulk.bar.label') });

  const priorityOf = (priority: 'urgent' | 'low') =>
    t('tickets:list.priority', { priority: t(`tickets:priority.${priority}`) });
  const link = rowOf(page, 'HD-1042').getByRole('link');
  await expect(link).toContainText(priorityOf('urgent'));

  await bar.getByRole('button', { name: t('tickets:bulk.bar.more') }).click();
  await page.getByRole('menuitem', { name: t('tickets:bulk.bar.priority') }).click();
  await page.getByRole('menuitem', { name: t('tickets:priority.low'), exact: true }).click();

  // Applied without a dialog: the toast is the whole answer.
  const toast = page
    .getByRole('status')
    .filter({ hasText: t('tickets:bulk.toast.changed', { count: 2 }) });
  await expect(toast).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(bar).toHaveCount(0);
  await expect(link).toContainText(priorityOf('low'));
  expect(await violations(page)).toEqual([]);

  await toast.getByRole('button', { name: t('tickets:bulk.toast.undo') }).click();
  await expect(
    page.getByRole('status').filter({ hasText: t('tickets:bulk.undo.done', { count: 2 }) }),
  ).toBeVisible();
  await expect(link).toContainText(priorityOf('urgent'));
});

test('lists what cannot change before a close, and closes only the rest', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  // HD-1030 is closed already, so it will not change.
  await boxOf(page, locale, 'HD-1042').click();
  await boxOf(page, locale, 'HD-1041').click();
  await boxOf(page, locale, 'HD-1030').click();
  await page
    .getByRole('toolbar', { name: t('tickets:bulk.bar.label') })
    .getByRole('button', { name: t('tickets:bulk.bar.close'), exact: true })
    .click();

  const dialog = page.getByRole('dialog', {
    name: t('tickets:bulk.dialog.titleClose', { count: 3 }),
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    t('tickets:bulk.dialog.summaryClose', { count: 3, willChange: 2 }),
  );
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('listitem')).toContainText('HD-1030');
  await expect(dialog.getByRole('listitem')).toContainText(t('tickets:bulk.reason.unchangedClose'));
  expect(await violations(page)).toEqual([]);

  await dialog
    .getByRole('button', { name: t('tickets:bulk.dialog.confirmClose', { n: 2 }) })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: t('tickets:bulk.toast.close', { count: 2 }) }),
  ).toBeVisible();
  // Out of focus order: the selection is gone and focus is back on the list.
  await expect(page.getByRole('toolbar', { name: t('tickets:bulk.bar.label') })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: t('tickets:bulk.selectAll') })).toBeFocused();
});

test('Undo last bulk change is in the command palette after the toast has gone', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  await boxOf(page, locale, 'HD-1042').click();
  await page
    .getByRole('toolbar', { name: t('tickets:bulk.bar.label') })
    .getByRole('button', { name: t('tickets:bulk.bar.close'), exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: t('tickets:bulk.toast.close', { count: 1 }) }),
  ).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: t('admin:palette.label') });
  await palette.getByRole('combobox').fill(t('admin:palette.actions.undoBulk'));
  await palette
    .getByRole('option', { name: t('admin:palette.actions.undoBulk'), exact: true })
    .click();

  await expect(
    page.getByRole('status').filter({ hasText: t('tickets:bulk.undo.done', { count: 1 }) }),
  ).toBeVisible();
});

test('previews again when something changed meanwhile, and shows the list as it now is', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  // While this close is in flight a colleague closes HD-1035 (the fixture's one scripted race).
  await boxOf(page, locale, 'HD-1042').click();
  await boxOf(page, locale, 'HD-1035').click();
  await page
    .getByRole('toolbar', { name: t('tickets:bulk.bar.label') })
    .getByRole('button', { name: t('tickets:bulk.bar.close'), exact: true })
    .click();

  const dialog = page.getByRole('dialog', {
    name: t('tickets:bulk.dialog.titleClose', { count: 2 }),
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText(t('tickets:bulk.dialog.refreshed'));
  await expect(dialog.getByRole('listitem')).toContainText('HD-1035');
  await expect(dialog.getByRole('listitem')).toContainText(t('tickets:bulk.reason.unchangedClose'));
  expect(await violations(page)).toEqual([]);

  await dialog
    .getByRole('button', { name: t('tickets:bulk.dialog.confirmClose', { n: 1 }) })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: t('tickets:bulk.toast.close', { count: 1 }) }),
  ).toBeVisible();
});

test('keeps the bar inside the list column, clear of the open ticket’s composer', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTickets(page, locale, 'all');
  await page.getByRole('link', { name: /HD-1042/ }).click();
  const composer = page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') });
  await composer.waitFor();
  await boxOf(page, locale, 'HD-1041').click();
  const bar = page.getByRole('toolbar', { name: t('tickets:bulk.bar.label') });
  await expect(bar).toBeVisible();

  const list = await page.getByRole('region', { name: t('tickets:list.label') }).boundingBox();
  const bounds = await bar.boundingBox();
  const writing = await composer.boundingBox();
  if (list === null || bounds === null || writing === null) {
    throw new Error('the list, the bar and the composer are all on screen');
  }
  // Inside the column, so beside the composer and never over it.
  expect(bounds.x).toBeGreaterThanOrEqual(list.x - 1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(list.x + list.width + 1);
  const apart =
    bounds.x + bounds.width <= writing.x ||
    writing.x + writing.width <= bounds.x ||
    bounds.y + bounds.height <= writing.y ||
    writing.y + writing.height <= bounds.y;
  expect(apart).toBe(true);
});

for (const width of [1280, 768]) {
  test(`fits the actions on one row under the count, at ${String(width)} px`, async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');
    await page.setViewportSize({ width, height: 800 });
    await boxOf(page, locale, 'HD-1042').click();
    const bar = page.getByRole('toolbar', { name: t('tickets:bulk.bar.label') });
    await expect(bar).toBeVisible();

    // Two rows: every action button on one line, the count and Clear on the other.
    const tops = await Promise.all(
      ['status', 'close', 'assign', 'snooze', 'more'].map(async (name) => {
        const box = await bar
          .getByRole('button', { name: t(`tickets:bulk.bar.${name}` as 'tickets:bulk.bar.more') })
          .boundingBox();
        return box?.y ?? Number.NaN;
      }),
    );
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(2);
    const clear = await bar
      .getByRole('button', { name: t('tickets:bulk.bar.clear') })
      .boundingBox();
    expect(clear?.y ?? Number.NaN).toBeLessThan(Math.min(...tops));
  });
}
