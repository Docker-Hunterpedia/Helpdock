import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { MOCK_TICKET_REFUND, MOCK_TICKET_SIGN_IN } from '../src/tickets/mock-api.js';
import { expectFieldPartsStacked } from './field-layout.js';
import { expect, test } from './fixtures.js';
import { openTicket, openTicketingTab, openTickets, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * The `Admin · ticket view` workspace in a real browser, in both languages.
 *
 * What a browser adds over the unit suite is everything that is not React: a
 * search that debounces against a real event loop, keys that arrive through a
 * real keyboard, two drawers that really open at the two breakpoints of
 * DESIGN §6.5, and an Arabic layout that is a different layout rather than the
 * same one mirrored by hand (DESIGN §7).
 */

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test.describe('the ticket list', () => {
  test('opens on a view, and the views carry live counts', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);

    await expect(
      page.getByRole('heading', { name: t('tickets:views.myOpen'), level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: new RegExp(`${t('tickets:views.overdue')} 3`) }),
    ).toBeVisible();
  });

  test('shows the whole desk on "All tickets"', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);
    await page.getByRole('link', { name: t('tickets:views.all'), exact: true }).click();

    await expect(page.getByRole('link', { name: /HD-/ })).toHaveCount(9);
  });

  test('names a row by its priority, status, SLA and contact, not its subject alone', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    const row = page.getByRole('link', { name: /HD-1042/ });
    await expect(row).not.toHaveAttribute('aria-label');
    // DESIGN §10: the priority dot is colour, so the priority is said in words too.
    await expect(row).toHaveAccessibleName(
      new RegExp(t('tickets:list.priority', { priority: t('tickets:priority.urgent') })),
    );
    await expect(row).toHaveAccessibleName(new RegExp(locale === 'ar' ? 'مفتوحة' : 'Open'));
    await expect(row).toHaveAccessibleName(/Mona Khalil/);
    await expect(row).toHaveAccessibleName(new RegExp(t('tickets:sla.breached', { over: '2h' })));
  });

  test('names each row’s contact from the ticket itself (M1-15)', async ({
    page,
    appLocale: locale,
  }) => {
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    // The name travels with the ticket, so a Latin name and an Arabic one are
    // both on their rows whatever page of the contact list they would be on.
    await expect(page.getByRole('link', { name: /HD-1042/ })).toContainText('Mona Khalil');
    await expect(page.getByRole('link', { name: /HD-1039/ })).toContainText('سارة الحسن');
  });

  test('prints only the reference on a row whose ticket names nobody', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    await page.getByRole('button', { name: t('tickets:newTicket.action') }).click();
    await page.getByRole('button', { name: t('tickets:newTicket.contactNone') }).click();
    await page
      .getByRole('textbox', { name: t('tickets:newTicket.subjectLabel') })
      .fill('Walk-in at the counter');
    await page
      .getByRole('textbox', { name: t('tickets:newTicket.messageLabel') })
      .fill('No name given.');
    await page.getByRole('button', { name: t('tickets:newTicket.submit') }).click();
    await expect(
      page
        .getByRole('region', { name: t('tickets:header.label') })
        .getByRole('heading', { level: 2 }),
    ).toContainText('Walk-in');
    // Opening the new ticket lands the list on the default view, which is
    // "My open"; the unassigned walk-in is on the whole desk.
    await page.getByRole('link', { name: t('tickets:views.all'), exact: true }).click();

    const row = page.getByRole('link', { name: /HD-1043/ });
    await expect(row).toBeVisible();
    // No stand-in for the contact: the status follows the reference directly.
    const open = locale === 'ar' ? 'مفتوحة' : 'Open';
    await expect(row.locator('p').last()).toHaveText(new RegExp(`^HD-1043\\s*·\\s*${open}$`));
  });

  test('says which conversations the assistant paused and which it answered (M7-06)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    const paused = page.getByRole('link', { name: /HD-1039/ });
    const answered = page.getByRole('link', { name: /HD-1041/ });
    const untouched = page.getByRole('link', { name: /HD-1042/ });
    await expect(paused).toContainText(t('tickets:list.aiPaused'));
    await expect(paused).not.toContainText(t('tickets:list.aiAnswered'));
    await expect(answered).toContainText(t('tickets:list.aiAnswered'));
    await expect(answered).not.toContainText(t('tickets:list.aiPaused'));
    await expect(untouched).not.toContainText(t('tickets:list.aiPaused'));
    await expect(untouched).not.toContainText(t('tickets:list.aiAnswered'));
    expect(await violations(page)).toEqual([]);
  });

  test('stacks new-ticket labels above their fields', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);

    await page.getByRole('button', { name: t('tickets:newTicket.action') }).click();
    const dialog = page.getByRole('dialog');
    const subject = dialog.getByRole('textbox', { name: t('tickets:newTicket.subjectLabel') });
    const message = dialog.getByRole('textbox', { name: t('tickets:newTicket.messageLabel') });

    await expectFieldPartsStacked({
      label: dialog.locator(`label[for="${await subject.getAttribute('id')}"]`),
      control: subject,
    });
    await expectFieldPartsStacked({
      label: dialog.locator(`label[for="${await message.getAttribute('id')}"]`),
      control: message,
    });
  });

  test('searches the api, and says so when nothing matches', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    const search = page.getByRole('searchbox', { name: t('tickets:list.searchLabel') });
    await search.fill('VAT');
    await expect(page.getByRole('link', { name: /HD-1035/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /HD-/ })).toHaveCount(1);

    await search.fill('nothing at all');
    await expect(
      page.getByText(t('tickets:empty.searchHeading', { term: 'nothing at all' })),
    ).toBeVisible();
  });

  test('finds a closed ticket by its reference from "My open", and not by its words (#221)', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale);
    await expect(
      page.getByRole('heading', { name: t('tickets:views.myOpen'), level: 1 }),
    ).toBeVisible();

    const search = page.getByRole('searchbox', { name: t('tickets:list.searchLabel') });
    await search.fill('#1030');
    await expect(page.getByRole('link', { name: /HD-1030/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /HD-/ })).toHaveCount(1);

    await search.fill('Duplicate charge');
    await expect(
      page.getByText(t('tickets:empty.searchHeading', { term: 'Duplicate charge' })),
    ).toBeVisible();
  });

  test('filters from the popover and counts what is on', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    await page.getByRole('button', { name: t('tickets:list.filter') }).click();
    await page.getByRole('switch', { name: t('tickets:priority.urgent') }).click();
    await page.keyboard.press('Escape');

    await expect(
      page.getByRole('button', { name: t('tickets:list.filterActive', { count: 1 }) }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /HD-/ })).toHaveCount(1);
  });

  test('keeps the filtered list in the url, so it is a link', async ({
    page,
    appLocale: locale,
  }) => {
    await signIn(page, locale);
    await openTickets(page, locale, 'all');
    await page.getByRole('searchbox').fill('VAT');

    await expect(page).toHaveURL(/q=VAT/);
  });
});

