import type { Page } from '@playwright/test';
import {
  expect,
  LOCALES,
  type Locale,
  openWidget,
  server,
  strings,
  test,
  violations,
  widgetWindow,
} from './fixtures.js';

/**
 * The satisfaction card after a conversation ends (M8-06, `Widget/CSAT-EN`,
 * `Widget/CSAT-AR`), with the mock transport, in both languages and both
 * schemes, by keyboard, with axe on every state: the card, the thanks, Skip,
 * a rating that fails, and the closed note thirty days on.
 */

/** A conversation the agent answered and ended, with the survey job's card offered. */
async function endWithCard(page: Page, locale: Locale, card = ''): Promise<void> {
  const t = strings(locale);
  await openWidget(page, locale);
  await page.keyboard.type('My refund for order 8841 has not arrived.');
  await page.keyboard.press('Enter');
  await expect(page.getByText(t('message.sent'))).toBeVisible();
  await server(
    page,
    `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'The trace is back.'); mock.end(); mock.offerCsat(${card});`,
  );
}

for (const locale of LOCALES) {
  const t = strings(locale);
  const score = (rating: number) =>
    t('csat.choice', { rating, label: t(`csat.ratings.${String(rating)}`) });

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${locale} ${scheme}`, () => {
      test.use({ colorScheme: scheme });

      test('rates the conversation by keyboard and thanks the visitor', async ({ page }) => {
        await endWithCard(page, locale);
        const window = widgetWindow(page, locale);
        const card = window.getByRole('form', { name: t('csat.question') });

        await expect(card).toBeVisible();
        // The card replaces the composer until it is answered or skipped.
        await expect(window.getByRole('textbox', { name: t('composer.label') })).toHaveCount(0);
        await expect(card.getByRole('group', { name: t('csat.legend') })).toBeVisible();
        const send = card.getByRole('button', { name: t('csat.send') });
        await expect(send).toBeDisabled();
        expect(await violations(page)).toEqual([]);

        await card.getByRole('button', { name: score(4) }).focus();
        await page.keyboard.press('Enter');
        await expect(card.getByRole('button', { name: score(4) })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await card.getByRole('textbox').fill('Quick and clear, thanks Lina.');
        await expect(send).toBeEnabled();
        expect(await violations(page)).toEqual([]);
        await send.focus();
        await page.keyboard.press('Enter');

        const thanks = window.getByRole('status').filter({ hasText: t('csat.thanks') });
        await expect(thanks).toBeVisible();
        await expect(thanks).toContainText(
          t('csat.rated', { rating: 4, label: t('csat.ratings.4') }),
        );
        await expect(thanks).toContainText('Quick and clear, thanks Lina.');
        await expect(
          window.getByRole('button', { name: t('ended.newConversation') }),
        ).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test('Skip records nothing and leaves a line in the log', async ({ page }) => {
        await endWithCard(page, locale);
        const window = widgetWindow(page, locale);

        await window.getByRole('button', { name: t('csat.skip') }).focus();
        await page.keyboard.press('Enter');

        await expect(window.getByText(t('csat.skipped'), { exact: false })).toBeVisible();
        await expect(window.getByRole('form', { name: t('csat.question') })).toHaveCount(0);
        await expect(
          window.getByRole('button', { name: t('ended.newConversation') }),
        ).toBeVisible();
        const rated = await page.evaluate(
          () =>
            (
              window as unknown as { helpdock: { mock: { calls: { method: string }[] } } }
            ).helpdock.mock.calls.filter((call) => call.method === 'rateConversation').length,
        );
        expect(rated).toBe(0);
        expect(await violations(page)).toEqual([]);
      });

      test('says a rating was not sent and keeps the card', async ({ page }) => {
        await endWithCard(page, locale);
        await server(page, 'mock.failNextRating();');
        const window = widgetWindow(page, locale);
        const card = window.getByRole('form', { name: t('csat.question') });

        await card.getByRole('button', { name: score(2) }).click();
        await card.getByRole('button', { name: t('csat.send') }).click();

        await expect(card.getByRole('alert')).toHaveText(t('csat.failed'));
        await expect(card.getByRole('button', { name: score(2) })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        expect(await violations(page)).toEqual([]);
      });

      test('shows the closed note after thirty days', async ({ page }) => {
        await endWithCard(
          page,
          locale,
          `{ state: 'expired', rating: null, comment: null, skipped_at: null }`,
        );
        const window = widgetWindow(page, locale);

        await expect(window.getByRole('note')).toContainText(t('csat.closedTitle'));
        await expect(window.getByRole('note')).toContainText(t('csat.closedBody'));
        await expect(window.getByRole('form', { name: t('csat.question') })).toHaveCount(0);
        expect(await violations(page)).toEqual([]);
      });
    });
  }
}
