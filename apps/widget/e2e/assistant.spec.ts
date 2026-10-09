import type { Page } from '@playwright/test';
import { expect, LOCALES, openWidget, server, strings, test, violations } from './fixtures.js';

/**
 * The assistant in the widget (M7-06, `Widget/AI-EN`, `Widget/AI-AR`) on the
 * harness with the mock transport playing the server: the answer with its
 * badge, sources and feedback, "Talk to a human" by keyboard, and the
 * low-confidence handoff, with axe on each state, in both languages.
 */

const answer = `const { answer } = window.helpdock.ai; mock.aiReply(answer.body, answer.ai);`;
const handoff = `const { handoff } = window.helpdock.ai; mock.aiReply(handoff, { kind: 'handoff', citations: [], feedback: null });`;

for (const locale of LOCALES) {
  const t = strings(locale);

  test.describe(`${locale}`, () => {
    test('an answer is named, badged and sourced; feedback and "Talk to a human" work by keyboard', async ({
      page,
    }) => {
      await openWidget(page, locale);
      await page.keyboard.type(
        locale === 'ar' ? 'كم يستغرق الاسترداد؟' : 'How long does a refund take?',
      );
      await page.keyboard.press('Enter');
      const window = page.getByRole('region', { name: t('window.label') });
      const log = window.getByRole('log', { name: t('thread.label') });
      await expect(log.getByText(t('message.sent'))).toBeVisible();

      await server(page, answer);
      await expect(log.getByText(t('ai.author', { brand: 'Helpdock' }))).toBeVisible();
      await expect(log.getByText(t('ai.badge'), { exact: true })).toBeVisible();
      const sources = log.getByRole('list', { name: t('ai.sources') });
      await expect(sources.getByRole('link')).toHaveCount(2);
      const talk = window.getByRole('button', { name: t('ai.talkToHuman') });
      await expect(talk).toBeVisible();
      expect(await violations(page)).toEqual([]);

      const helpful = log.getByRole('button', { name: t('ai.yes') });
      await helpful.focus();
      await page.keyboard.press('Enter');
      await expect(log.getByRole('status')).toHaveText(t('ai.thanks'));

      await talk.focus();
      await page.keyboard.press('Enter');
      await expect(log.getByText(t('ai.connecting'))).toBeVisible();
      await expect(talk).toBeHidden();
      expect(await violations(page)).toEqual([]);
    });

    test('a low-confidence answer is the handoff text in the assistant bubble, then the line', async ({
      page,
    }) => {
      await openWidget(page, locale);
      await page.keyboard.type(
        locale === 'ar' ? 'هل يمكنني تغيير العنوان؟' : 'Can I change the address?',
      );
      await page.keyboard.press('Enter');
      const window = page.getByRole('region', { name: t('window.label') });
      const log = window.getByRole('log', { name: t('thread.label') });
      await expect(log.getByText(t('message.sent'))).toBeVisible();

      await server(page, handoff);

      await expect(log.getByText(t('ai.connecting'))).toBeVisible();
      await expect(log.getByRole('group', { name: t('ai.helpful') })).toHaveCount(0);
      await expect(window.getByRole('button', { name: t('ai.talkToHuman') })).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });

    test('a cited source opens its article in the window', async ({ page }) => {
      await openWidget(page, locale);
      await page.keyboard.type('Refund?');
      await page.keyboard.press('Enter');
      const window = page.getByRole('region', { name: t('window.label') });
      await expect(window.getByText(t('message.sent'))).toBeVisible();
      await server(page, answer);

      const source = window
        .getByRole('list', { name: t('ai.sources') })
        .getByRole('link')
        .first();
      await source.focus();
      await page.keyboard.press('Enter');

      await expect(window.getByRole('heading', { level: 2 })).toBeVisible();
    });

    // M7-06, panel 6 "Handoff out of hours": Friday 21:40 in Dubai, the team opens on Sunday at 09:00.
    test.describe('out of hours', () => {
      const FRIDAY_EVENING = '2026-09-25T17:40:00Z';
      const sunday = locale === 'ar' ? 'الأحد' : 'Sunday';
      const gulf = locale === 'ar' ? 'توقيت الخليج' : 'Gulf Standard Time';
      const awayUntilSunday = t('ai.awayWeekday', { day: sunday, time: '09:00', zone: gulf });

      const ask = async (page: Page) => {
        await page.keyboard.type(
          locale === 'ar' ? 'كم يستغرق الاسترداد؟' : 'How long is a refund?',
        );
        await page.keyboard.press('Enter');
        const window = page.getByRole('region', { name: t('window.label') });
        const log = window.getByRole('log', { name: t('thread.label') });
        await expect(log.getByText(t('message.sent'))).toBeVisible();
        return { window, log };
      };

      test('"Talk to a human" says the team is away until Sunday, and the header agrees', async ({
        page,
      }) => {
        await page.clock.setFixedTime(FRIDAY_EVENING);
        await openWidget(page, locale, 'availability=closed');
        const { window, log } = await ask(page);
        await server(page, answer);
        const talk = window.getByRole('button', { name: t('ai.talkToHuman') });
        await expect(talk).toBeVisible();

        await talk.focus();
        await page.keyboard.press('Enter');

        await expect(log.getByText(awayUntilSunday, { exact: true })).toBeVisible();
        await expect(log.getByText(t('ai.awaySaved'))).toBeVisible();
        await expect(log.getByText(t('ai.connecting'))).toHaveCount(0);
        await expect(
          window.getByText(t('header.caption.closed', { day: sunday, time: '09:00' })),
        ).toBeVisible();
        await expect(talk).toHaveCount(0);
        expect(await violations(page)).toEqual([]);
      });

      test('the assistant handing off after hours is its text in the bubble, then the away line with the email', async ({
        page,
      }) => {
        await page.clock.setFixedTime(FRIDAY_EVENING);
        await openWidget(page, locale, 'availability=closed&prechat=1');
        await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
        await page.getByRole('textbox', { name: t('prechat.email') }).fill('omar.k@example.com');
        await page
          .getByRole('textbox', { name: t('prechat.message') })
          .fill('Can I change the address?');
        await page.getByRole('button', { name: t('prechat.submit') }).focus();
        await page.keyboard.press('Enter');
        const log = page
          .getByRole('region', { name: t('window.label') })
          .getByRole('log', { name: t('thread.label') });
        await expect(log.getByText(t('message.sent'))).toBeVisible();

        await server(page, handoff);

        await expect(log.getByText(awayUntilSunday, { exact: true })).toBeVisible();
        await expect(
          log.getByText(t('ai.awaySavedEmail', { email: 'omar.k@example.com' })),
        ).toBeVisible();
        await expect(log.locator('li').filter({ hasText: awayUntilSunday })).toHaveCount(1);
        expect(await violations(page)).toEqual([]);
      });

      test('a server that sends no hours is worded from the brand’s availability, and a calendar that never opens reads "away right now"', async ({
        page,
      }) => {
        await page.clock.setFixedTime(FRIDAY_EVENING);
        await openWidget(page, locale, 'availability=closed&hours=absent');
        let thread = await ask(page);
        await server(page, answer);
        await thread.window.getByRole('button', { name: t('ai.talkToHuman') }).focus();
        await page.keyboard.press('Enter');
        await expect(thread.log.getByText(awayUntilSunday, { exact: true })).toBeVisible();
        expect(await violations(page)).toEqual([]);

        await openWidget(page, locale, 'availability=closed&hours=never');
        thread = await ask(page);
        await server(page, answer);
        await thread.window.getByRole('button', { name: t('ai.talkToHuman') }).focus();
        await page.keyboard.press('Enter');
        await expect(thread.log.getByText(t('ai.awayNow'), { exact: true })).toBeVisible();
        await expect(thread.log.getByText(t('ai.awaySaved'))).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });
    });
  });
}
