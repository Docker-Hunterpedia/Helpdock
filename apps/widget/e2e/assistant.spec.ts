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
      await expect(log.getByText(t('ai.thanks'))).toBeVisible();

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
  });
}
