import type { Page } from '@playwright/test';
import { expect, LOCALES, type Locale, openWidget, server, strings, test } from './fixtures.js';

/**
 * Zoom and reflow on the widget (M9-04; WCAG 1.4.4 Resize Text, 1.4.10
 * Reflow; `docs/completed/accessibility-audit.md`). 200 % browser zoom on a
 * 1280 × 800 window is a viewport of half the CSS size, 640 × 400, so that is
 * what these specs open the widget in. The widget at 320 px is the phone
 * layout, which `widget.spec.ts` and `a11y-audit.spec.ts` already cover.
 *
 * At each state: the page does not scroll sideways, every control can be
 * brought into the viewport and is the thing under its own centre (not
 * clipped by the window, not covered by a strip or the composer), and no
 * heading, button or strip cuts its text off.
 */

const ZOOM_200 = { width: 640, height: 400 } as const;

/** Runs in the page: what is wrong with the widget's current state at this viewport. */
function reflowProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const scroller = document.scrollingElement ?? document.documentElement;
    if (scroller.scrollWidth > scroller.clientWidth) {
      problems.push(
        `the page scrolls sideways (${scroller.scrollWidth} > ${scroller.clientWidth})`,
      );
    }
    const root = document.querySelector('helpdock-widget')?.shadowRoot;
    if (!root) {
      return [...problems, 'the widget is not on the page'];
    }
    const name = (element: Element): string =>
      `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(' ')[0]}` : ''} "${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 32)}"`;

    const controls = root.querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type=hidden]):not([type=file]), textarea, select',
    );
    for (const control of controls) {
      if (
        control.getClientRects().length === 0 ||
        getComputedStyle(control).visibility === 'hidden'
      ) {
        continue;
      }
      control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const box = control.getBoundingClientRect();
      if (
        box.left < -0.5 ||
        box.right > innerWidth + 0.5 ||
        box.top < -0.5 ||
        box.bottom > innerHeight + 0.5
      ) {
        problems.push(`${name(control)} is outside the viewport`);
        continue;
      }
      const hit = root.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (
        !hit ||
        !(control === hit || control.contains(hit) || hit.closest('label')?.contains(control))
      ) {
        problems.push(
          `${name(control)} is clipped or covered (its centre is on ${hit ? name(hit) : 'nothing'})`,
        );
      }
    }

    const texts = root.querySelectorAll<HTMLElement>(
      'h1, h2, h3, button, a, label, legend, .hd-banner, .hd-presence, .hd-system, .hd-note, .hd-alert, .hd-caption',
    );
    for (const element of texts) {
      if (element.closest('.hd-visually-hidden')) {
        continue;
      }
      if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1) {
        problems.push(
          `${name(element)} cuts its text off sideways (${element.scrollWidth} > ${element.clientWidth})`,
        );
      }
      if (
        element.tagName === 'BUTTON' &&
        element.clientHeight > 0 &&
        element.scrollHeight > element.clientHeight + 1
      ) {
        problems.push(`${name(element)} cuts its text off at the bottom`);
      }
    }
    return problems;
  });
}

/** Reads the state's problems and keeps them under its name. */
const audit = (page: Page, found: string[]) => async (state: string) => {
  for (const line of await reflowProblems(page)) {
    found.push(`${state}: ${line}`);
  }
};

async function sendHello(page: Page, locale: Locale): Promise<void> {
  const t = strings(locale);
  await page.keyboard.type('Hi, my refund for order 8841 has not arrived.');
  await page.keyboard.press('Enter');
  await expect(page.getByText(t('message.sent'))).toBeVisible();
}

for (const locale of LOCALES) {
  const t = strings(locale);

  test.describe(`${locale} at 200 % zoom (${ZOOM_200.width} CSS px)`, () => {
    test.use({ viewport: ZOOM_200 });

    test('the launcher, the thread and every strip stay inside the viewport', async ({ page }) => {
      const found: string[] = [];
      const check = audit(page, found);

      await page.goto(`/?locale=${locale}`);
      await expect(page.getByRole('button', { name: t('launcher.open') })).toBeVisible();
      await check('launcher');

      await openWidget(page, locale);
      await check('chat, empty');
      await sendHello(page, locale);
      await server(page, `mock.emit({ type: 'receipt', kind: 'read', seq: 1 });`);
      await expect(page.getByText(t('message.seen'))).toBeVisible();
      await server(page, `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'Checking now.');`);
      await check('chat, sent then seen, agent replied');

      await server(page, 'mock.dropConnection();');
      await expect(page.getByText(t('connection.reconnectingTitle'))).toBeVisible();
      await check('reconnecting strip');
      await server(
        page,
        `mock.storeSilently(agent, 'It is on its way.'); mock.restoreConnection();`,
      );
      await expect(page.getByText(t('connection.back'))).toBeVisible();
      await check('back online strip with the new-messages divider');

      expect(found).toEqual([]);
    });

    test('out of hours and a failed send keep the strip and Retry in reach', async ({ page }) => {
      const found: string[] = [];
      const check = audit(page, found);

      await openWidget(page, locale, 'availability=closed');
      await expect(page.getByText(t('hours.closedTitle'))).toBeVisible();
      await check('out of hours strip');

      await server(page, 'mock.failNextSends(1000);');
      await page.keyboard.type('Can someone check the bank reference?');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: t('message.retry') })).toBeVisible({
        timeout: 15_000,
      });
      await check('a send that failed, with Retry');

      expect(found).toEqual([]);
    });

    test('the assistant answer with its sources, "Talk to a human" and the voice recorder stay in reach', async ({
      page,
    }) => {
      const found: string[] = [];
      const check = audit(page, found);

      await openWidget(page, locale);
      await sendHello(page, locale);
      await server(
        page,
        `const { answer } = window.helpdock.ai; mock.aiReply(answer.body, answer.ai);`,
      );
      await expect(page.getByRole('button', { name: t('ai.talkToHuman') })).toBeVisible();
      await check('assistant answer, sources, feedback and Talk to a human');

      await page.getByRole('button', { name: t('composer.voice') }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('timer')).toBeVisible();
      await check('voice recording');

      expect(found).toEqual([]);
    });

    test('the ended state with its transcript form, and the rating card, stay in reach', async ({
      page,
    }) => {
      const found: string[] = [];
      const check = audit(page, found);

      await openWidget(page, locale);
      await sendHello(page, locale);
      await server(
        page,
        `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'The trace is back.'); mock.end();`,
      );
      await expect(page.getByRole('button', { name: t('ended.newConversation') })).toBeVisible();
      await check('ended, with the transcript form');

      await server(page, 'mock.offerCsat();');
      await expect(page.getByRole('form', { name: t('csat.question') })).toBeVisible();
      await check('rating card');

      expect(found).toEqual([]);
    });

    test('the pre-chat form, the queue strip and the contact form keep every field and Send in reach', async ({
      page,
    }) => {
      const found: string[] = [];
      const check = audit(page, found);

      await openWidget(page, locale, 'prechat=1');
      await expect(page.getByRole('heading', { name: t('prechat.title') })).toBeVisible();
      await check('pre-chat form');
      await page.getByRole('button', { name: t('prechat.submit') }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert').first()).toBeVisible();
      await check('pre-chat form, errors');

      await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
      await page.getByRole('textbox', { name: t('prechat.email') }).fill('omar.k@example.com');
      await page
        .getByRole('textbox', { name: t('prechat.message') })
        .fill('My refund for order 8841 has not arrived.');
      await page.getByRole('button', { name: t('prechat.submit') }).focus();
      await page.keyboard.press('Enter');
      await server(page, `mock.emit({ type: 'queue', position: 2, eta_seconds: 180 });`);
      await expect(page.getByText(t('header.caption.queued'))).toBeVisible();
      await check('queue position strip');

      await openWidget(page, locale, 'mode=form&availability=open_offline');
      await check('contact form');
      await page.getByRole('button', { name: t('form.submit') }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert')).toHaveCount(3);
      await check('contact form, errors');

      expect(found).toEqual([]);
    });

    test('the help center mode, a search and an article keep the list and Back in reach', async ({
      page,
    }) => {
      const found: string[] = [];
      const check = audit(page, found);

      await openWidget(page, locale, 'mode=helpcenter');
      const popular = page.getByRole('list', { name: t('articles.popular') });
      await expect(popular).toBeVisible();
      await check('popular articles');
      await page.keyboard.type(locale === 'ar' ? 'إرجاع' : 'return');
      await expect(
        page.getByRole('list', { name: t('articles.resultsLabel') }).getByRole('link'),
      ).not.toHaveCount(0);
      await check('search results');
      await page.getByRole('searchbox', { name: t('articles.searchLabel') }).fill('');
      await popular.getByRole('link').first().focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('helpdock-widget article h3')).toBeFocused();
      await check('an article');

      expect(found).toEqual([]);
    });
  });
}
