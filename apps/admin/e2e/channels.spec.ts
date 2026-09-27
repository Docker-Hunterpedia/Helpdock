import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M2 inbound in a real browser, in both languages: Channels › Mailboxes and
 * the mailbox form (`Admin · email channel`, `Admin · mailbox form`), and the
 * email card with its threading-mismatch line in the ticket workspace
 * (`Admin · ticket email`).
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

/** Through the sidebar, because the fixture's session lives in memory and a reload signs out. */
async function openChannels(page: Page, locale: 'en' | 'ar'): Promise<void> {
  const t = strings(locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
  await page.getByRole('heading', { name: t('channels:mailboxes.heading'), level: 2 }).waitFor();
}

test.describe('Channels › Mailboxes', () => {
  test('lists every mailbox with its health, and the inbound-parse endpoints', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openChannels(page, locale);

    const failing = page.getByRole('row').filter({ hasText: 'billing@helpdock.io' });
    await expect(failing).toContainText(t('channels:health.auth'));
    await expect(page.getByRole('row').filter({ hasText: 'returns@helpdock.io' })).toContainText(
      t('channels:health.behind'),
    );
    await expect(page.getByText('/internal/inbound-parse/postmark')).toBeVisible();

    expect(await violations(page)).toEqual([]);
  });

  test('adds an inbound-parse mailbox, and refuses an address already taken', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openChannels(page, locale);

    await page.getByRole('link', { name: t('channels:addMailbox') }).click();
    await page.getByRole('heading', { name: t('channels:form.addTitle'), level: 1 }).waitFor();
    await page.getByRole('radio', { name: new RegExp(t('channels:form.incoming.parse')) }).check();
    await page.getByLabel(t('channels:form.address.email')).fill('support@helpdock.io');
    await page.getByLabel(t('channels:form.address.displayName')).fill('Duplicate');
    await page.getByRole('button', { name: t('channels:form.footer.create') }).click();
    await expect(page.getByRole('alert')).toContainText(t('channels:refusal.address-taken'));

    await page.getByLabel(t('channels:form.address.email')).fill('sales@helpdock.io');
    await page.getByRole('button', { name: t('channels:form.footer.create') }).click();
    await expect(page.getByRole('heading', { name: 'sales@helpdock.io', level: 1 })).toBeVisible();

    expect(await violations(page)).toEqual([]);
  });

  test('tests IMAP on a saved mailbox and draws the server’s refusal', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openChannels(page, locale);

    await page.getByRole('link', { name: 'billing@helpdock.io', exact: true }).click();
    await page.getByRole('heading', { name: 'billing@helpdock.io', level: 1 }).waitFor();

    await page.getByRole('button', { name: t('channels:form.test.button') }).click();
    await expect(page.getByRole('status').filter({ hasText: 'imap.fastmail.com' })).toBeVisible();

    await page.getByRole('button', { name: t('channels:form.incoming.replacePassword') }).click();
    await page.getByLabel(t('channels:form.incoming.password'), { exact: true }).fill('wrong');
    await page.getByRole('button', { name: t('channels:form.test.button') }).click();
    const refused = page.getByRole('alert');
    await expect(refused).toContainText(t('channels:form.test.auth.title'));
    await expect(refused).toContainText('AUTHENTICATIONFAILED');

    expect(await violations(page)).toEqual([]);
  });
});

test.describe('the email card in the thread', () => {
  test('blocks remote images until loaded, expands quoted text and names a mismatch', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1035');

    const card = page.getByRole('article', {
      name: new RegExp(`^${t('tickets:email.label', { name: '' }).trim()}`),
    });
    await expect(card).toContainText('k.nasser@acme.de');
    await expect(card.getByText('mail.acme.de')).toBeVisible();

    await card.getByRole('button', { name: t('tickets:email.loadImages') }).click();
    await expect(card.getByRole('img')).toHaveCount(2);

    await card.getByRole('button', { name: t('tickets:email.showQuoted') }).click();
    await expect(card.getByText('Your invoice 2291 is attached.')).toBeVisible();

    const note = page.getByRole('note');
    await expect(
      note.getByRole('link', { name: t('tickets:email.mismatch.open', { ticket: 'HD-1042' }) }),
    ).toBeVisible();

    expect(await violations(page)).toEqual([]);
  });
});
