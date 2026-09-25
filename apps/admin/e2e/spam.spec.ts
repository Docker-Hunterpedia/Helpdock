import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, openTicketingTab, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M1-11 in a real browser, in both languages: the Spam tab of
 * `Admin/Ticketing` and "Mark as spam" in the ticket workspace
 * (`Admin/Ticketing › Spam` and `Admin · ticket dialogs`, panels 2 and 5).
 *
 * What a browser adds over the unit suites is a real menu opened from the
 * header, a real modal, the axe pass over each, and an Arabic layout that is a
 * different layout rather than the same one mirrored by hand (DESIGN §7).
 */

test.use({ reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.nodes.length}): ${violation.help} — ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

test.describe('the Spam tab', () => {
  test('lists the block list with what each row has dropped', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'spam');

    const row = page.getByRole('row').filter({ hasText: 'promo-deals.biz' }).last();
    await expect(row).toContainText('112');
    await expect(row).toContainText(t('ticketing:spam.kinds.domain'));
    await expect(
      page.getByRole('checkbox', { name: t('ticketing:spam.status.offer') }),
    ).toBeChecked();

    expect(await violations(page)).toEqual([]);
  });

  test('blocks a sender and unblocks it again', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'spam');

    await page.getByRole('button', { name: t('ticketing:spam.blockList.add') }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:spam.form.value'), exact: true })
      .fill('bot@crypto.biz');
    await page.getByRole('button', { name: t('ticketing:spam.form.submit'), exact: true }).click();

    await expect(page.getByRole('cell', { name: 'bot@crypto.biz', exact: true })).toBeVisible();

    await page
      .getByRole('button', {
        name: t('ticketing:spam.blockList.table.unblock', { value: 'bot@crypto.biz' }),
      })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: t('ticketing:spam.confirm.unblock.submit') }).click();

    await expect(page.getByRole('cell', { name: 'bot@crypto.biz', exact: true })).toHaveCount(0);
  });

  test('refuses the brand’s own domain beside the field', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'spam');

    await page.getByRole('button', { name: t('ticketing:spam.blockList.add') }).click();
    await page.getByRole('combobox', { name: t('ticketing:spam.form.kind') }).click();
    await page.getByRole('option', { name: t('ticketing:spam.form.kinds.domain') }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:spam.form.value'), exact: true })
      .fill('helpdock.com');
    await page.getByRole('button', { name: t('ticketing:spam.form.submit'), exact: true }).click();

    await expect(page.getByRole('alert')).toHaveText(t('ticketing:toast.senderIsOwn'));
    // The card with its refusal showing is the artboard's second state.
    expect(await violations(page)).toEqual([]);
  });
});

test.describe('marking a ticket as spam', () => {
  test('closes it into Spam and blocks the sender from the dialog', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page.getByRole('button', { name: t('tickets:header.more') }).click();
    await expect(page.getByRole('menu', { name: t('tickets:actions.label') })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.getByRole('menuitem', { name: t('tickets:actions.markSpam') }).click();

    const dialog = page.getByRole('dialog', {
      name: t('tickets:spam.title', { ticket: 'HD-1042' }),
    });
    const block = dialog.getByRole('checkbox');
    await expect(block).toBeChecked();
    await expect(dialog).toContainText('mona@example.com');
    expect(await violations(page)).toEqual([]);

    await dialog.getByRole('button', { name: t('tickets:spam.submit') }).click();

    await expect(
      page.getByText(t('tickets:toast.markedSpamBlocked', { sender: 'mona@example.com' })),
    ).toBeVisible();
    const header = page.getByRole('region', { name: t('tickets:header.label') });
    await expect(header).toContainText(locale === 'ar' ? 'مزعجة' : 'Spam');

    // The block made from the ticket is the one the Spam tab lists.
    await openTicketingTab(page, locale, 'spam');
    await expect(page.getByRole('cell', { name: 'mona@example.com', exact: true })).toBeVisible();
  });

  test('offers "Not spam" on a spam ticket, which reopens it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page.getByRole('button', { name: t('tickets:header.more') }).click();
    await page.getByRole('menuitem', { name: t('tickets:actions.markSpam') }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox').uncheck();
    await dialog.getByRole('button', { name: t('tickets:spam.submit') }).click();
    await expect(page.getByText(t('tickets:toast.markedSpam'), { exact: true })).toBeVisible();

    await page.getByRole('button', { name: t('tickets:header.more') }).click();
    await page.getByRole('menuitem', { name: t('tickets:actions.notSpam') }).click();

    await expect(page.getByText(t('tickets:toast.notSpam'))).toBeVisible();
  });
});
