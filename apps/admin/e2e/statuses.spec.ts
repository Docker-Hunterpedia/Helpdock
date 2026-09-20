import { expect, test } from './fixtures.js';
import { openTicketing, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Ticketing`, Statuses tab, in a real browser, in both languages (M1-08).
 *
 * What a browser adds over the unit suite is the parts that are not React: a
 * reorder driven from a real keypress rather than a synthetic one, a select
 * that opens where it can be clicked, a confirmation dialog the browser
 * actually focuses, and an Arabic layout that is a different layout rather than
 * the same one mirrored by hand (DESIGN §7).
 */

/** The name cell of each row, in order, addressed as a cell rather than a button. */
const namesInOrder = async (page: import('@playwright/test').Page): Promise<string[]> => {
  const rows = page.getByRole('row');
  const count = await rows.count();
  const names: string[] = [];

  // Row 0 is the header.
  for (let index = 1; index < count; index += 1) {
    names.push((await rows.nth(index).getByRole('cell').nth(1).textContent()) ?? '');
  }

  return names;
};

const openStatuses = async (
  page: import('@playwright/test').Page,
  locale: 'en' | 'ar',
): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicketing(page, locale);
  await page.getByRole('tab', { name: t('ticketing:tabs.statuses') }).click();
  await expect(
    page.getByRole('button', { name: t('ticketing:statuses.table.select', { name: 'Open' }) }),
  ).toBeVisible();
};

test.describe('ticket statuses', () => {
  test('lists the brand’s statuses with their state and chips', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openStatuses(page, locale);

    await expect(
      page.getByRole('button', {
        name: t('ticketing:statuses.table.select', { name: 'Awaiting customer' }),
      }),
    ).toBeVisible();
    await expect(page.getByText(t('ticketing:statuses.chips.default')).first()).toBeVisible();
    await expect(page.getByText(t('ticketing:statuses.chips.custom')).first()).toBeVisible();
  });

  test('creates a status from the side editor', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openStatuses(page, locale);

    await page.getByRole('button', { name: t('ticketing:statuses.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:statuses.editor.name'), exact: true })
      .fill('Waiting on legal');
    await page
      .getByRole('button', { name: t('ticketing:statuses.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.statusCreated', { name: 'Waiting on legal' }),
    );
    await expect(
      page.getByRole('button', {
        name: t('ticketing:statuses.table.select', { name: 'Waiting on legal' }),
      }),
    ).toBeVisible();
  });

  test('says which rule refused a duplicate name', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openStatuses(page, locale);

    await page.getByRole('button', { name: t('ticketing:statuses.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:statuses.editor.name'), exact: true })
      .fill('Closed');
    await page
      .getByRole('button', { name: t('ticketing:statuses.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.nameTaken'));
  });

  /**
   * A seeded status's state and flags are what the code finds it by, so the
   * controls are disabled rather than hidden and the card says why.
   */
  test('locks the flags of a seeded status and explains it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openStatuses(page, locale);

    await page
      .getByRole('button', {
        name: t('ticketing:statuses.table.select', { name: 'Awaiting customer' }),
      })
      .click();

    await expect(page.getByText(t('ticketing:statuses.editor.systemNote'))).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: t('ticketing:statuses.editor.pausesSla') }),
    ).toBeDisabled();
  });

  test('reorders from the keyboard alone', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openStatuses(page, locale);

    expect((await namesInOrder(page))[0]).toContain('Open');

    // The drag handle is a real button, so the keyboard alternative is on the
    // control itself as well as in the row menu (DESIGN §10).
    await page
      .getByRole('button', { name: t('ticketing:statuses.table.dragHandle', { name: 'Open' }) })
      .focus();
    await page.keyboard.press('ArrowDown');

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.statusesReordered'));
    await expect.poll(async () => (await namesInOrder(page))[0]).toContain('Awaiting customer');
  });

  test('asks before deleting, and says how many tickets move', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openStatuses(page, locale);

    await page
      .getByRole('button', {
        name: t('ticketing:statuses.table.select', { name: 'Waiting on supplier' }),
      })
      .click();

    const deleteLink = page.getByRole('button', {
      name: t('ticketing:statuses.editor.delete', { count: 12, fallback: 'Open' }),
    });
    await expect(deleteLink).toBeVisible();
    await deleteLink.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      t('ticketing:statuses.confirm.delete.title', { name: 'Waiting on supplier' }),
    );

    await dialog
      .getByRole('button', { name: t('ticketing:statuses.confirm.delete.submit') })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.statusDeleted', { name: 'Waiting on supplier' }),
    );
    await expect(
      page.getByRole('button', {
        name: t('ticketing:statuses.table.select', { name: 'Waiting on supplier' }),
      }),
    ).toHaveCount(0);
  });

  test('saves the reply behaviour and the reopen window', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openStatuses(page, locale);

    const card = page.getByRole('form', { name: t('ticketing:statuses.reply.heading') });
    await card.getByRole('checkbox', { name: t('ticketing:statuses.reply.autoAwait') }).click();

    const days = card.getByRole('spinbutton', { name: t('ticketing:statuses.reply.daysLabel') });
    await days.fill('14');
    await card.getByRole('button', { name: t('ticketing:statuses.reply.save') }).click();

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.replyBehaviourSaved'));
  });

  /**
   * A day count beside "Always reopen" is a control that does nothing, and a
   * control that does nothing is one somebody will set and be surprised by.
   */
  test('hides the day count for a policy with no window', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openStatuses(page, locale);

    const card = page.getByRole('form', { name: t('ticketing:statuses.reply.heading') });
    await card.getByRole('combobox', { name: t('ticketing:statuses.reply.reopen') }).click();
    await page.getByRole('option', { name: t('ticketing:statuses.reply.reopenAlways') }).click();

    await expect(
      card.getByRole('spinbutton', { name: t('ticketing:statuses.reply.daysLabel') }),
    ).toHaveCount(0);
  });
});
