import { strings } from '../strings.js';
import { expect, openAdmin, test } from './admin-session.js';
import { SKIP_ENV } from './install.js';

/**
 * M1-15 against the real api: one ticket taken from typing it in to closing it.
 *
 * The mock suite covers the screens in both languages. What this adds is
 * everything under them — the ticket and its first message written in one
 * transaction, the `seq` assigned under the ticket's own lock, the note stored
 * as a note rather than a reply, the activity rows the thread then draws, and
 * the status change going through the transition hook.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

const SUBJECT = 'Refund for order 42 has not arrived';
const REPLY = 'The refund is on its way today.';
const NOTE = 'Finance confirmed the batch by phone.';

test.describe('the ticket workspace against the real api', () => {
  test('creates a ticket, replies, notes and closes it', async ({ page }) => {
    await openAdmin(page);

    await page
      .getByRole('link', { name: new RegExp(t('admin:nav.tickets')) })
      .first()
      .click();
    await page.getByRole('region', { name: t('tickets:list.label') }).waitFor();

    // ---------------------------------------------------------- create
    await page.getByRole('button', { name: t('tickets:newTicket.action') }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: t('tickets:newTicket.contactNone') }).click();
    await dialog.getByRole('textbox', { name: t('tickets:newTicket.subjectLabel') }).fill(SUBJECT);
    await dialog
      .getByRole('textbox', { name: t('tickets:newTicket.messageLabel') })
      .fill('Where is my refund?');
    await dialog.getByRole('button', { name: t('tickets:newTicket.submit') }).click();

    await expect(page.getByRole('heading', { name: SUBJECT, level: 1 })).toBeVisible();
    const thread = page.getByRole('list', { name: t('tickets:thread.label') });
    await expect(thread.getByText('Where is my refund?')).toBeVisible();

    // ----------------------------------------------------------- reply
    const composer = page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') });
    await composer.fill(REPLY);
    await page.getByRole('button', { name: t('tickets:email.send') }).click();

    // A `seq` came back, which is what makes a message sent (DOMAIN-RULES §7).
    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.replied') }),
    ).toBeVisible();
    await expect(thread.getByText(REPLY)).toBeVisible();
    await expect(thread.getByText(t('tickets:thread.notSent'))).toHaveCount(0);

    // ------------------------------------------------------------ note
    await page.getByRole('button', { name: t('tickets:composer.note') }).click();
    await composer.fill(NOTE);
    await page.getByRole('button', { name: t('tickets:composer.sendNote') }).click();

    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.noted') }),
    ).toBeVisible();
    await expect(thread.getByText(t('tickets:thread.note'))).toBeVisible();
    await expect(thread.getByText(NOTE)).toBeVisible();

    // ---------------------------------------------------------- status
    const details = page.getByRole('complementary', { name: t('tickets:details.label') });
    await details.getByRole('combobox', { name: t('tickets:details.status') }).click();
    await page.getByRole('option', { name: 'Closed' }).click();

    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.updated') }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: t('tickets:header.label') }).getByText('Closed'),
    ).toBeVisible();

    // The whole thread survives a reload, which is the api holding it and not
    // the browser: the fixture's session does not, but this one's cookie does.
    await page.reload();
    await expect(page.getByRole('heading', { name: SUBJECT, level: 1 })).toBeVisible();
    await expect(thread.getByText(REPLY)).toBeVisible();
    await expect(thread.getByText(NOTE)).toBeVisible();
  });
});
