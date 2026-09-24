import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, openTicketing, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M1-07 in a real browser, in both languages: the Assignment tab of
 * `Admin/Ticketing` (artboard `Admin/Ticketing-Assignment`) and the assignee
 * picker of the ticket workspace (`AdminTicketDialogs`, panel 3).
 *
 * What a browser adds over the unit suites is a radio group, a checkbox and a
 * popover that are really clicked and really focused, the Arabic layout that is
 * a different layout rather than the same one mirrored, and axe over both.
 */

test.use({ reducedMotion: 'reduce' });

/** The Support department's name as the screen prints it. */
const support = (locale: Locale): string => (locale === 'ar' ? 'الدعم' : 'Support');

const openAssignment = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicketing(page, locale);
  await page.getByRole('tab', { name: t('ticketing:tabs.assignment') }).click();
  await page
    .getByRole('heading', {
      name: t('ticketing:assignment.editor.heading', { department: support(locale) }),
    })
    .waitFor();
};

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

test.describe('the Assignment tab', () => {
  test('lists how each department routes and opens on the first', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAssignment(page, locale);

    await expect(
      page.getByRole('heading', {
        name: t('ticketing:assignment.agents.heading', { department: support(locale) }),
      }),
    ).toBeVisible();
    await expect(
      page.getByText(t('ticketing:assignment.agents.atCap', { open: 8, cap: 8 })),
    ).toBeVisible();
    await expect(
      page.getByRole('radio', {
        name: new RegExp(`^${t('ticketing:assignment.modes.round_robin')}`),
      }),
    ).toBeChecked();
  });

  test('saves a department’s settings from the side editor', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAssignment(page, locale);

    await page
      .getByRole('radio', { name: new RegExp(`^${t('ticketing:assignment.modes.skill_based')}`) })
      .check();
    await page.getByRole('textbox', { name: t('ticketing:assignment.editor.loadCap') }).fill('10');
    await page
      .getByRole('button', { name: t('ticketing:assignment.editor.save'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.assignmentSaved', { name: support(locale) }),
    );
    const row = page
      .getByRole('row')
      .filter({ hasText: support(locale) })
      .first();
    await expect(row.getByText(t('ticketing:assignment.modes.skill_based'))).toBeVisible();
    await expect(row.getByText('10', { exact: true })).toBeVisible();
  });

  test('refuses a load cap below one and keeps Save off', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openAssignment(page, locale);

    await page.getByRole('textbox', { name: t('ticketing:assignment.editor.loadCap') }).fill('0');

    await expect(page.getByText(t('ticketing:assignment.editor.loadCapInvalid'))).toBeVisible();
    await expect(
      page.getByRole('button', { name: t('ticketing:assignment.editor.save'), exact: true }),
    ).toBeDisabled();
  });

  test('takes an agent out of rotation and gives another a skill', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAssignment(page, locale);

    const sami = page.getByRole('checkbox', {
      name: t('ticketing:assignment.agents.inRotationFor', { name: 'Sami Aziz' }),
    });
    await sami.uncheck();
    await expect(page.getByRole('status').first()).toContainText(
      t('ticketing:toast.agentUpdated', { name: 'Sami Aziz' }),
    );
    await expect(sami).not.toBeChecked();

    await page
      .getByRole('button', {
        name: t('ticketing:assignment.agents.addSkillFor', { name: 'Omar Nasser' }),
      })
      .click();
    await page.getByRole('menuitem').first().click();
    await expect(
      page.getByRole('status').filter({
        hasText: t('ticketing:toast.agentUpdated', { name: 'Omar Nasser' }),
      }),
    ).toBeVisible();
  });

  test('has no accessibility violations', async ({ page, appLocale: locale }) => {
    await openAssignment(page, locale);

    expect(await violations(page)).toEqual([]);
  });
});

test.describe('the assignee picker', () => {
  const openPicker = async (page: Page, locale: Locale): Promise<void> => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);
    await page
      .getByRole('button', { name: t('tickets:details.picker.open', { name: 'Lina Haddad' }) })
      .click();
    await page.getByRole('listbox', { name: t('tickets:details.picker.list') }).waitFor();
  };

  test('offers who can work the department, with presence and load', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openPicker(page, locale);

    const list = page.getByRole('listbox', { name: t('tickets:details.picker.list') });
    await expect(
      list.getByRole('option', {
        name: new RegExp(`Omar Nasser.*${t('tickets:details.picker.atCap', { open: 8, cap: 8 })}`),
      }),
    ).toBeVisible();
    await expect(
      list.getByRole('option', {
        name: new RegExp(`Sami Aziz.*${t('tickets:details.picker.offline')}`),
      }),
    ).toBeVisible();
    await expect(
      page.getByText(t('tickets:details.picker.footer', { department: 'Support' })),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('assigns an agent at cap by hand', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openPicker(page, locale);

    await page.getByRole('option', { name: /Omar Nasser/ }).click();

    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.updated') }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: t('tickets:details.picker.open', { name: 'Omar Nasser' }) }),
    ).toBeVisible();
  });

  test('says when nobody matches the search', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openPicker(page, locale);

    await page
      .getByRole('searchbox', { name: t('tickets:details.picker.search') })
      .fill('nobody by this name');

    await expect(
      page.getByRole('option', { name: t('tickets:details.picker.noMatch') }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
  });
});
