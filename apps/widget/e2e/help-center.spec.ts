import { expect, LOCALES, openWidget, server, strings, test, violations } from './fixtures.js';

/**
 * The widget's help center over the transport's search and article reads
 * (M5-10), and "Still need help?" from a help center article (M5-08), on the
 * harness with the mock transport, in both languages, keyboard only, with axe
 * on each state.
 */

const GIFT = {
  en: { query: 'gift receipt', title: 'Exchanging a gift', body: 'Use the gift receipt number' },
  ar: { query: 'إيصال الهدية', title: 'استبدال هدية', body: 'استخدم رقم إيصال الهدية' },
} as const;

for (const locale of LOCALES) {
  const t = strings(locale);
  const gift = GIFT[locale];

  test.describe(`${locale}`, () => {
    test('help center: finds an article beyond the popular list and reads it in the window', async ({
      page,
    }) => {
      await openWidget(page, locale, 'mode=helpcenter');
      const popular = page.getByRole('list', { name: t('articles.popular') });
      await expect(popular.getByRole('link')).toHaveCount(3);
      await expect(popular.getByText(gift.title)).toHaveCount(0);

      await page.keyboard.type(gift.query);
      const results = page.getByRole('list', { name: t('articles.resultsLabel') });
      await expect(results.getByRole('link')).toHaveCount(1);
      await expect(page.getByRole('status')).toHaveText(
        t('articles.results', { count: 1, query: gift.query }),
      );
      expect(await violations(page)).toEqual([]);

      await results.getByRole('link').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText(gift.body)).toBeVisible();
      await expect(page.locator('helpdock-widget article h3')).toBeFocused();
      // The fixture's article has no help center address, so there is no link out.
      await expect(page.getByRole('link', { name: t('articles.openInHelpCenter') })).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });

    test('help center: an article that cannot load says so', async ({ page }) => {
      await openWidget(page, locale, 'mode=helpcenter');
      await expect(page.getByRole('list', { name: t('articles.popular') })).toBeVisible();

      await server(page, 'mock.dropConnection();');
      await page
        .getByRole('list', { name: t('articles.popular') })
        .getByRole('link')
        .first()
        .focus();
      await page.keyboard.press('Enter');

      await expect(page.getByRole('alert')).toHaveText(t('articles.loadFailed'));
      expect(await violations(page)).toEqual([]);
    });

    test('chat + articles: "Still need help?" opens the widget and the conversation names the article', async ({
      page,
    }) => {
      const article = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
      await page.goto(`/?locale=${locale}&mode=chat_articles`);
      await expect(page.getByRole('button', { name: t('launcher.open') })).toBeVisible();

      await page.evaluate(
        (id) =>
          (window as unknown as { Helpdock: (...args: unknown[]) => void }).Helpdock('open', {
            article: id,
          }),
        article,
      );
      const composer = page.getByRole('textbox', { name: t('composer.label') });
      await expect(composer).toBeVisible();
      await composer.fill(locale === 'ar' ? 'ما زلت بحاجة إلى مساعدة' : 'I still need help');
      await composer.press('Enter');
      await expect(page.getByText(t('message.sent'))).toBeVisible();

      const starts = await page.evaluate(() =>
        (
          window as unknown as {
            helpdock: { mock: { calls: { method: string; args: unknown[] }[] } };
          }
        ).helpdock.mock.calls.filter((call) => call.method === 'startConversation'),
      );
      expect(starts.map((call) => call.args[0])).toEqual([{ article_id: article }]);
    });
  });
}