test.describe('the keyboard', () => {
  test('moves the selection with j and k and opens what it lands on', async ({
    page,
    appLocale: locale,
  }) => {
    await signIn(page, locale);
    await openTickets(page, locale, 'all');
    await page.getByRole('link', { name: /HD-1042/ }).waitFor();

    // Each press is followed to the screen it opened, not only to the url: the
    // next press acts on what the person is looking at.
    const opened = async (id: string, subject: string): Promise<void> => {
      await expect(page).toHaveURL(new RegExp(id));
      await expect(
        page
          .getByRole('region', { name: strings(locale)('tickets:header.label') })
          .getByRole('heading', { level: 2 }),
      ).toContainText(subject);
    };

    await page.keyboard.press('j');
    await opened(MOCK_TICKET_REFUND, 'Refund for order 42');

    await page.keyboard.press('j');
    await opened(MOCK_TICKET_SIGN_IN, 'Cannot sign in to the portal');

    await page.keyboard.press('k');
    await opened(MOCK_TICKET_REFUND, 'Refund for order 42');
  });

  test('answers the same keys on an Arabic keyboard layout, where j types ت', async ({
    page,
    appLocale: locale,
  }) => {
    await signIn(page, locale);
    await openTickets(page, locale, 'all');
    await page.getByRole('link', { name: /HD-1042/ }).waitFor();

    // Playwright's keyboard types US letters, so the Arabic layout's event is
    // dispatched as the browser would send it: the letter it types, the key it is.
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ت', code: 'KeyJ', bubbles: true, cancelable: true }),
      );
    });

    await expect(page).toHaveURL(new RegExp(MOCK_TICKET_REFUND));
  });

  test('puts the caret in the composer with r, and into note mode with n', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);
    await page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') }).waitFor();

    await page.keyboard.press('r');
    await expect(
      page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') }),
    ).toBeFocused();

    await page
      .getByRole('region', { name: t('tickets:header.label') })
      .getByRole('heading', { level: 2 })
      .click();
    await page.keyboard.press('n');
    await expect(page.getByRole('button', { name: t('tickets:composer.note') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('one ticket', () => {
  test('lets an English subject keep its own direction', async ({ page, appLocale: locale }) => {
    await signIn(page, locale);
    await openTicket(page, locale);

    const subject = 'Refund for order 42 has not arrived';
    await expect(page.getByRole('heading', { level: 2, name: subject })).toHaveAttribute(
      'dir',
      'auto',
    );
    await expect(page.getByRole('link', { name: /HD-1042/ }).getByText(subject)).toHaveAttribute(
      'dir',
      'auto',
    );
    // An English line resolves to left to right, inside the Arabic page too.
    expect(
      await page
        .getByRole('heading', { level: 2, name: subject })
        .evaluate((node) => node.matches(':dir(ltr)')),
    ).toBe(true);
  });

  test('draws the badge row, the four kinds of message and the events', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    const header = page.getByRole('region', { name: t('tickets:header.label') });
    await expect(header.getByText(t('tickets:priority.urgent'))).toBeVisible();
    await expect(
      header.getByText(t('tickets:sla.breachedFirstResponse', { over: '2h' })),
    ).toBeVisible();

    const thread = page.getByRole('list', { name: t('tickets:thread.label') });
    await expect(thread.getByText(t('tickets:thread.ai'))).toBeVisible();
    await expect(thread.getByText(t('tickets:thread.note'))).toBeVisible();
  });

  test('says who else has the ticket open', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await expect(
      page.getByText(t('tickets:header.viewingOne', { name: 'Omar Nasser' })),
    ).toBeVisible();
  });

  test('sends a reply and shows it in the thread once it has a seq', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page
      .getByRole('textbox', { name: t('tickets:composer.bodyLabel') })
      .fill('On its way today.');
    await page.getByRole('button', { name: t('tickets:email.send') }).click();

    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.replied') }),
    ).toBeVisible();
    await expect(
      page.getByRole('list', { name: t('tickets:thread.label') }).getByText('On its way today.'),
    ).toBeVisible();
  });

  test('adds an internal note in note mode', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page.getByRole('button', { name: t('tickets:composer.note') }).click();
    await page
      .getByRole('textbox', { name: t('tickets:composer.bodyLabel') })
      .fill('For the team only.');
    await page.getByRole('button', { name: t('tickets:composer.sendNote') }).click();

    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.noted') }),
    ).toBeVisible();
  });

  test('sends a file with a reply, and draws the one the contact sent', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    const thread = page.getByRole('list', { name: t('tickets:thread.label') });
    await expect(thread.getByText('return-confirmation.pdf')).toBeVisible();

    await page.getByRole('button', { name: t('tickets:composer.attach') }).click();
    await page.getByLabel(t('tickets:composer.attachFiles')).setInputFiles({
      name: 'receipt.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('a receipt'),
    });

    // The chip is there before the pipeline has finished: `upload` resolves at
    // `processing` and the send does not wait for `ready` (M1-10).
    const composer = page.getByRole('form', { name: t('tickets:composer.label') });
    await expect(composer.getByText('receipt.pdf')).toBeVisible();

    await page
      .getByRole('textbox', { name: t('tickets:composer.bodyLabel') })
      .fill('The receipt is attached.');
    await page.getByRole('button', { name: t('tickets:email.send') }).click();

    await expect(thread.getByText('receipt.pdf')).toBeVisible();
    await expect(composer.getByText('receipt.pdf')).toHaveCount(0);
  });

  test('changes the priority from the details panel', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page.getByRole('combobox', { name: t('tickets:details.priority') }).click();
    await page.getByRole('option', { name: t('tickets:priority.low') }).click();

    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.updated') }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: t('tickets:header.label') })
        .getByText(t('tickets:priority.low')),
    ).toBeVisible();
  });

  test('creates a ticket from the dialog and opens it', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    await page.getByRole('button', { name: t('tickets:newTicket.action') }).click();
    await page.getByRole('button', { name: t('tickets:newTicket.contactNone') }).click();
    await page
      .getByRole('textbox', { name: t('tickets:newTicket.subjectLabel') })
      .fill('Typed in by hand');
    await page
      .getByRole('textbox', { name: t('tickets:newTicket.messageLabel') })
      .fill('The first reply.');
    await page.getByRole('button', { name: t('tickets:newTicket.submit') }).click();

    await expect(
      page
        .getByRole('status')
        .filter({ hasText: t('tickets:toast.created', { reference: 'HD-1043' }) }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: t('tickets:header.label') })
        .getByRole('heading', { level: 2 }),
    ).toContainText('Typed in by hand');
  });

  test('refuses to file a ticket with no subject', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTickets(page, locale, 'all');

    await page.getByRole('button', { name: t('tickets:newTicket.action') }).click();
    await page.getByRole('button', { name: t('tickets:newTicket.submit') }).click();

    await expect(page.getByText(t('tickets:newTicket.subjectRequired'))).toBeVisible();
  });
});

