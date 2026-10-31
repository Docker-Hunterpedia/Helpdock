import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, openTicketingTab, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-27 in a real browser, in both languages (`Admin/Ticketing-CustomFields`):
 * the four new field types in the field editor, on a ticket, and as filters.
 *
 * The labels are the same in both desks because the fields are created here
 * without an Arabic label, which is the case a brand that has not translated
 * them yet is in.
 */

test.use({ reducedMotion: 'reduce' });

const TYPES = [
  { type: 'long_text', label: 'Notes' },
  { type: 'link', label: 'Status page' },
  { type: 'email', label: 'Billing email' },
  { type: 'person', label: 'Owner' },
] as const;

/** The first member of the fixture brand's staff, as the people read names them. */
const OWNER = 'Omar Nasser';

const details = (page: Page, locale: Locale) =>
  page.getByRole('complementary', { name: strings(locale)('tickets:details.label') });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

/** Creates the four fields on tickets through the editor, as an administrator would. */
const createFields = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await openTicketingTab(page, locale, 'custom-fields');

  for (const { type, label } of TYPES) {
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
      .fill(label);
    await page.getByRole('combobox', { name: t('ticketing:customFields.editor.type') }).click();
    await page
      .getByRole('option', { name: t(`ticketing:customFields.types.${type}`), exact: true })
      .click();
    await page
      .getByRole('button', { name: t('ticketing:customFields.editor.create'), exact: true })
      .click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: t('ticketing:toast.fieldCreated', { name: label }) }),
    ).toBeVisible();
  }
};

test('lists the four new types in the field editor', async ({ page, appLocale: locale }) => {
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
  await page.getByRole('combobox', { name: t('ticketing:customFields.editor.type') }).click();

  for (const { type } of TYPES) {
    await expect(
      page.getByRole('option', { name: t(`ticketing:customFields.types.${type}`), exact: true }),
    ).toBeVisible();
  }
  expect(await violations(page)).toEqual([]);
});

test('edits each type on a ticket, opens the link safely, and filters by the person', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await createFields(page, locale);
  await openTicket(page, locale);
  const panel = details(page, locale);

  await panel.getByRole('textbox', { name: 'Notes' }).fill('The customer runs three shops.');
  await panel.getByRole('textbox', { name: 'Notes' }).press('Tab');
  await expect(
    page.getByRole('status').filter({ hasText: t('tickets:toast.updated') }),
  ).toBeVisible();

  await panel.getByRole('textbox', { name: 'Status page' }).fill('https://status.stripe.com/i/42');
  await panel.getByRole('textbox', { name: 'Status page' }).press('Tab');
  const open = panel.getByRole('link', {
    name: t('tickets:details.linkOpen', { field: 'Status page' }),
  });
  await expect(open).toHaveAttribute('href', 'https://status.stripe.com/i/42');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');

  await panel.getByRole('textbox', { name: 'Billing email' }).fill('Finance@Globex.com');
  await panel.getByRole('textbox', { name: 'Billing email' }).press('Tab');
  await expect(panel.getByRole('textbox', { name: 'Billing email' })).toHaveAttribute('dir', 'ltr');

  await panel.getByRole('combobox', { name: 'Owner' }).click();
  await page.getByRole('option', { name: OWNER }).click();
  await expect(panel.getByRole('combobox', { name: 'Owner' })).toContainText(OWNER);
  expect(await violations(page)).toEqual([]);

  // The person is a filter too: chosen by name, kept as an id.
  await page.getByRole('button', { name: new RegExp(`^${t('tickets:filters.open')}`) }).click();
  const popover = page.getByRole('region', { name: t('tickets:filters.title') });
  await popover.getByRole('button', { name: t('tickets:fieldFilters.add') }).click();
  await page.getByRole('menuitem', { name: 'Owner', exact: true }).click();
  await popover
    .getByRole('group', { name: t('tickets:fieldFilters.valueOf', { field: 'Owner' }) })
    .getByRole('switch', { name: OWNER })
    .click();
  await popover.getByRole('button', { name: t('tickets:fieldFilters.apply') }).click();
  await page.keyboard.press('Escape');

  await expect(
    page.getByRole('button', {
      name: t('tickets:viewBar.remove', {
        filter: t('tickets:summary.is', { field: 'Owner', value: OWNER }),
      }),
    }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /HD-1042/ })).toBeVisible();
});

test('refuses a link that is not https, under the field, and keeps what was stored', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await createFields(page, locale);
  await openTicket(page, locale);
  const panel = details(page, locale);

  const field = panel.getByRole('textbox', { name: 'Status page' });
  await field.fill('javascript:alert(1)');
  // No way to open what is not an https address.
  await expect(panel.getByRole('link', { name: /Status page/ })).toHaveCount(0);
  await field.press('Tab');

  await expect(panel.getByRole('alert')).toHaveText(t('tickets:details.customRefused.link'));
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(await violations(page)).toEqual([]);
});

test('refuses an address that is not one', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await signIn(page, locale);
  await createFields(page, locale);
  await openTicket(page, locale);
  const panel = details(page, locale);

  const field = panel.getByRole('textbox', { name: 'Billing email' });
  await field.fill('not-an-address');
  await field.press('Tab');

  await expect(panel.getByRole('alert')).toHaveText(t('tickets:details.customRefused.email'));
  await expect(field).toHaveValue('');
});
