import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openSecurity, openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M2-05, M2-06 and M2-08's outbound half in a real browser, in both languages:
 * Channels › Outgoing email (`AdminEmailOutgoing`), Your account › Email
 * signature (`AdminSignature`), and the ticket view's email mode and "Not
 * delivered" state (`AdminTicketEmail`).
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

const openOutgoing = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
  await page.getByRole('heading', { name: t('channels:smtp.heading') }).waitFor();
};

test.describe('Channels › Outgoing email', () => {
  test('tests the server, and shows a refusal in the relay’s words', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openOutgoing(page, locale);

    await expect(page.getByRole('tab', { name: t('channels:tabs.outgoing') })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await violations(page)).toEqual([]);

    const smtp = page.getByRole('region', { name: t('channels:smtp.heading') });
    await smtp.getByRole('button', { name: t('channels:smtp.test') }).click();
    await expect(smtp.getByRole('status')).toContainText(t('channels:smtp.testOk'));

    await smtp.getByLabel(t('channels:smtp.host')).fill('fail.example.com');
    await smtp.getByRole('button', { name: t('channels:smtp.test') }).click();
    await expect(smtp.getByRole('alert')).toContainText(t('channels:smtp.testFailed.auth-failed'));
    await expect(smtp.getByRole('alert')).toContainText('535 5.7.8');
  });

  test('saves a new department sender and turns on the out-of-hours reply', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openOutgoing(page, locale);

    const senders = page.getByRole('region', { name: t('channels:senders.heading') });
    await senders.getByRole('combobox', { name: t('channels:senders.addLabel') }).click();
    const department = (await page.getByRole('option').nth(1).textContent()) ?? '';
    await page.getByRole('option').nth(1).click();
    await senders.getByRole('button', { name: t('channels:senders.add') }).click();
    const from = senders.getByRole('textbox', {
      name: t('channels:senders.fromFor', { department }),
    });
    await from.fill('not a sender');
    await senders.getByRole('button', { name: t('channels:senders.save') }).click();
    await expect(senders.getByText(t('channels:senders.invalid'))).toBeVisible();

    await from.fill('Helpdock Support <help@helpdock.io>');
    await senders.getByRole('button', { name: t('channels:senders.save') }).click();
    await expect(page.getByText(t('channels:senders.saved'))).toBeVisible();

    const auto = page.getByRole('region', { name: t('channels:autoReplies.heading') });
    await auto.getByRole('switch', { name: t('channels:autoReplies.outOfHours') }).click();
    await auto.getByRole('button', { name: t('channels:autoReplies.save') }).click();
    await expect(page.getByText(t('channels:autoReplies.saved'))).toBeVisible();
  });

  test('edits a template with a preview in its own language', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openOutgoing(page, locale);

    await page
      .getByRole('button', {
        name: t('channels:autoReplies.editTemplate', {
          kind: t('channels:template.kinds.acknowledgment'),
          language: t('channels:template.languages.ar'),
        }),
      })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: t('channels:template.preview') }).click();
    await expect(dialog.getByText('HD-1039').first()).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await dialog.getByRole('button', { name: t('channels:template.save') }).click();
    await expect(page.getByText(t('channels:template.saved'))).toBeVisible();
  });

  test('retries and discards failed sends until none is left', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openOutgoing(page, locale);

    const failed = page.getByRole('region', { name: t('channels:failed.heading') });
    await expect(failed.getByRole('row')).toHaveCount(3);
    await failed
      .getByRole('button', {
        name: t('channels:failed.retryLabel', { recipient: 'mona@example.com', ticket: 'HD-1042' }),
      })
      .click();
    await expect(page.getByText(t('channels:failed.retried'))).toBeVisible();

    await failed
      .getByRole('button', {
        name: t('channels:failed.discardLabel', {
          recipient: 'k.nasser@acme.de',
          ticket: 'HD-1035',
        }),
      })
      .click();
    await expect(failed.getByText(t('channels:failed.empty'))).toBeVisible();
  });
});

test.describe('Your account › Email signature', () => {
  test('previews the signature and refuses a seventh line', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSecurity(page, locale);
    await page.getByRole('tab', { name: t('me:tabs.signature') }).click();
    await page.getByRole('heading', { name: t('me:signature.heading') }).waitFor();
    expect(await violations(page)).toEqual([]);

    const english = page.getByLabel(t('me:signature.en'), { exact: true });
    await english.fill('1\n2\n3\n4\n5\n6\n7');
    await page.getByRole('button', { name: t('me:signature.save') }).click();
    await expect(page.getByText(t('me:signature.tooManyLines'))).toBeVisible();

    await english.fill('Lina Haddad\nRefunds');
    await page.getByRole('button', { name: t('me:signature.save') }).click();
    await expect(page.getByText(t('me:signature.saved'))).toBeVisible();
    await expect(
      page
        .getByRole('complementary', { name: t('me:signature.previewHeading') })
        .getByText('Refunds')
        .first(),
    ).toBeVisible();
  });
});

test.describe('the ticket view by email', () => {
  test('shows From, To and the signature, and retries a reply that was not delivered', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    const composer = page.getByRole('form', { name: t('tickets:composer.label') });
    await expect(composer.getByRole('combobox', { name: t('tickets:email.from') })).toBeVisible();
    await expect(composer.getByText('mona@example.com')).toBeVisible();
    await expect(composer.getByText(t('tickets:email.signatureCaption'))).toBeVisible();

    const thread = page.getByRole('list', { name: t('tickets:thread.label') });
    await expect(thread.getByText(t('tickets:email.notDelivered'))).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await thread.getByRole('button', { name: t('tickets:email.retry') }).click();
    await expect(page.getByText(t('tickets:email.retried'))).toBeVisible();
    await expect(thread.getByText(t('tickets:email.notDelivered'))).toHaveCount(0);
  });
});