test.describe('fields required to close (M14-17)', () => {
  const renewsOn = (locale: Locale): string => (locale === 'ar' ? 'يتجدد في' : 'Renews on');
  const closedName = (locale: Locale): string => (locale === 'ar' ? 'مغلقة' : 'Closed');

  /** Gates the seeded date field for this page's fixture brand, then opens the ticket and picks Closed. */
  const tryToClose = async (page: Page, locale: Locale): Promise<void> => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicketingTab(page, locale, 'custom-fields');
    await page
      .getByRole('button', {
        name: t('ticketing:customFields.table.select', { name: 'Renews on' }),
      })
      .click();
    await page
      .getByRole('checkbox', { name: t('ticketing:customFields.editor.requiredToClose') })
      .check();
    await page
      .getByRole('button', { name: t('ticketing:customFields.editor.save'), exact: true })
      .click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: t('ticketing:toast.fieldUpdated', { name: 'Renews on' }) }),
    ).toBeVisible();

    await openTicket(page, locale);
    await page.getByRole('combobox', { name: t('tickets:details.status'), exact: true }).click();
    await page.getByRole('option', { name: closedName(locale) }).click();
  };

  test('opens the dialog instead of closing, and Save and close fills the field and closes', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await tryToClose(page, locale);

    const dialog = page.getByRole('dialog', { name: t('tickets:closeGate.title') });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(t('tickets:details.requiredToClose'))).toBeVisible();
    // Axe reads colours mid-fade otherwise.
    await expect(page.locator('.MuiDialog-container')).toHaveCSS('opacity', '1');
    expect(await violations(page)).toEqual([]);

    await dialog.getByRole('textbox', { name: renewsOn(locale) }).fill('2026-12-01');
    await dialog.getByRole('button', { name: t('tickets:closeGate.submit') }).click();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('status').filter({ hasText: t('tickets:toast.updated') }),
    ).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: t('tickets:details.status'), exact: true }),
    ).toContainText(closedName(locale));
  });

  test('Cancel leaves the ticket open', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await tryToClose(page, locale);

    const dialog = page.getByRole('dialog', { name: t('tickets:closeGate.title') });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: t('common:actions.cancel') }).click();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('combobox', { name: t('tickets:details.status'), exact: true }),
    ).not.toContainText(closedName(locale));
  });
});

