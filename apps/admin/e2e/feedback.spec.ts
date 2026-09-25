import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, openTicketing, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M1-12 in the admin, in a real browser and both languages: the Ticketing ›
 * Feedback tab (`AdminTicketingFeedback`), the Time card and the Log time
 * dialog (`AdminTicketDialogs` panels 2, 6 and 8), and the survey a close
 * leaves on the ticket.
 *
 * Every step navigates by clicking, never by `page.goto`: the fixture keeps
 * its session and its data in memory, and a reload would lose both.
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

const openFeedback = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await openTicketing(page, locale);
  await page.getByRole('tab', { name: t('ticketing:tabs.feedback') }).click();
  await page.getByRole('form', { name: t('ticketing:feedback.form') }).waitFor();
};

const turnOnTimeTracking = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await openFeedback(page, locale);
  await page
    .getByRole('checkbox', { name: new RegExp(t('ticketing:feedback.timeEnabled')) })
    .check();
  await page.getByRole('button', { name: t('ticketing:feedback.save') }).click();
  await expect(page.getByRole('status')).toContainText(t('ticketing:toast.feedbackSaved'));
};

test.describe('the Feedback tab', () => {
  test('saves the toggles, and keeps the composer timer off while tracking is', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openFeedback(page, locale);

    const composer = page.getByRole('checkbox', {
      name: new RegExp(t('ticketing:feedback.timerWithComposer')),
    });
    await expect(composer).toBeDisabled();
    expect(await violations(page)).toEqual([]);

    await page
      .getByRole('checkbox', { name: new RegExp(t('ticketing:feedback.timeEnabled')) })
      .check();
    await expect(composer).toBeEnabled();
    await page.getByRole('button', { name: t('ticketing:feedback.save') }).click();

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.feedbackSaved'));
    await expect(page.getByRole('button', { name: t('ticketing:feedback.save') })).toBeDisabled();
  });
});

test.describe('the Feedback tab’s preview (M1-15 part 2)', () => {
  test('opens the rating page over a sample in a new tab, in the admin’s language', async ({
    page,
    context,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openFeedback(page, locale);

    const link = page.getByRole('link', { name: new RegExp(t('ticketing:feedback.previewLink')) });
    await expect(link).toHaveAttribute('target', '_blank');
    const [preview] = await Promise.all([context.waitForEvent('page'), link.click()]);

    // The page's loading line is a status too, until the sample arrives.
    await expect(
      preview.getByRole('status').filter({ hasText: t('csat:preview.notice') }),
    ).toBeVisible();
    await expect(preview.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(preview.getByText(t('csat:preview.subject'), { exact: false })).toBeVisible();
    expect(await violations(preview)).toEqual([]);
  });
});

test.describe('the Time card', () => {
  test('logs time from the header menu, totals it, and deletes it again', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await turnOnTimeTracking(page, locale);
    await openTicket(page, locale);

    const card = page.getByRole('region', { name: t('tickets:time.heading') });
    await expect(card.getByText(t('tickets:time.empty'))).toBeVisible();

    await page.getByRole('button', { name: t('tickets:header.more') }).click();
    await page.getByRole('menuitem', { name: t('tickets:header.logTime') }).click();
    const dialog = page.getByRole('dialog', { name: t('tickets:logTime.title') });
    await expect(dialog).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await dialog.getByRole('spinbutton', { name: t('tickets:logTime.hours') }).fill('1');
    await dialog.getByRole('spinbutton', { name: t('tickets:logTime.minutes') }).fill('25');
    await dialog
      .getByRole('textbox', { name: t('tickets:logTime.note') })
      .fill('Called the carrier');
    await dialog
      .getByRole('button', { name: t('tickets:logTime.submit', { duration: '1h 25m' }) })
      .click();

    await expect(card.getByText(t('tickets:time.total', { duration: '1h 25m' }))).toBeVisible();
    await expect(card.getByText(/Called the carrier/)).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await card.getByRole('button', { name: t('tickets:time.delete') }).click();
    await expect(card.getByText(t('tickets:time.empty'))).toBeVisible();
  });

  test('refuses a dialog that adds up to nothing', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await turnOnTimeTracking(page, locale);
    await openTicket(page, locale);

    await page.getByRole('button', { name: t('tickets:time.addManually') }).click();
    const dialog = page.getByRole('dialog', { name: t('tickets:logTime.title') });
    await dialog.getByRole('spinbutton', { name: t('tickets:logTime.minutes') }).fill('0');

    await expect(dialog.getByRole('alert')).toHaveText(t('tickets:logTime.invalid'));
    await expect(
      dialog.getByRole('button', { name: t('tickets:logTime.submitEmpty') }),
    ).toBeDisabled();
  });

  test('runs the timer and logs what it counted', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await turnOnTimeTracking(page, locale);
    await openTicket(page, locale);

    const card = page.getByRole('region', { name: t('tickets:time.heading') });
    const timer = card.getByRole('timer');
    await card.getByRole('button', { name: t('tickets:time.start') }).click();
    // Real time rather than a fake clock: the claim is that a running timer
    // counts, and a second is enough to show it.
    await expect(timer).not.toHaveText('00:00:00');
    await card.getByRole('button', { name: t('tickets:time.log'), exact: true }).click();

    await expect(
      card.getByText(new RegExp(t('tickets:time.total', { duration: '\\d+s' }))),
    ).toBeVisible();
    await expect(timer).toHaveText('00:00:00');
  });
});

test.describe('the survey on the ticket', () => {
  test('appears pending when the ticket closes, and its link opens the rating page', async ({
    page,
    context,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page, locale);
    await openTicket(page, locale);

    const details = page.getByRole('complementary', { name: t('tickets:details.label') });
    await details.getByRole('combobox', { name: t('tickets:details.status') }).click();
    await page.getByRole('option', { name: locale === 'ar' ? 'مغلقة' : 'Closed' }).click();

    await expect(details.getByText(t('tickets:csat.pending'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await details.getByRole('button', { name: t('tickets:csat.copyLink') }).click();
    await expect(page.getByText(t('tickets:csat.copied'))).toBeVisible();

    const link = await page.evaluate(() => navigator.clipboard.readText());
    await page.goto(`${link}?lang=${locale}`);
    await expect(page.getByRole('heading', { name: t('csat:heading') })).toBeVisible();
  });
});
