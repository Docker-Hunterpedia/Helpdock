import type { Page } from '@playwright/test';
import { isolate } from '../src/screens/tickets/format.js';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M1-09 in a real browser, in both languages: the ⋯ menu, the merge and split
 * dialogs, and what each ticket's thread draws afterwards
 * (`AdminTicketDialogs` panels 1, 2, 4 and 7).
 *
 * A reference inside a translated sentence is wrapped in the Unicode isolates
 * (`isolate` in `format.ts`), so an Arabic sentence keeps `HD-1042` whole; the
 * expectations below build the sentence the same way.
 */

const openMenuItem = async (page: Page, label: string): Promise<void> => {
  await page.getByRole('menuitem', { name: label }).click();
};

test.describe('merge', () => {
  test('closes a ticket into another, shows its messages inline there, and undoes it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page.getByRole('button', { name: t('tickets:header.more') }).click();
    await openMenuItem(page, t('tickets:actions.merge'));

    const dialog = page.getByRole('dialog', { name: t('tickets:merge.title') });
    await dialog
      .getByRole('searchbox', { name: t('tickets:merge.searchLabel', { reference: 'HD-1042' }) })
      .fill('VAT');
    await dialog.getByRole('radio').first().check();
    await dialog
      .getByRole('button', { name: t('tickets:merge.submit', { reference: 'HD-1035' }) })
      .click();

    await expect(
      page.getByRole('status').filter({
        hasText: t('tickets:toast.merged', { reference: 'HD-1035' }),
      }),
    ).toBeVisible();

    const thread = page.getByRole('list', { name: t('tickets:thread.label') });
    await expect(
      thread.getByText(t('tickets:merged.from', { reference: isolate('HD-1042') })),
    ).toBeVisible();
    await expect(thread.getByText(/order 42 three weeks ago/)).toBeVisible();

    await thread.getByRole('button', { name: t('tickets:merged.unmerge', { hours: 24 }) }).click();
    await expect(
      page.getByRole('status').filter({
        hasText: t('tickets:toast.unmerged', { reference: 'HD-1042' }),
      }),
    ).toBeVisible();
    await expect(
      thread.getByText(t('tickets:merged.from', { reference: isolate('HD-1042') })),
    ).toHaveCount(0);
  });

  test('asks for a ticket before merging, and says when the search finds none', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page.getByRole('button', { name: t('tickets:header.more') }).click();
    await openMenuItem(page, t('tickets:actions.merge'));
    const dialog = page.getByRole('dialog', { name: t('tickets:merge.title') });

    await dialog.getByRole('button', { name: t('tickets:merge.submitNone') }).click();
    await expect(dialog.getByText(t('tickets:merge.pickOne'))).toBeVisible();

    await dialog.getByRole('searchbox').fill('nothing like this at all');
    await expect(dialog.getByText(t('tickets:merge.noMatches'))).toBeVisible();
  });
});

test.describe('split', () => {
  test('copies the ticked messages onto a new ticket and opens it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page.getByRole('button', { name: t('tickets:header.more') }).click();
    await openMenuItem(page, t('tickets:actions.split'));
    const dialog = page.getByRole('dialog', { name: t('tickets:split.title') });

    await dialog.getByRole('checkbox').first().check();
    await expect(dialog.getByText(t('tickets:split.messages', { count: 1 }))).toBeVisible();
    await dialog
      .getByRole('textbox', { name: t('tickets:split.subject') })
      .fill('The return label');
    await dialog.getByRole('button', { name: t('tickets:split.submit') }).click();

    await expect(
      page.getByRole('status').filter({
        hasText: t('tickets:toast.created', { reference: 'HD-1043' }),
      }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).last()).toContainText('The return label');
    await expect(
      page
        .getByRole('list', { name: t('tickets:thread.label') })
        .getByRole('link', { name: 'HD-1042' }),
    ).toBeVisible();
  });

  test('refuses to split nothing', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    await page.getByRole('button', { name: t('tickets:header.more') }).click();
    await openMenuItem(page, t('tickets:actions.split'));
    const dialog = page.getByRole('dialog', { name: t('tickets:split.title') });

    await dialog.getByRole('button', { name: t('tickets:split.submit') }).click();

    await expect(dialog.getByText(t('tickets:split.pickOne'))).toBeVisible();
    await expect(dialog.getByText(t('tickets:split.subjectRequired'))).toBeVisible();
  });
});
