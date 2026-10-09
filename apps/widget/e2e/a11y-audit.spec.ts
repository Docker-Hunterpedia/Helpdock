import type { Page } from '@playwright/test';
import {
  expect,
  LOCALES,
  openWidget,
  server,
  startClockBeforeOpening,
  strings,
  tabStops,
  test,
  violations,
  widgetWindow,
} from './fixtures.js';

/**
 * The accessibility audit of the widget (M9-04, REQUIREMENTS §5.4, DESIGN
 * §10; results in `docs/completed/accessibility-audit.md`). Axe against WCAG
 * 2.1 A and AA on every mode and state, in both languages and both schemes,
 * then keyboard-only passes: the order of the stops, a visible ring on each,
 * the phone layout's focus trap, and Escape. `widget.spec.ts` and
 * `help-center.spec.ts` prove the flows; this file proves every screen they
 * pass through is clean in dark as well as light.
 */

const SCHEMES = ['light', 'dark'] as const;

/** Runs axe and keeps what it found under the name of the state. */
const audit = (page: Page, found: string[]) => async (state: string) => {
  for (const line of await violations(page)) {
    found.push(`${state}: ${line}`);
  }
};

for (const locale of LOCALES) {
  const t = strings(locale);

  for (const scheme of SCHEMES) {
    test.describe(`${locale} ${scheme}`, () => {
      test.use({ colorScheme: scheme });
      const query = (extra = '') => `scheme=${scheme}${extra ? `&${extra}` : ''}`;

      test('chat: launcher, thread, receipts, banners, voice, unread and the ended state', async ({
        page,
      }) => {
        const found: string[] = [];
        const check = audit(page, found);

        await page.goto(`/?locale=${locale}&${query()}`);
        await expect(page.getByRole('button', { name: t('launcher.open') })).toBeVisible();
        await check('launcher');

        await openWidget(page, locale, query());
        await check('chat, empty');

        await page.keyboard.type('Hi, my refund for order 8841 has not arrived.');
        await page.keyboard.press('Enter');
        await expect(page.getByText(t('message.sent'))).toBeVisible();
        await server(page, `mock.emit({ type: 'receipt', kind: 'read', seq: 1 });`);
        await expect(page.getByText(t('message.seen'))).toBeVisible();
        await check('chat, seen');

        await server(page, 'mock.dropConnection();');
        await expect(page.getByText(t('connection.reconnectingTitle'))).toBeVisible();
        await check('reconnecting');
        await server(page, `mock.storeSilently(agent, 'Checking now.'); mock.restoreConnection();`);
        await expect(page.getByText(t('connection.back'))).toBeVisible();
        await check('back online, new-messages divider');

        await page.getByRole('button', { name: t('composer.voice') }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('timer')).toBeVisible();
        await check('voice recording');
        await page.getByRole('button', { name: t('voice.stop') }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('textbox', { name: t('composer.label') })).toBeFocused();
        await check('voice note sent');

        await page.keyboard.press('Escape');
        await server(page, `mock.agentReply(agent, 'Your refund was issued today.');`);
        await expect(page.getByRole('button', { name: new RegExp(t('launcher.open')) })).toHaveText(
          /1/,
        );
        await check('launcher with an unread count');

        await page.keyboard.press('Enter');
        await expect(widgetWindow(page, locale)).toBeVisible();
        await server(page, 'mock.end();');
        await expect(page.getByRole('button', { name: t('ended.newConversation') })).toBeVisible();
        await check('ended');

        expect(found).toEqual([]);
      });

      test('chat: pre-chat form, its errors, queue, agent and typing', async ({ page }) => {
        const found: string[] = [];
        const check = audit(page, found);

        await openWidget(page, locale, query('prechat=1'));
        await check('pre-chat form');
        await page.getByRole('button', { name: t('prechat.submit') }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert').first()).toBeVisible();
        await check('pre-chat errors');

        await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
        await page.getByRole('textbox', { name: t('prechat.email') }).fill('omar.k@example.com');
        await page
          .getByRole('textbox', { name: t('prechat.message') })
          .fill('My refund for order 8841 has not arrived.');
        await page.getByRole('button', { name: t('prechat.submit') }).focus();
        await page.keyboard.press('Enter');
        await server(page, `mock.emit({ type: 'queue', position: 2, eta_seconds: 180 });`);
        await expect(page.getByText(t('header.caption.queued'))).toBeVisible();
        await check('queued');

        await server(
          page,
          `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'Hi Omar'); mock.emit({ type: 'typing', typing: true, agent });`,
        );
        await expect(page.getByText(t('thread.typing', { name: 'Lina' }))).toBeVisible();
        await check('agent typing');

        expect(found).toEqual([]);
      });

      test('chat: out of hours, open but offline, and a refused attachment', async ({ page }) => {
        const found: string[] = [];
        const check = audit(page, found);

        await startClockBeforeOpening(page);
        await openWidget(page, locale, query('availability=closed'));
        await expect(page.getByText(t('hours.closedTitle'))).toBeVisible();
        await check('out of hours');
        await page.locator('helpdock-widget input[type=file]').setInputFiles({
          name: 'unboxing.mp4',
          mimeType: 'video/mp4',
          buffer: Buffer.alloc(26 * 1024 * 1024),
        });
        await expect(page.getByRole('alert')).toContainText('unboxing.mp4');
        await check('refused attachment');

        await openWidget(page, locale, query('availability=open_offline'));
        await check('open, nobody online');

        expect(found).toEqual([]);
      });

      test('chat + articles: the suggestion strip and an article in the window', async ({
        page,
      }) => {
        const found: string[] = [];
        const check = audit(page, found);

        await openWidget(page, locale, query('mode=chat_articles'));
        await page.keyboard.type(locale === 'ar' ? 'استرداد' : 'refund');
        const strip = page.getByRole('navigation', { name: t('articles.suggested') });
        await expect(strip.getByRole('link')).toHaveCount(1);
        await check('suggestion strip');
        await strip.getByRole('link').first().focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('helpdock-widget article h3')).toBeFocused();
        await check('article from the strip');

        expect(found).toEqual([]);
      });

      test('help center mode: popular, results, nothing found, an article, a failed load', async ({
        page,
      }) => {
        const found: string[] = [];
        const check = audit(page, found);

        await openWidget(page, locale, query('mode=helpcenter'));
        const popular = page.getByRole('list', { name: t('articles.popular') });
        await expect(popular).toBeVisible();
        await check('popular articles');
        await page.keyboard.type(locale === 'ar' ? 'إرجاع' : 'return');
        await expect(
          page.getByRole('list', { name: t('articles.resultsLabel') }).getByRole('link'),
        ).not.toHaveCount(0);
        await check('results');
        await page.keyboard.type('zzzz');
        await expect(page.getByText(t('articles.none'))).toBeVisible();
        await check('nothing found');
        await page.getByRole('searchbox', { name: t('articles.searchLabel') }).fill('');
        await popular.getByRole('link').first().focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('helpdock-widget article h3')).toBeFocused();
        await check('article');

        await page.getByRole('button', { name: t('articles.back') }).focus();
        await page.keyboard.press('Enter');
        await server(page, 'mock.dropConnection();');
        await popular.getByRole('link').first().focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert')).toHaveText(t('articles.loadFailed'));
        await check('article that failed to load');

        expect(found).toEqual([]);
      });

      test('contact form: empty, its errors, and the reference number', async ({ page }) => {
        const found: string[] = [];
        const check = audit(page, found);

        await openWidget(page, locale, query('mode=form&availability=open_offline'));
        await check('contact form');
        await page.getByRole('button', { name: t('form.submit') }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert')).toHaveCount(3);
        await check('contact form errors');
        await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
        await page.getByRole('textbox', { name: t('prechat.email') }).fill('omar.k@example.com');
        await page.getByRole('textbox', { name: t('form.message') }).fill('Change my address.');
        await page.getByRole('button', { name: t('form.submit') }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('button', { name: t('form.another') })).toBeFocused();
        await check('contact form sent');

        expect(found).toEqual([]);
      });
    });
  }

  test.describe(`${locale} keyboard`, () => {
    test('every stop in the chat window shows a focus ring, in order, and Tab may leave the window beside the page', async ({
      page,
    }) => {
      await openWidget(page, locale);
      const stops = await tabStops(page, 8);

      expect(stops.map((stop) => stop.name)).toEqual([
        t('composer.voice'),
        t('composer.send'),
        t('launcher.close'),
        '(page)',
        t('window.minimise'),
        t('thread.label'),
        t('composer.attach'),
        t('composer.label'),
      ]);
      expect(stops.filter((stop) => stop.name !== '(page)' && !stop.ring)).toEqual([]);
    });

    test('on a phone the window is a modal dialog: Tab stays inside, the launcher steps aside, Escape closes', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await openWidget(page, locale);
      await expect(page.getByRole('dialog', { name: t('window.label') })).toBeVisible();
      await expect(page.getByRole('button', { name: t('launcher.close') })).toBeHidden();

      const forward = await tabStops(page, 7);
      expect(forward.map((stop) => stop.name)).toEqual([
        t('composer.voice'),
        t('composer.send'),
        t('window.minimise'),
        t('thread.label'),
        t('composer.attach'),
        t('composer.label'),
        t('composer.voice'),
      ]);
      expect(forward.filter((stop) => !stop.ring)).toEqual([]);

      const backward = await tabStops(page, 3, true);
      expect(backward.map((stop) => stop.name)).toEqual([
        t('composer.label'),
        t('composer.attach'),
        t('thread.label'),
      ]);

      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect(page.getByRole('button', { name: t('launcher.open') })).toBeFocused();
    });

    for (const mode of ['helpcenter', 'form'] as const) {
      test(`Escape closes the ${mode} mode and returns focus to the launcher`, async ({ page }) => {
        await openWidget(page, locale, `mode=${mode}`);
        await page.keyboard.press('Escape');
        await expect(widgetWindow(page, locale)).toBeHidden();
        await expect(page.getByRole('button', { name: t('launcher.open') })).toBeFocused();
      });
    }
  });
}