test.describe('the breakpoints of DESIGN §6.5', () => {
  test('puts the details panel in a drawer below 1440 px', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    // Signed in at the artboard's width first: below 1280 px the sidebar opens
    // as the icon rail, and the flow that gets here clicks a view by its name.
    await signIn(page, locale);
    await openTicket(page, locale);
    await page.setViewportSize({ width: 1200, height: 800 });

    const details = page.getByRole('complementary', { name: t('tickets:details.label') });
    await expect(details).toBeHidden();

    await page.getByRole('button', { name: t('tickets:header.details') }).click();
    await expect(details).toBeVisible();

    // DESIGN §10: a drawer closes on Escape.
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
  });

  test('puts the list in a drawer below 1024 px', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    // Signed in at the artboard's width first: below 1024 px the shell's own
    // navigation is a drawer too, and the flow that gets here clicks it.
    await signIn(page, locale);
    await openTicket(page, locale);
    await page.setViewportSize({ width: 900, height: 800 });

    const list = page.getByRole('region', { name: t('tickets:list.label') });
    await expect(list).toBeHidden();

    await page.getByRole('button', { name: t('tickets:list.open') }).click();
    await expect(list).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
  });
});

test.describe('right to left', () => {
  test.skip(({ appLocale }) => appLocale !== 'ar', 'the mirrored layout is Arabic only');

  test('mirrors the selected row’s edge and the composer', async ({ page, appLocale: locale }) => {
    await signIn(page, locale);
    await openTicket(page, locale);

    // The edge is the row's own (the `li`), since the checkbox sits beside the link (M14-04).
    const row = page
      .locator('li[data-ticket-id]')
      .filter({ has: page.getByRole('link', { name: /HD-1042/ }) });
    // DESIGN §6.3: the 3 px edge is at the inline start, which is the right
    // edge in Arabic — so it is the *left* border that must be absent.
    await expect(row).toHaveCSS('border-right-width', '3px');
    await expect(row).toHaveCSS('border-left-width', '0px');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('keeps the ticket reference and the address in Latin order', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    // `<bdi>` around a Latin run inside an Arabic line (DESIGN §7).
    await expect(
      page
        .getByRole('region', { name: t('tickets:header.label') })
        .locator('bdi')
        .first(),
    ).toHaveText('HD-1042');
  });
});
