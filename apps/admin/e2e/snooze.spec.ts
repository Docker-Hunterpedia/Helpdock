import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-02 in a real browser, in both languages (`Admin/Ticket-Snooze`): the
 * header's Snooze menu and `h`, the date-time picker, the SnoozedStrip with
 * Wake now, and the Snoozed view. The fixture keeps the api's rules (five
 * minutes to ninety days, no snooze for a closed ticket); the rest of the
 * wake paths are the api's integration suite.
 */

test.use({ reducedMotion: 'reduce' });

/** The built-in view's name, which the api seeds in both languages. */
const SNOOZED_VIEW = { en: 'Snoozed', ar: 'المؤجَّلة' } as const;

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

/** `YYYY-MM-DDTHH:mm` in the browser's local time, which is what the input takes. */
const localInput = (offsetDays: number): string => {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

test('snoozes from the header menu, shows the strip and the Snoozed view, and wakes now', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale);

  await page.getByRole('button', { name: t('tickets:snooze.button'), exact: true }).click();
  const menu = page.getByRole('menu', { name: t('tickets:snooze.menuLabel') });
  await expect(menu).toBeVisible();
  // The department works in another zone, so Next business day says so.
  await expect(menu.getByText(/Asia\/Tokyo/).first()).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await menu
    .getByRole('menuitem', { name: new RegExp(t('tickets:snooze.preset.in_4_hours')) })
    .click();

  const strip = page.getByRole('status').filter({ hasText: t('tickets:snooze.strip.wakeNow') });
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(t('tickets:snooze.strip.wakes'));
  expect(await violations(page)).toEqual([]);

  // Out of My open and out of the unfiltered desk, into the Snoozed view.
  await openTickets(page, locale, 'all');
  await expect(page.getByRole('link', { name: /HD-1042/ })).toHaveCount(0);
  await page.getByRole('link', { name: new RegExp(`^${SNOOZED_VIEW[locale]}`) }).click();
  const row = page.getByRole('link', { name: /HD-1042/ });
  await expect(row).toBeVisible();
  // The wake time stands where the SLA timer was, named by its own label.
  await expect(row.locator('span[aria-label]')).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  // Wake now puts it back.
  await row.click();
  await page.getByRole('button', { name: t('tickets:snooze.strip.wakeNow') }).click();
  await expect(strip).toHaveCount(0);
  await openTickets(page, locale, 'all');
  await expect(page.getByRole('link', { name: /HD-1042/ })).toBeVisible();
});

test('h opens the Snooze menu and a picked date and time snoozes the ticket', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale);

  await page.keyboard.press('h');
  const menu = page.getByRole('menu', { name: t('tickets:snooze.menuLabel') });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: t('tickets:snooze.pick') }).click();

  const dialog = page.getByRole('dialog', { name: t('tickets:snooze.dialog.title') });
  await expect(dialog.getByLabel(t('tickets:snooze.dialog.timeZone'))).toHaveAttribute('readonly');
  expect(await violations(page)).toEqual([]);
  await dialog.getByLabel(t('tickets:snooze.dialog.when')).fill(localInput(3));
  await dialog
    .getByRole('button', { name: t('tickets:snooze.dialog.confirm'), exact: true })
    .click();

  await expect(
    page.getByRole('status').filter({ hasText: t('tickets:snooze.strip.wakeNow') }),
  ).toBeVisible();
});

test('refuses a time more than ninety days ahead, or too soon, and offers no snooze on a closed ticket', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale);

  await page.getByRole('button', { name: t('tickets:snooze.button'), exact: true }).click();
  await page
    .getByRole('menu', { name: t('tickets:snooze.menuLabel') })
    .getByRole('menuitem', { name: t('tickets:snooze.pick') })
    .click();
  const dialog = page.getByRole('dialog', { name: t('tickets:snooze.dialog.title') });
  const when = dialog.getByLabel(t('tickets:snooze.dialog.when'));
  const confirm = dialog.getByRole('button', {
    name: t('tickets:snooze.dialog.confirm'),
    exact: true,
  });

  await when.fill(localInput(120));
  await expect(dialog.getByRole('alert')).toHaveText(t('tickets:snooze.dialog.tooFar'));
  await expect(confirm).toBeDisabled();

  await when.fill(localInput(-1));
  await expect(dialog.getByRole('alert')).toHaveText(t('tickets:snooze.dialog.tooSoon'));
  await expect(confirm).toBeDisabled();
  expect(await violations(page)).toEqual([]);

  await dialog.getByRole('button', { name: t('tickets:snooze.dialog.cancel') }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: t('tickets:snooze.strip.wakeNow') }),
  ).toHaveCount(0);

  // A closed ticket has nothing to put away: no button, and `h` does nothing.
  await openTickets(page, locale, 'all');
  await page.getByRole('link', { name: /HD-1030/ }).click();
  await page.getByRole('region', { name: t('tickets:header.label') }).waitFor();
  await expect(
    page.getByRole('button', { name: t('tickets:snooze.button'), exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('h');
  await expect(page.getByRole('menu', { name: t('tickets:snooze.menuLabel') })).toHaveCount(0);
});
