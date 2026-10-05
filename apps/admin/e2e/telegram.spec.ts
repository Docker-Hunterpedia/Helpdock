import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_GOOD_TOKEN, MOCK_REFUSED_TOKEN } from '../src/telegram/mock-api.js';
import { expect, test } from './fixtures.js';
import { openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M6-05 and the Telegram half of the ticket view in a real browser, in both
 * languages: Channels › Telegram (`Admin/Channels-Telegram`) — the list, Add
 * bot with a refused token and then a good one, a bot's page, Delete — and a
 * Telegram ticket (`Admin/Ticket-Telegram`).
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

const openTelegram = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
  await page.getByRole('tab', { name: t('channels:tabs.telegram') }).click();
  await page
    .getByRole('table', { name: t('channels:telegram.heading') })
    .getByRole('link', { name: '@helpdock_support_bot' })
    .waitFor();
};

test.describe('Channels › Telegram', () => {
  test('refuses a token Telegram does not know, then adds a bot whose token works', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTelegram(page, locale);
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('channels:addBot') }).click();
    const dialog = page.getByRole('dialog', { name: t('channels:telegram.add.title') });
    const token = dialog.getByLabel(t('channels:telegram.add.token'));
    const add = dialog.getByRole('button', { name: t('channels:telegram.add.submit') });
    await expect(add).toBeDisabled();

    await token.fill(MOCK_REFUSED_TOKEN);
    await dialog.getByRole('button', { name: t('channels:telegram.add.test') }).click();
    await expect(
      dialog.getByText(t('channels:telegram.add.refused', { detail: '401: Unauthorized' })),
    ).toBeVisible();
    await expect(token).toHaveAttribute('aria-invalid', 'true');
    await expect(add).toBeDisabled();
    expect(await violations(page)).toEqual([]);

    await token.fill(MOCK_GOOD_TOKEN);
    await dialog.getByRole('button', { name: t('channels:telegram.add.test') }).click();
    await expect(dialog.getByRole('status')).toContainText('@helpdock_2299_bot');
    await add.click();

    await expect(
      page.getByText(t('channels:telegram.toast.created', { username: 'helpdock_2299_bot' })),
    ).toBeVisible();
    await expect(
      page
        .getByRole('table', { name: t('channels:telegram.heading') })
        .getByRole('link', { name: '@helpdock_2299_bot' }),
    ).toBeVisible();
  });

  test('tests a bot’s connection, saves its welcome, and deletes it by name', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTelegram(page, locale);

    await page.getByRole('link', { name: '@helpdock_billing_bot', exact: true }).click();
    const form = page.getByRole('form', { name: '@helpdock_billing_bot' });
    await expect(
      form.getByLabel(t('channels:telegram.detail.connection.masked', { hint: '91c0' })),
    ).toHaveValue('•••• 91c0');
    expect(await violations(page)).toEqual([]);

    await form.getByRole('button', { name: t('channels:telegram.detail.connection.test') }).click();
    await expect(form.getByRole('status')).toContainText('@helpdock_billing_bot');

    await form.getByLabel(t('channels:telegram.detail.welcome.ar')).fill('أهلًا بك في الفوترة.');
    await form.getByRole('button', { name: t('channels:telegram.detail.footer.save') }).click();
    await expect(
      page.getByText(t('channels:telegram.toast.saved', { username: 'helpdock_billing_bot' })),
    ).toBeVisible();

    await page.getByRole('button', { name: t('channels:telegram.detail.danger.action') }).click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', {
      name: t('channels:telegram.deleteConfirm.action'),
    });
    await dialog.getByRole('textbox').fill('@helpdock_billing');
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox').fill('@helpdock_billing_bot');
    await confirm.click();

    await expect(
      page.getByText(t('channels:telegram.toast.deleted', { username: 'helpdock_billing_bot' })),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: '@helpdock_billing_bot', exact: true }),
    ).toHaveCount(0);
  });
});

test.describe('a Telegram ticket', () => {
  test('names the chat, plays nothing until asked, and retries a reply Telegram refused', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1039');

    const header = page.getByRole('region', { name: t('tickets:header.label') });
    await expect(header.getByText(/@sara_h/)).toBeVisible();
    const identity = page.getByRole('region', { name: t('tickets:telegram.identity.heading') });
    await expect(identity.getByText('884413201')).toBeVisible();

    const thread = page.getByRole('list', { name: t('tickets:thread.label') });
    await expect(
      thread.getByRole('button', { name: t('tickets:telegram.voice.play', { duration: '0:14' }) }),
    ).toBeVisible();
    await expect(
      thread.getByRole('link', {
        name: t('tickets:telegram.location.openLabel', { coordinates: '24.7136, 46.6753' }),
      }),
    ).toBeVisible();
    await expect(thread.getByText(t('tickets:telegram.notDelivered'))).toBeVisible();
    const composer = page.getByRole('form', { name: t('tickets:composer.label') });
    await expect(composer.getByText(t('tickets:telegram.composerTo'))).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await thread.getByRole('button', { name: t('tickets:telegram.retryLabel') }).click();
    await expect(page.getByText(t('tickets:telegram.retried'))).toBeVisible();
    await expect(thread.getByText(t('tickets:telegram.notDelivered'))).toHaveCount(0);
  });
});
