import {
  expect,
  LOCALES,
  openWidget,
  server,
  startClockBeforeOpening,
  strings,
  test,
  violations,
} from './fixtures.js';

/**
 * The widget on an empty host page with the mock transport (`harness/`),
 * driven with the keyboard only, in every mode and both languages, with axe
 * on each state (M4-05, M4-06, M4-07, M4-08, M4-11).
 */
for (const locale of LOCALES) {
  const t = strings(locale);

  test.describe(`${locale}`, () => {
    test('chat: send by keyboard, Sent then Seen, Escape returns focus to the launcher', async ({
      page,
    }) => {
      await openWidget(page, locale);
      const window = page.getByRole('region', { name: t('window.label') });
      const composer = window.getByRole('textbox', { name: t('composer.label') });
      await expect(composer).toBeFocused();
      await expect(page.locator('helpdock-widget')).toHaveAttribute(
        'dir',
        locale === 'ar' ? 'rtl' : 'ltr',
      );
      expect(await violations(page)).toEqual([]);

      await page.keyboard.type('Hi, my refund for order 8841 has not arrived.');
      await page.keyboard.press('Enter');
      const log = window.getByRole('log', { name: t('thread.label') });
      await expect(log.getByText('Hi, my refund for order 8841 has not arrived.')).toBeVisible();
      await expect(log.getByText(t('message.sent'))).toBeVisible();

      await server(page, `mock.emit({ type: 'receipt', kind: 'read', seq: 1 });`);
      await expect(log.getByText(t('message.seen'))).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.keyboard.press('Escape');
      await expect(window).toBeHidden();
      await expect(page.getByRole('button', { name: t('launcher.open') })).toBeFocused();
    });

    test('chat: a send that keeps failing shows Not sent, and Retry by keyboard sends it once', async ({
      page,
    }) => {
      await openWidget(page, locale);
      await server(page, 'mock.failNextSends(1000);');
      await page.keyboard.type('Can someone check the bank reference?');
      await page.keyboard.press('Enter');

      const retry = page.getByRole('button', { name: t('message.retry') });
      await expect(retry).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(t('message.notSent'))).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await server(page, 'mock.failNextSends(0);');
      await retry.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText(t('message.sent'))).toBeVisible();
      const count = await page.evaluate(
        () =>
          (
            window as unknown as {
              helpdock: { mock: { messages: { author: { kind: string } }[] } };
            }
          ).helpdock.mock.messages.filter((message) => message.author.kind === 'visitor').length,
      );
      expect(count).toBe(1);
    });

    test('chat: reconnecting, then catch-up with the new-messages divider', async ({ page }) => {
      await openWidget(page, locale);
      await page.keyboard.type('Great, how long does a trace take?');
      await page.keyboard.press('Enter');
      await expect(page.getByText(t('message.sent'))).toBeVisible();

      await server(page, 'mock.dropConnection();');
      await expect(page.getByText(t('connection.reconnectingTitle'))).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await server(
        page,
        `mock.storeSilently(agent, 'Thanks, I have asked the bank team for the trace.'); mock.restoreConnection();`,
      );
      await expect(page.getByText(t('connection.back'))).toBeVisible();
      await expect(page.getByText(t('connection.newMessages', { count: 1 }))).toBeVisible();
      await expect(
        page.getByText('Thanks, I have asked the bank team for the trace.'),
      ).toBeVisible();
    });

    test('chat: queue position, agent, typing, and the ended state with a transcript', async ({
      page,
    }) => {
      await openWidget(page, locale, 'prechat=1');
      await expect(page.getByRole('heading', { name: t('prechat.title') })).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.keyboard.type('Omar Khalil');
      await page.keyboard.press('Tab');
      await page.keyboard.type('omar.k@example');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.type('My refund for order 8841 has not arrived.');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect(page.getByText(t('prechat.invalidEmail'))).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.getByRole('textbox', { name: t('prechat.email') }).fill('omar.k@example.com');
      await page.getByRole('button', { name: t('prechat.submit') }).focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByText(
          t('thread.talkingTo', {
            team: t('header.chatTitle', { brand: 'Helpdock' }),
            email: 'omar.k@example.com',
          }),
        ),
      ).toBeVisible();

      await server(page, `mock.emit({ type: 'queue', position: 2, eta_seconds: 180 });`);
      await expect(page.getByText(t('header.caption.queued'))).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await server(
        page,
        `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'Hi Omar'); mock.emit({ type: 'typing', typing: true, agent });`,
      );
      await expect(page.getByRole('heading', { name: 'Lina Haddad' })).toBeVisible();
      await expect(page.getByText(t('thread.typing', { name: 'Lina' }))).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await server(page, 'mock.end();');
      const transcript = page.getByRole('textbox', { name: t('ended.transcriptLabel') });
      await expect(transcript).toHaveValue('omar.k@example.com');
      expect(await violations(page)).toEqual([]);
      await transcript.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText(t('ended.sent', { email: 'omar.k@example.com' }))).toBeVisible();
      await page.getByRole('button', { name: t('ended.newConversation') }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: t('prechat.title') })).toBeVisible();
    });

    test('chat: out of hours with the next opening, and a refused attachment', async ({ page }) => {
      await startClockBeforeOpening(page);
      await openWidget(page, locale, 'availability=closed');
      await expect(page.getByText(t('hours.closedTitle'))).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.locator('helpdock-widget input[type=file]').setInputFiles({
        name: 'unboxing.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.alloc(26 * 1024 * 1024),
      });
      await expect(page.getByRole('alert')).toContainText('unboxing.mp4');
      expect(await violations(page)).toEqual([]);
    });

    test('chat: record a voice message with the keyboard and send it', async ({ page }) => {
      await openWidget(page, locale);
      await page.keyboard.press('Tab');
      const mic = page.getByRole('button', { name: t('composer.voice') });
      await expect(mic).toBeFocused();
      await page.keyboard.press('Enter');

      const stop = page.getByRole('button', { name: t('voice.stop') });
      await expect(stop).toBeFocused();
      await expect(page.getByRole('timer')).toBeVisible();
      await expect(page.getByRole('form', { name: t('voice.form') })).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.waitForTimeout(1_200);
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('button', { name: t('voice.play', { duration: '0:14' }) }),
      ).toBeVisible();
      await expect(page.getByText(t('message.sent'))).toBeVisible();
      await expect(page.getByRole('textbox', { name: t('composer.label') })).toBeFocused();
    });

    test('chat + suggested articles: the strip appears while typing and opens an article', async ({
      page,
    }) => {
      await openWidget(page, locale, 'mode=chat_articles');
      await page.keyboard.type(locale === 'ar' ? 'استرداد' : 'refund');
      const strip = page.getByRole('navigation', { name: t('articles.suggested') });
      // M5-10: help center search on the text; the fixture has one article about refunds.
      await expect(strip.getByRole('link')).toHaveCount(1);
      expect(await violations(page)).toEqual([]);

      await strip.getByRole('link').first().focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('link', { name: t('articles.openInHelpCenter') })).toBeVisible();
      await expect(page.locator('helpdock-widget article h3')).toBeFocused();
      await page.getByRole('button', { name: t('articles.backToChat') }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('log')).toBeVisible();
    });

    test('help center: search, open an article, back', async ({ page }) => {
      await openWidget(page, locale, 'mode=helpcenter');
      const search = page.getByRole('searchbox', { name: t('articles.searchLabel') });
      await expect(search).toBeFocused();
      await expect(page.getByRole('list', { name: t('articles.popular') })).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.keyboard.type(locale === 'ar' ? 'إرجاع' : 'return');
      const results = page.getByRole('list', { name: t('articles.resultsLabel') });
      await expect(results.getByRole('link')).not.toHaveCount(0);

      await page.keyboard.type('zzzz');
      await expect(page.getByText(t('articles.none'))).toBeVisible();
      await search.fill('');

      await page
        .getByRole('list', { name: t('articles.popular') })
        .getByRole('link')
        .first()
        .focus();
      await page.keyboard.press('Enter');
      const back = page.getByRole('button', { name: t('articles.back') });
      await expect(back).toBeVisible();
      await expect(page.locator('helpdock-widget article h3')).toBeFocused();
      expect(await violations(page)).toEqual([]);
      await back.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('list', { name: t('articles.popular') })).toBeVisible();
    });

    test('contact form: required fields, then the reference number', async ({ page }) => {
      await openWidget(page, locale, 'mode=form&availability=open_offline');
      await expect(page.getByText(t('form.offline'))).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.getByRole('button', { name: t('form.submit') }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert')).toHaveCount(3);
      expect(await violations(page)).toEqual([]);

      await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
      await page.getByRole('textbox', { name: t('prechat.email') }).fill('omar.k@example.com');
      await page
        .getByRole('textbox', { name: t('form.message') })
        .fill('I need to change the delivery address.');
      await page.getByRole('button', { name: t('form.submit') }).focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByText(t('form.sentBody', { ref: 'HD-1043', email: 'omar.k@example.com' })),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: t('form.another') })).toBeFocused();
      expect(await violations(page)).toEqual([]);
    });

    test('dark theme passes axe and fits a 320 px phone without horizontal scroll', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await openWidget(page, locale, 'scheme=dark');
      await expect(page.locator('helpdock-widget')).toHaveAttribute('data-scheme', 'dark');
      expect(await violations(page)).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
    });
  });
}
