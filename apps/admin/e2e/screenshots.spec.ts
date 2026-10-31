import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { MOCK_EMAIL } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import {
  openContact,
  openContacts,
  openSettingsArea,
  openTicket,
  openTickets,
  signIn,
  submitPassword,
} from './flows.js';
import { strings } from './strings.js';

/**
 * The ticket fixture dates itself from the moment it is built — a breached SLA
 * has to still read "breached 2h" next year — so the two ticket screens fix the
 * browser's clock first. Everything they print is then a fixed distance from a
 * fixed instant, and the pixels stop moving.
 */
/**
 * Signs in and waits for the sidebar's "Get set up" entry (M14-13), which fills
 * in a moment after the sidebar does: a picture taken before it would differ
 * from one taken after.
 */
async function signInToShell(page: Page, locale: Locale): Promise<void> {
  await signIn(page, locale);
  await page
    .getByRole('button', {
      name: strings(locale)('admin:setupChecklist.entryLabel', { done: 3, total: 9 }),
    })
    .waitFor();
}

const FIXED_CLOCK = new Date('2026-09-19T12:00:00.000Z');

/**
 * One baseline per screen per locale, so an accidental layout change in either
 * direction shows up as a picture rather than as a reviewer's hunch.
 *
 * Tagged `@screenshot` and left out of `pnpm e2e`: the baselines are Linux
 * pixels, so a comparison anywhere else fails for a reason unrelated to the
 * code. `pnpm e2e:screenshots` runs it, and CI runs that as a step of its own.
 * The baselines come from `.github/workflows/screenshots.yml`;
 * `apps/admin/README.md` says why they are generated there.
 */
test.describe('reference screens @screenshot', () => {
  test('sign in', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByRole('heading', { level: 1 }).waitFor();

    await expect(page).toHaveScreenshot('sign-in.png', { fullPage: true });
  });

  test('the code screen', async ({ page, appLocale: locale }) => {
    await submitPassword(page, locale);
    await page.getByRole('heading', { level: 1 }).waitFor();
    // The field autofocuses, so the caret would blink through the comparison.
    await page.getByLabel(strings(locale)('auth:totp.codeLabel')).blur();

    await expect(page).toHaveScreenshot('totp.png', { fullPage: true });
  });

  test('the sign-in link confirmation', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await page.goto('/sign-in');
    await page.getByLabel(t('auth:signIn.emailLabel')).fill(MOCK_EMAIL);
    await page.getByRole('button', { name: t('auth:signIn.magicLink') }).click();
    await page.getByRole('heading', { name: t('auth:magicLink.title') }).waitFor();

    await expect(page).toHaveScreenshot('magic-link-sent.png', { fullPage: true });
  });

  test('the shell', async ({ page, appLocale: locale }) => {
    await signInToShell(page, locale);

    await expect(page).toHaveScreenshot('shell-tickets.png', { fullPage: true });
  });

  test('the shell with the sidebar collapsed to its rail', async ({ page, appLocale: locale }) => {
    await signInToShell(page, locale);
    await page.getByRole('button', { name: strings(locale)('admin:nav.collapse') }).click();
    // The pointer is still on the toggle, whose tooltip would be in the picture.
    await page.mouse.move(640, 400);
    await expect(page.getByRole('tooltip')).toHaveCount(0);

    await expect(page).toHaveScreenshot('shell-collapsed.png', { fullPage: true });
  });

  test('the setup checklist panel', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signInToShell(page, locale);
    await page
      .getByRole('button', { name: t('admin:setupChecklist.entryLabel', { done: 3, total: 9 }) })
      .click();
    await page.getByRole('dialog', { name: t('admin:setupChecklist.title') }).waitFor();

    await expect(page).toHaveScreenshot('setup-checklist.png', { fullPage: true });
  });

  test('an admin page', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await signInToShell(page, locale);
    await openSettingsArea(page, t, 'settings');
    // The page heading is part of the shell and renders before the settings
    // request settles. Wait for loaded form content so the baseline can never
    // capture the transient loading state.
    await page
      .getByRole('heading', { level: 2, name: t('settings:signInMethods.title') })
      .waitFor();

    await expect(page).toHaveScreenshot('shell-settings.png', { fullPage: true });
  });

  test('the contact list', async ({ page, appLocale: locale }) => {
    await signInToShell(page, locale);
    await openContacts(page, locale);
    // The heading renders before the rows do, so wait for the table itself.
    await page.getByRole('table').waitFor();

    await expect(page).toHaveScreenshot('contacts-list.png', { fullPage: true });
  });

  test('the ticket list', async ({ page, appLocale: locale }) => {
    await page.clock.setFixedTime(FIXED_CLOCK);
    await signInToShell(page, locale);
    await openTickets(page, locale, 'all');
    // The rows arrive after the heading does.
    await page.getByRole('link', { name: /HD-1042/ }).waitFor();

    // The workspace is exactly one viewport high and scrolls inside itself
    // (DESIGN §6.5), so a full-page shot would be the viewport plus a margin
    // of nothing.
    await expect(page).toHaveScreenshot('tickets-list.png');
  });

  test('one ticket', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await page.clock.setFixedTime(FIXED_CLOCK);
    await signInToShell(page, locale);
    // The fixture's fullest ticket: every badge, all four kinds of message, an
    // activity event between them and a colleague viewing it.
    // At 1280 × 720 (M14-19, `Admin/Ticket-CompactComposer`): the details are a
    // drawer, the composer is one line, and the thread has the room.
    await page.setViewportSize({ width: 1280, height: 720 });
    await openTicket(page, locale, 'HD-1042', { compact: true });
    await page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') }).waitFor();
    await page
      .getByRole('form', { name: t('tickets:composer.label') })
      .getByRole('button', { name: /billing@helpdock\.io/ })
      .waitFor();

    await expect(page).toHaveScreenshot('ticket-view.png');
  });

  test('one ticket with its details', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await page.clock.setFixedTime(FIXED_CLOCK);
    await signInToShell(page, locale);
    await openTicket(page, locale);
    await page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') }).waitFor();
    // The contact's timeline arrives after the ticket; until it does, the
    // panel holds skeleton rows, which is not the screen being kept.
    await page.getByText(t('tickets:details.hiddenTickets', { count: 2 })).waitFor();
    // So is "How it got here" (M14-08), which reads its trail once the ticket has loaded.
    await page
      .getByRole('region', { name: t('tickets:routing.heading') })
      .getByText('support@helpdock.test')
      .waitFor();

    await expect(page).toHaveScreenshot('ticket-view-details.png');
  });

  test('one contact', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await signInToShell(page, locale);
    // The fixture's fullest contact: a verified identifier beside unverified
    // ones, an account, a note, every stat, an open duplicate suggestion, and
    // her tickets, which the timeline reads after the contact.
    await openContact(page, locale, 'Mona Khalil');
    await page.getByText(t('contacts:detail.visibleTickets', { count: 2 })).waitFor();

    await expect(page).toHaveScreenshot('contact-detail.png', { fullPage: true });
  });
});
