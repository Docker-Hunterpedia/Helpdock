import { expect, test } from './fixtures.js';
import { openTicketing, openTicketingTab, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Ticketing`, Departments tab, in a real browser, in both languages.
 *
 * What a browser adds over the unit suite is the parts that are not React: the
 * tab row as real links, a reorder driven from the keyboard rather than from a
 * synthetic click, a menu that opens where it can be clicked, and an Arabic
 * layout that is a different layout rather than the same one mirrored by hand
 * (DESIGN §7).
 */

/**
 * The name cell of each row, in order. Addressed as a cell rather than as "the
 * second button", so adding a control to the row cannot make this read the
 * wrong element and pass on the wrong text. `cell` is which column carries the
 * name: the department list puts it second, the tag list third — after the
 * chip.
 */
const namesInOrder = async (page: import('@playwright/test').Page, cell = 1): Promise<string[]> => {
  const rows = page.getByRole('row');
  const count = await rows.count();
  const names: string[] = [];

  // Row 0 is the header.
  for (let index = 1; index < count; index += 1) {
    names.push((await rows.nth(index).getByRole('cell').nth(cell).textContent()) ?? '');
  }

  return names;
};

/** Whether the list is in this order, ignoring the Arabic name under each. */
const startsWith = (names: readonly string[], expected: readonly string[]): boolean =>
  names.length === expected.length &&
  expected.every((name, index) => names[index]?.startsWith(name) === true);

test.describe('ticketing settings', () => {
  test('offers every tab and lands on Departments', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);

    await expect(page.getByRole('heading', { name: t('ticketing:title'), level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: t('ticketing:tabs.statuses') })).toBeVisible();
    await expect(page.getByRole('tab', { name: t('ticketing:tabs.assignment') })).toBeVisible();

    await expect(
      page.getByRole('button', {
        name: t('ticketing:departments.table.select', { name: 'Support' }),
      }),
    ).toBeVisible();
  });

  test('says which deliverable an unbuilt tab is waiting for', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);

    // Views, because M1-06 filled Tags, Custom fields and Templates and M1-08
    // filled Statuses.
    await page.getByRole('tab', { name: t('ticketing:tabs.views') }).click();

    await expect(
      page.getByText(
        t('ticketing:soon.body', { tab: t('ticketing:tabs.views'), milestone: 'M1-05' }),
      ),
    ).toBeVisible();
  });

  test('creates a department from the side editor', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);

    await page.getByRole('button', { name: t('ticketing:departments.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:departments.editor.name'), exact: true })
      .fill('Sales');
    await page
      .getByRole('button', { name: t('ticketing:departments.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.departmentCreated', { name: 'Sales' }),
    );
    await expect(
      page.getByRole('button', {
        name: t('ticketing:departments.table.select', { name: 'Sales' }),
      }),
    ).toBeVisible();
  });

  test('renames a department and keeps its Arabic name', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);

    await page
      .getByRole('button', { name: t('ticketing:departments.table.select', { name: 'Support' }) })
      .click();
    const name = page.getByRole('textbox', {
      name: t('ticketing:departments.editor.name'),
      exact: true,
    });
    await name.fill('Front desk');
    await page
      .getByRole('button', { name: t('ticketing:departments.editor.save'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.departmentUpdated', { name: 'Front desk' }),
    );
    await expect(
      page.getByRole('button', {
        name: t('ticketing:departments.table.select', { name: 'Front desk' }),
      }),
    ).toBeVisible();
  });

  test('reorders from the keyboard alone', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);

    expect(startsWith(await namesInOrder(page), ['Support', 'Billing', 'Onboarding'])).toBe(true);

    // The drag handle is a real button, so the keyboard alternative is on the
    // control itself as well as in the row menu (DESIGN §10).
    await page
      .getByRole('button', {
        name: t('ticketing:departments.table.dragHandle', { name: 'Support' }),
      })
      .focus();
    await page.keyboard.press('ArrowDown');

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.reordered'));
    await expect
      .poll(async () => startsWith(await namesInOrder(page), ['Billing', 'Support', 'Onboarding']))
      .toBe(true);
  });

  test('adds a team and puts somebody on it', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);

    await page
      .getByRole('button', { name: t('ticketing:departments.table.select', { name: 'Support' }) })
      .click();
    await page
      .getByRole('textbox', { name: t('ticketing:departments.teams.namePlaceholder') })
      .fill('Front line');
    await page
      .getByRole('button', { name: t('ticketing:departments.teams.add'), exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.teamCreated', { name: 'Front line' }),
    );

    await page.getByLabel(t('ticketing:departments.teams.picker', { team: 'Front line' })).click();
    await page.getByRole('option', { name: 'Yara Salem' }).click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.memberAdded', { name: 'Yara Salem', team: 'Front line' }),
    );
  });

  test('says which rule refused a duplicate name', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);

    await page.getByRole('button', { name: t('ticketing:departments.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:departments.editor.name'), exact: true })
      .fill('Support');
    await page
      .getByRole('button', { name: t('ticketing:departments.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.nameTaken'));
  });

  test('asks before deleting a department', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketing(page, locale);

    await page
      .getByRole('button', {
        name: t('ticketing:departments.table.rowActions', { name: 'Billing' }),
      })
      .click();
    await page
      .getByRole('menuitem', { name: t('ticketing:departments.actions.delete'), exact: true })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      t('ticketing:departments.confirm.delete.title', { name: 'Billing' }),
    );

    await dialog
      .getByRole('button', { name: t('ticketing:departments.confirm.delete.submit') })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.departmentDeleted', { name: 'Billing' }),
    );
    await expect(
      page.getByRole('button', {
        name: t('ticketing:departments.table.select', { name: 'Billing' }),
      }),
    ).toHaveCount(0);
  });
});

/**
 * The three tabs M1-06 filled, in a real browser, in both languages.
 *
 * What a browser adds over the unit suite is the same as for Departments: the
 * tab row as real links, a reorder driven from the keyboard rather than from a
 * synthetic click, menus that open where they can be clicked, and an Arabic
 * layout that is a different layout rather than the same one mirrored by hand.
 */
test.describe('tags', () => {
  test('creates a tag with a colour chosen from the eight tints', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'tags');

    await page.getByRole('button', { name: t('ticketing:tags.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:tags.editor.name'), exact: true })
      .fill('Chargeback');

    // Eight radios, never nine, and never the danger tint (DESIGN §6.2).
    await expect(page.getByRole('radio')).toHaveCount(8);
    await page
      .getByRole('radio', {
        name: t('ticketing:tags.editor.colourOption', {
          colour: t('ticketing:tags.colours.escalated'),
        }),
      })
      .check();

    await page
      .getByRole('button', { name: t('ticketing:tags.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.tagCreated', { name: 'Chargeback' }),
    );
  });

  test('reorders from the keyboard alone', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'tags');

    expect(startsWith(await namesInOrder(page, 2), ['Refund', 'VIP', 'Bug'])).toBe(true);

    await page
      .getByRole('button', { name: t('ticketing:tags.table.dragHandle', { name: 'Refund' }) })
      .focus();
    await page.keyboard.press('ArrowDown');

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.tagsReordered'));
    await expect
      .poll(async () => startsWith(await namesInOrder(page, 2), ['VIP', 'Refund', 'Bug']))
      .toBe(true);
  });

  test('says how many tickets keep no tag before deleting one', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'tags');

    await page
      .getByRole('button', { name: t('ticketing:tags.table.rowActions', { name: 'Refund' }) })
      .click();
    await page
      .getByRole('menuitem', { name: t('ticketing:tags.actions.delete'), exact: true })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      t('ticketing:tags.confirm.delete.title', { name: 'Refund' }),
    );

    await dialog.getByRole('button', { name: t('ticketing:tags.confirm.delete.submit') }).click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.tagDeleted', { name: 'Refund' }),
    );
  });

  test('says which rule refused a duplicate name', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'tags');

    await page.getByRole('button', { name: t('ticketing:tags.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:tags.editor.name'), exact: true })
      .fill('Refund');
    await page
      .getByRole('button', { name: t('ticketing:tags.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.nameTaken'));
  });
});

test.describe('custom fields', () => {
  test('draws one table per target and locks the key of an existing field', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'custom-fields');

    for (const target of ['ticket', 'contact', 'account'] as const) {
      await expect(
        page.getByRole('table', {
          name: t('ticketing:customFields.table.caption', {
            target: t(`ticketing:customFields.targets.${target}`),
          }),
        }),
      ).toBeVisible();
    }

    await page
      .getByRole('button', {
        name: t('ticketing:customFields.table.select', { name: 'Plan tier' }),
      })
      .click();

    await expect(
      page.getByRole('textbox', { name: t('ticketing:customFields.editor.key'), exact: true }),
    ).toBeDisabled();
  });

  test('creates a field and suggests its key from the label', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'custom-fields');

    await page
      .getByRole('button', {
        name: t('ticketing:customFields.addTo', {
          target: t('ticketing:customFields.targets.ticket').toLocaleLowerCase(),
        }),
        exact: true,
      })
      .click();
    await page
      .getByRole('textbox', { name: t('ticketing:customFields.editor.label'), exact: true })
      .fill('Escalation note');

    await expect(
      page.getByRole('textbox', { name: t('ticketing:customFields.editor.key'), exact: true }),
    ).toHaveValue('escalation_note');

    await page
      .getByRole('button', { name: t('ticketing:customFields.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.fieldCreated', { name: 'Escalation note' }),
    );
  });

  test('reorders an option from the keyboard and asks before removing one in use', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'custom-fields');

    await page
      .getByRole('button', {
        name: t('ticketing:customFields.table.select', { name: 'Plan tier' }),
      })
      .click();

    const first = page.getByRole('textbox', {
      name: t('ticketing:customFields.editor.optionLabel', { position: 1 }),
    });
    await expect(first).toHaveValue('gold');
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(first).toHaveValue('silver');

    await page
      .getByRole('button', {
        name: t('ticketing:customFields.editor.removeOption', { name: 'gold' }),
      })
      .click();
    await page
      .getByRole('button', { name: t('ticketing:customFields.editor.save'), exact: true })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(t('ticketing:customFields.confirm.force.body'));

    await dialog
      .getByRole('button', { name: t('ticketing:customFields.confirm.force.submit') })
      .click();

    // A toast raised while another is already on screen — which is exactly what
    // confirming this dialog does — has to survive (`ui/toasts.tsx`).
    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.fieldUpdated', { name: 'Plan tier' }),
    );
    await expect(
      page.getByRole('textbox', {
        name: t('ticketing:customFields.editor.optionLabel', { position: 3 }),
      }),
    ).toHaveCount(0);
  });
});

test.describe('ticket templates', () => {
  test('creates a template', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'templates');

    await page.getByRole('button', { name: t('ticketing:templates.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:templates.editor.name'), exact: true })
      .fill('Outage');
    await page
      .getByRole('textbox', { name: t('ticketing:templates.editor.subject'), exact: true })
      .fill('Service interruption');
    await page
      .getByRole('textbox', { name: t('ticketing:templates.editor.body'), exact: true })
      .fill('We are on it.');
    await page
      .getByRole('button', { name: t('ticketing:templates.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.templateCreated', { name: 'Outage' }),
    );
  });

  test('previews a template with its placeholders filled by the api', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'templates');

    await page
      .getByRole('button', {
        name: t('ticketing:templates.table.select', { name: 'Refund request' }),
      })
      .click();
    await page
      .getByRole('button', { name: t('ticketing:templates.editor.preview'), exact: true })
      .click();

    await expect(page.getByText('Refund for Mona Khalil')).toBeVisible();
  });

  test('asks before deleting a template', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'templates');

    await page
      .getByRole('button', {
        name: t('ticketing:templates.table.rowActions', { name: 'Password reset' }),
      })
      .click();
    await page
      .getByRole('menuitem', { name: t('ticketing:templates.actions.delete'), exact: true })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      t('ticketing:templates.confirm.delete.title', { name: 'Password reset' }),
    );
    await dialog
      .getByRole('button', { name: t('ticketing:templates.confirm.delete.submit') })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.templateDeleted', { name: 'Password reset' }),
    );
  });
});
