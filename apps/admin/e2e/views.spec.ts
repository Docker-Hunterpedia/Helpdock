import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicketing, openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * Saved views in a real browser, in both languages (M1-05): the sidebar group
 * and its menu, the "Filters changed" bar, "Save as a view", and the Views tab
 * of `Admin/Ticketing` (`Admin/View-Dialogs`, `Admin/Ticketing-Views`).
 *
 * What a browser adds over the unit suite is a ⋯ button that appears on real
 * hover and focus, dialogs the browser really focuses, an Arabic layout that is
 * a different layout rather than the same one mirrored, and axe over each.
 */

// DESIGN §4: reduced motion drops every duration to zero, so axe reads a
// dialog at its final colours rather than halfway through its fade.
test.use({ reducedMotion: 'reduce' });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

const nav = (page: Page) => page.getByRole('navigation').first();

/** Toggles one chip in the filter popover and closes it again. */
const toggleFilter = async (page: Page, locale: 'en' | 'ar', chip: string): Promise<void> => {
  const t = strings(locale);
  await page.getByRole('button', { name: new RegExp(`^${t('tickets:filters.open')}`) }).click();
  await page.getByRole('switch', { name: chip, exact: true }).click();
  await page.keyboard.press('Escape');
};

test.describe('views in the sidebar', () => {
  test('lists the shared views, then the reader’s own under "Mine"', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);

    await expect(nav(page).getByRole('link', { name: /^VIP refunds|^استرداد/ })).toBeVisible();
    await expect(nav(page).getByText(t('tickets:views.mine'), { exact: true })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /^Urgent, mine/ })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('saves changed filters as a new view and opens it', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);

    await toggleFilter(page, locale, t('tickets:priority.urgent'));
    const bar = page.getByRole('status').filter({ hasText: t('tickets:viewBar.changed') });
    await expect(bar).toBeVisible();
    // "My open" is built in: its filters never change, so there is no Save.
    await expect(
      bar.getByRole('button', { name: t('tickets:viewBar.save'), exact: true }),
    ).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    await bar.getByRole('button', { name: t('tickets:viewBar.saveAsNew') }).click();
    const dialog = page.getByRole('dialog', { name: t('tickets:viewDialog.title') });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: t('tickets:viewDialog.submit') }),
    ).toBeDisabled();
    expect(await violations(page)).toEqual([]);

    await dialog.getByLabel(t('tickets:viewDialog.name')).fill('Urgent and open');
    await dialog.getByRole('button', { name: t('tickets:viewDialog.submit') }).click();

    await expect(page.getByRole('heading', { name: 'Urgent and open', level: 1 })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /^Urgent and open/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByText(t('tickets:viewBar.changed'))).toHaveCount(0);
  });

  test('resets a changed view back to what it saves', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);
    await nav(page)
      .getByRole('link', { name: /^Urgent, mine/ })
      .click();
    await page.getByRole('heading', { name: 'Urgent, mine', level: 1 }).waitFor();

    await toggleFilter(page, locale, t('tickets:priority.high'));
    const bar = page.getByRole('status').filter({ hasText: t('tickets:viewBar.changed') });
    await expect(
      bar.getByRole('button', { name: t('tickets:viewBar.save'), exact: true }),
    ).toBeVisible();
    await bar.getByRole('button', { name: t('tickets:viewBar.reset') }).click();

    await expect(page.getByText(t('tickets:viewBar.changed'))).toHaveCount(0);
  });

  test('renames a personal view from its menu', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);

    const link = nav(page).getByRole('link', { name: /^Urgent, mine/ });
    await link.hover();
    await nav(page)
      .getByRole('button', { name: t('tickets:views.actions', { name: 'Urgent, mine' }) })
      .click();
    await page.getByRole('menuitem', { name: t('tickets:views.rename') }).click();
    const dialog = page.getByRole('dialog', {
      name: t('tickets:viewDialog.renameTitle', { name: 'Urgent, mine' }),
    });
    await dialog.getByLabel(t('tickets:viewDialog.name')).fill('Hot, mine');
    await dialog.getByRole('button', { name: t('tickets:viewDialog.renameSubmit') }).click();

    await expect(nav(page).getByRole('link', { name: /^Hot, mine/ })).toBeVisible();
  });
});

test.describe('the Views tab', () => {
  const openViews = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);
    await page.getByRole('tab', { name: t('ticketing:tabs.views') }).click();
    await page.getByRole('button', { name: t('ticketing:views.add'), exact: true }).waitFor();
  };

  test('lists the shared views and edits a built-in one’s name only', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openViews(page, locale);
    expect(await violations(page)).toEqual([]);

    const overdue = t('tickets:views.overdue');
    await page
      .getByRole('button', { name: t('ticketing:views.table.select', { name: overdue }) })
      .click();
    const card = page.getByRole('form', {
      name: t('ticketing:views.editor.heading', { name: overdue }),
    });
    await expect(card.getByLabel(t('ticketing:views.editor.state'))).toBeDisabled();
    await expect(
      card.getByRole('button', { name: t('ticketing:views.editor.delete') }),
    ).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    await card.getByLabel(t('ticketing:views.editor.name'), { exact: true }).fill('Late');
    await card.getByRole('button', { name: t('ticketing:views.editor.save') }).click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.viewUpdated', { name: 'Late' }),
    );
  });

  test('refuses to add a view shared with no department', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openViews(page, locale);

    await page.getByRole('button', { name: t('ticketing:views.add'), exact: true }).click();
    const card = page.getByRole('form', { name: t('ticketing:views.editor.newHeading') });
    await card
      .getByLabel(t('ticketing:views.editor.name'), { exact: true })
      .fill('Billing backlog');
    await card.getByRole('radio', { name: t('ticketing:views.editor.departments') }).check();

    await expect(
      card.getByRole('button', { name: t('ticketing:views.editor.create') }),
    ).toBeDisabled();

    await card.getByRole('button', { name: 'Billing' }).click();
    await card.getByRole('button', { name: t('ticketing:views.editor.create') }).click();
    await expect(
      page.getByRole('button', {
        name: t('ticketing:views.table.select', { name: 'Billing backlog' }),
      }),
    ).toBeVisible();
  });

  test('hides a built-in view from the sidebar', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openViews(page, locale);
    const escalated = t('tickets:views.escalated');

    await page
      .getByRole('table')
      .getByRole('button', { name: t('ticketing:views.table.rowActions', { name: escalated }) })
      .click();
    await page.getByRole('menuitem', { name: t('ticketing:views.actions.hide') }).click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.viewHidden', { name: escalated }),
    );
    await expect(nav(page).getByRole('link', { name: new RegExp(`^${escalated}`) })).toHaveCount(0);
  });
});
