import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { MOCK_USER } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { openTicketing, settingsTab, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-18 in a real browser, in both languages (`Admin/Ticketing-Assignment-Idle`):
 * the department setting on the Assignment tab, and the notice a person sees
 * once when their own activity ends an idle away.
 *
 * The socket is `MockRealtimeClient`, which plays the server's idle clock with a
 * thirty-minute limit, so the browser's clock is moved with `page.clock` rather
 * than waited out. The server's side is proved with a real Redis in
 * `assignment.integration.test.ts`.
 */

test.use({ reducedMotion: 'reduce' });

const support = (locale: Locale): string => (locale === 'ar' ? 'الدعم' : 'Support');
const billing = (locale: Locale): string => (locale === 'ar' ? 'الفوترة' : 'Billing');

const openAssignment = async (page: Page, locale: Locale, department = support(locale)) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicketing(page, locale);
  await settingsTab(page, t, 'ticketing:tabs.assignment').click();
  if (department !== support(locale)) {
    await page
      .getByRole('button', { name: t('ticketing:assignment.table.edit', { name: department }) })
      .click();
  }
  await page
    .getByRole('heading', {
      name: t('ticketing:assignment.editor.heading', { department }),
    })
    .waitFor();
};

const idleSelect = (page: Page, locale: Locale) =>
  page.getByRole('combobox', { name: strings(locale)('ticketing:assignment.editor.idleAway') });

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
};

test.describe('the idle setting on the Assignment tab', () => {
  test('starts off, says what away means, and saves a limit', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAssignment(page, locale);

    await expect(idleSelect(page, locale)).toHaveText(t('ticketing:assignment.editor.idleAwayOff'));
    await expect(page.getByText(t('ticketing:assignment.editor.idleAwayHint'))).toBeVisible();

    await idleSelect(page, locale).click();
    await page
      .getByRole('option', {
        name: t('ticketing:assignment.editor.idleAwayOption', { count: 45 }),
      })
      .click();
    await page
      .getByRole('button', { name: t('ticketing:assignment.editor.save'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.assignmentSaved', { name: support(locale) }),
    );
    await expect(idleSelect(page, locale)).toHaveText(
      t('ticketing:assignment.editor.idleAwayOption', { count: 45 }),
    );
  });

  test('shows the limit a department already has, and turns it off', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAssignment(page, locale, billing(locale));
    await expect(idleSelect(page, locale)).toHaveText(
      t('ticketing:assignment.editor.idleAwayOption', { count: 30 }),
    );

    await idleSelect(page, locale).click();
    await page.getByRole('option', { name: t('ticketing:assignment.editor.idleAwayOff') }).click();
    await page
      .getByRole('button', { name: t('ticketing:assignment.editor.save'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.assignmentSaved', { name: billing(locale) }),
    );
    await expect(idleSelect(page, locale)).toHaveText(t('ticketing:assignment.editor.idleAwayOff'));
  });

  test('offers 10 to 240 minutes and nothing outside it, and Cancel restores the saved value', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAssignment(page, locale);

    await idleSelect(page, locale).click();
    const options = page.getByRole('option');
    await expect(options.nth(1)).toHaveText(
      t('ticketing:assignment.editor.idleAwayOption', { count: 10 }),
    );
    await expect(options.last()).toHaveText(
      t('ticketing:assignment.editor.idleAwayOption', { count: 240 }),
    );
    await options.nth(3).click();
    await page.getByRole('button', { name: t('common:actions.cancel') }).click();

    await expect(idleSelect(page, locale)).toHaveText(t('ticketing:assignment.editor.idleAwayOff'));
  });

  test('has no accessibility violations', async ({ page, appLocale: locale }) => {
    await openAssignment(page, locale);

    expect(await violations(page)).toEqual([]);
  });
});

test.describe('the notice on return', () => {
  const footer = (page: Page, locale: Locale) =>
    page.getByRole('button', {
      name: strings(locale)('admin:currentUser.menuLabel', { name: MOCK_USER.name }),
    });

  const THIRTY_ONE_MINUTES = '31:00';

  test('marks the person away after the limit, then says so once when they are back', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.clock.install();
    await signIn(page, locale);
    const dot = footer(page, locale).locator('[data-status]');
    await expect(dot).toHaveAttribute('data-status', 'online');

    await page.clock.fastForward(THIRTY_ONE_MINUTES);
    await expect(dot).toHaveAttribute('data-status', 'away');
    await expect(footer(page, locale)).toContainText(t('admin:presence.status.away'));
    await expect(page.getByText(t('admin:presence.idleReturned'))).toHaveCount(0);

    await page.keyboard.press('Shift');

    await expect(page.getByText(t('admin:presence.idleReturned'))).toBeVisible();
    await expect(dot).toHaveAttribute('data-status', 'online');
    // It never takes focus: a person who came back by typing keeps typing.
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('admin:presence.idleReturnedDismiss') }).click();
    await expect(page.getByText(t('admin:presence.idleReturned'))).toHaveCount(0);

    // More activity is not another return.
    await page.keyboard.press('Shift');
    await page.clock.fastForward('02:00');
    await page.keyboard.press('Shift');
    await expect(page.getByText(t('admin:presence.idleReturned'))).toHaveCount(0);
  });

  test('does not call it a return for someone who chose Away themselves', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.clock.install();
    await signIn(page, locale);
    const dot = footer(page, locale).locator('[data-status]');

    await footer(page, locale).click();
    await page.getByRole('menuitem', { name: t('admin:presence.setAway') }).click();
    await expect(dot).toHaveAttribute('data-status', 'away');

    await page.clock.fastForward(THIRTY_ONE_MINUTES);
    await page.keyboard.press('Shift');

    await expect(dot).toHaveAttribute('data-status', 'away');
    await expect(page.getByText(t('admin:presence.idleReturned'))).toHaveCount(0);
  });
});
