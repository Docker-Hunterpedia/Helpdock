import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_TICKET_THREE_EMAILS } from '../src/tickets/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-31 in a real browser, in both languages (`Admin/Ticket-ListToggle-ReplyTo`, notes
 * "M14-31 · reply to one message"): the Reply button on each customer email, the strip above
 * the text and the outline on the email it names, what clears it, the "In reply to" link a
 * sent reply carries, and the thread with the strip open passing axe.
 */

test.use({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });

/**
 * The ticket is left out of every list, so it is opened by its address. The fixture keeps
 * its session in memory, so a `page.goto` would sign the browser out: the router is told
 * instead.
 */
const openThreeEmails = async (page: Page, locale: 'en' | 'ar') => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.evaluate((id) => {
    window.history.pushState({}, '', `/tickets/${id}?view=all`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, MOCK_TICKET_THREE_EMAILS);
  const thread = page.getByRole('list', { name: t('tickets:thread.label') });
  await expect(thread).toBeVisible();
  const form = page.getByRole('form', { name: t('tickets:composer.label') });
  const name = 'Mona Khalil';

  return {
    t,
    thread,
    form,
    body: form.getByRole('textbox', { name: t('tickets:composer.bodyLabel') }),
    replyButtons: thread.getByRole('button', {
      name: t('tickets:replyTo.buttonLabel', { name }),
    }),
    strip: form.getByRole('group', { name: t('tickets:replyTo.stripLabel') }),
    clear: form.getByRole('button', { name: t('tickets:replyTo.clear') }),
  };
};

test.describe('replying to one email of a ticket', () => {
  test('answers the second of three emails, and the sent reply links back to it', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, thread, form, body, replyButtons, strip } = await openThreeEmails(page, locale);

    await expect(replyButtons).toHaveCount(3);
    await body.fill('The invoice is attached.');
    await replyButtons.nth(1).click();

    await expect(strip).toBeVisible();
    await expect(replyButtons.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(replyButtons.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(body).toBeFocused();
    await expect(body).toHaveValue('The invoice is attached.');

    // Moving the strip to another email keeps the draft and leaves one strip.
    await replyButtons.nth(2).click();
    await expect(replyButtons.nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(replyButtons.nth(1)).toHaveAttribute('aria-pressed', 'false');
    await replyButtons.nth(1).click();
    await expect(form.getByRole('group', { name: t('tickets:replyTo.stripLabel') })).toHaveCount(1);

    await form.getByRole('button', { name: t('tickets:email.send') }).click();

    const link = thread.getByRole('button', {
      name:
        t('tickets:replyTo.inReplyToLabel', { name: 'Mona Khalil', time: '@@' }).split('@@')[0] ??
        '',
    });
    await expect(link).toBeVisible();
    await expect(strip).toBeHidden();

    await link.click();
    const target = thread.getByRole('article', {
      name: t('tickets:email.label', { name: 'Mona Khalil' }),
    });
    await expect(target.nth(1)).toBeFocused();
  });

  test('clears with the × button and with the Internal note tab', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, form, body, replyButtons, strip, clear } = await openThreeEmails(page, locale);
    await body.fill('Kept');

    await replyButtons.nth(0).click();
    await expect(strip).toBeVisible();
    await clear.click();
    await expect(strip).toBeHidden();
    await expect(replyButtons.nth(0)).toHaveAttribute('aria-pressed', 'false');

    await replyButtons.nth(0).click();
    await form.getByRole('button', { name: t('tickets:composer.note') }).click();
    await expect(strip).toBeHidden();
    await expect(body).toHaveValue('Kept');
  });

  test('says the email is no longer available when the api refuses it, and holds Send', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, form, body, replyButtons, strip, clear } = await openThreeEmails(page, locale);
    const send = form.getByRole('button', { name: t('tickets:email.send') });

    // The fixture treats the last email as erased by the time a reply names it.
    await replyButtons.nth(2).click();
    await body.fill('The invoice is attached.');
    await send.click();

    await expect(strip.getByText(t('tickets:replyTo.unavailable'))).toBeVisible();
    await expect(body).toHaveValue('The invoice is attached.');
    await expect(send).toBeDisabled();

    // Clearing the strip lets the same text go as an ordinary reply.
    await clear.click();
    await expect(send).toBeEnabled();
    await send.click();
    await expect(strip).toBeHidden();
  });

  test('has no Reply button on the note or on the staff reply', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, thread, replyButtons } = await openThreeEmails(page, locale);

    await expect(thread.getByText(t('tickets:thread.note'), { exact: true })).toBeVisible();
    await expect(thread.getByRole('button', { name: /^(Reply to|الرد على)/ })).toHaveCount(3);
    await expect(replyButtons).toHaveCount(3);
  });

  test('passes axe with the strip open and the quote shown', async ({
    page,
    appLocale: locale,
  }) => {
    const { t, form, replyButtons, strip } = await openThreeEmails(page, locale);

    await replyButtons.nth(1).click();
    await strip.getByRole('button', { name: t('tickets:replyTo.showQuote') }).click();
    await expect(strip.getByRole('group', { name: t('tickets:replyTo.quoteLabel') })).toBeVisible();

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map(
        (violation) =>
          `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
      ),
    ).toEqual([]);
    await expect(form).toBeVisible();
  });
});
