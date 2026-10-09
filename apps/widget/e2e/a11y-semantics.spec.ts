import type { Page } from '@playwright/test';
import { expect, LOCALES, openWidget, server, strings, test } from './fixtures.js';

/**
 * What a screen reader is told, asserted on the DOM (M9-04, WCAG 4.1.2 and
 * 4.1.3; `docs/completed/accessibility-audit.md`). Only the screen reader's
 * own voice is left to a person: these specs prove the markup it reads is the
 * markup the audit asks for.
 *
 * - The thread is the one polite live region, and nothing live sits inside it
 *   or around it, so each new item is read once.
 * - One strip at a time is a status; the others are gone, not stacked.
 * - On a phone the window is a modal dialog with a name; beside a page it is
 *   not.
 * - The recording timer is a timer: quiet, not a live region of its own.
 * - Every rating button says whether it is pressed.
 */

const OPEN_FEEDBACK = `const { answer } = window.helpdock.ai; mock.aiReply(answer.body, answer.ai);`;

interface Regions {
  /** How many `role="log"` elements the widget has. */
  readonly logs: number;
  /** Whether the first of them is `aria-live="polite"`. */
  readonly polite: boolean;
  /** Live regions inside the log (not the log itself). */
  readonly nested: string[];
  /** Live regions around the log. */
  readonly enclosing: string[];
}

/** Live regions as assistive technology sees them: a live role, or `aria-live` other than `off`. */
function liveRegions(page: Page): Promise<Regions> {
  return page.evaluate(() => {
    const root = document.querySelector('helpdock-widget')?.shadowRoot;
    if (!root) {
      throw new Error('the widget is not on the page');
    }
    const live = [
      ...root.querySelectorAll(
        '[role=log], [role=status], [role=alert], [role=marquee], [aria-live]',
      ),
    ].filter((element) => element.getAttribute('aria-live') !== 'off');
    const logs = [...root.querySelectorAll('[role=log]')];
    const log = logs[0] ?? null;
    const name = (element: Element) =>
      `${element.getAttribute('role') ?? element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 32)}"`;
    return {
      logs: logs.length,
      polite: log?.getAttribute('aria-live') === 'polite',
      nested: live.filter((element) => element !== log && log?.contains(element)).map(name),
      enclosing: live.filter((element) => element !== log && element.contains(log)).map(name),
    };
  });
}

/** Reads the thread's live regions in the current state and keeps what is wrong under its name. */
const auditLog = (page: Page, found: string[]) => async (state: string) => {
  const regions = await liveRegions(page);
  if (regions.logs !== 1) {
    found.push(`${state}: ${regions.logs} logs, expected 1`);
  }
  if (!regions.polite) {
    found.push(`${state}: the log is not aria-live="polite"`);
  }
  for (const region of regions.nested) {
    found.push(`${state}: ${region} is a live region inside the log`);
  }
  for (const region of regions.enclosing) {
    found.push(`${state}: ${region} is a live region around the log`);
  }
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The strips on screen, by their text: every `.hd-banner` outside the thread,
 * and a failure if one of them is not a `role="status"` or if a status is not
 * a banner. One entry means one strip.
 */
const strips = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const root = document.querySelector('helpdock-widget')?.shadowRoot;
    const text = (element: Element) => (element.textContent ?? '').trim();
    const banners = [...(root?.querySelectorAll('.hd-banner') ?? [])];
    const statuses = [...(root?.querySelectorAll('[role=status]') ?? [])].filter(
      (element) => !element.closest('[role=log]'),
    );
    const mismatched = banners.filter((banner) => banner.getAttribute('role') !== 'status');
    if (mismatched.length > 0 || statuses.length !== banners.length) {
      return [
        `banners ${banners.map(text).join(' | ')} against statuses ${statuses.map(text).join(' | ')}`,
      ];
    }
    return banners.map(text);
  });

for (const locale of LOCALES) {
  const t = strings(locale);
  const score = (rating: number) =>
    t('csat.choice', { rating, label: t(`csat.ratings.${String(rating)}`) });

  test.describe(locale, () => {
    test('the thread is the only live region of a conversation: polite, with nothing live inside it', async ({
      page,
    }) => {
      const found: string[] = [];
      const check = auditLog(page, found);
      const log = page.getByRole('log', { name: t('thread.label') });

      await openWidget(page, locale);
      await check('empty thread');

      await page.keyboard.type('How long does a refund take?');
      await page.keyboard.press('Enter');
      await expect(log.getByText(t('message.sent'))).toBeVisible();
      await server(page, `mock.emit({ type: 'receipt', kind: 'read', seq: 1 });`);
      await expect(log.getByText(t('message.seen'))).toBeVisible();
      await check('a message Sent, then Seen');

      await server(page, OPEN_FEEDBACK);
      await expect(log.getByRole('button', { name: t('ai.yes') })).toBeVisible();
      await check('an assistant answer with its sources and feedback');
      await log.getByRole('button', { name: t('ai.yes') }).click();
      await expect(log.getByText(t('ai.thanks'))).toBeVisible();
      await check('the thanks after "Was this helpful?"');

      await page.getByRole('button', { name: t('ai.talkToHuman') }).click();
      await expect(log.getByText(t('ai.connecting'))).toBeVisible();
      await check('the handoff line');

      await server(page, 'mock.dropConnection();');
      await expect(page.getByText(t('connection.reconnectingTitle'))).toBeVisible();
      await server(
        page,
        `mock.storeSilently(agent, 'It is on its way.'); mock.restoreConnection();`,
      );
      await expect(log.getByText(t('connection.newMessages', { count: 1 }))).toBeVisible();
      await check('the new-messages divider');

      expect(found).toEqual([]);
    });

    test('the rating card keeps the thread the only live region: pressed, failed, rated, skipped and closed', async ({
      page,
    }) => {
      const found: string[] = [];
      const check = auditLog(page, found);
      const log = page.getByRole('log', { name: t('thread.label') });
      const ended = async () => {
        await openWidget(page, locale);
        await page.keyboard.type('My refund for order 8841 has not arrived.');
        await page.keyboard.press('Enter');
        await expect(log.getByText(t('message.sent'))).toBeVisible();
        await server(
          page,
          `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'The trace is back.'); mock.end(); mock.offerCsat();`,
        );
        await expect(log.getByRole('form', { name: t('csat.question') })).toBeVisible();
      };

      await ended();
      await check('the card, open');
      await log.getByRole('button', { name: score(2) }).click();
      await server(page, 'mock.failNextRating();');
      await log.getByRole('button', { name: t('csat.send') }).click();
      await expect(log.getByText(t('csat.failed'))).toBeVisible();
      await check('a rating that was not sent');
      await log.getByRole('button', { name: t('csat.send') }).click();
      await expect(log.getByText(t('csat.thanks'))).toBeVisible();
      await check('the rating, thanked');

      await ended();
      await log.getByRole('button', { name: t('csat.skip') }).click();
      await expect(log.getByText(t('csat.skipped'), { exact: false })).toBeVisible();
      await check('the card, skipped');

      await ended();
      await server(
        page,
        `mock.offerCsat({ state: 'expired', rating: null, comment: null, skipped_at: null });`,
      );
      await expect(log.getByRole('note')).toBeVisible();
      await check('the card, closed after thirty days');

      expect(found).toEqual([]);
    });

    test('out of hours gives way to Reconnecting and Back online: one strip at a time is a status', async ({
      page,
    }) => {
      await openWidget(page, locale, 'availability=closed');

      await expect(page.getByText(t('hours.closedTitle'))).toBeVisible();
      expect(await strips(page), 'out of hours').toEqual([
        expect.stringContaining(t('hours.closedTitle')),
      ]);

      await page.keyboard.type('Can someone check the bank reference?');
      await page.keyboard.press('Enter');
      await expect(page.getByText(t('message.sent'))).toBeVisible();
      await server(page, 'mock.dropConnection();');
      await expect(page.getByText(t('connection.reconnectingTitle'))).toBeVisible();
      expect(await strips(page), 'reconnecting, which outranks out of hours').toEqual([
        expect.stringContaining(t('connection.reconnectingTitle')),
      ]);

      await server(page, 'mock.restoreConnection();');
      await expect(page.getByText(t('connection.back'))).toBeVisible();
      expect(await strips(page), 'back online, which outranks out of hours').toEqual([
        expect.stringContaining(t('connection.back')),
      ]);
    });

    test('the queue position gives way to Reconnecting, and the pre-chat form has no strip', async ({
      page,
    }) => {
      await openWidget(page, locale, 'prechat=1');
      await expect(page.getByRole('heading', { name: t('prechat.title') })).toBeVisible();
      expect(await strips(page), 'the pre-chat form').toEqual([]);

      await page.getByRole('textbox', { name: t('prechat.name') }).fill('Omar Khalil');
      await page.getByRole('textbox', { name: t('prechat.email') }).fill('omar.k@example.com');
      await page
        .getByRole('textbox', { name: t('prechat.message') })
        .fill('My refund for order 8841 has not arrived.');
      await page.getByRole('button', { name: t('prechat.submit') }).click();
      await server(page, `mock.emit({ type: 'queue', position: 2, eta_seconds: 180 });`);
      await expect(page.getByText(t('header.caption.queued'))).toBeVisible();
      expect(await strips(page), 'queued').toEqual([
        expect.stringContaining(t('queue.eta', { count: 3 })),
      ]);

      await server(page, 'mock.dropConnection();');
      await expect(page.getByText(t('connection.reconnectingTitle'))).toBeVisible();
      expect(await strips(page), 'reconnecting, which outranks the queue').toEqual([
        expect.stringContaining(t('connection.reconnectingTitle')),
      ]);
    });

    test('on a phone the window is a modal dialog with a name; beside a page it is a plain region', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await openWidget(page, locale);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveCount(1);
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAccessibleName(t('window.label'));

      await page.setViewportSize({ width: 1024, height: 800 });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const region = page.getByRole('region', { name: t('window.label') });
      await expect(region).toBeVisible();
      await expect(region).not.toHaveAttribute('aria-modal', /.*/);
    });

    test('the recording timer is a timer with a name, and is not a live region', async ({
      page,
    }) => {
      await openWidget(page, locale);
      await page.getByRole('button', { name: t('composer.voice') }).click();
      const timer = page.getByRole('timer');
      await expect(timer).toHaveCount(1);
      const [named = ''] = t('voice.timer', { elapsed: '@', max: '@' }).split('@');
      await expect(timer).toHaveAccessibleName(new RegExp(`^${escapeRegExp(named.trim())}`));

      const live = await page.evaluate(() => {
        const element = document
          .querySelector('helpdock-widget')
          ?.shadowRoot?.querySelector('[role=timer]');
        const around = element?.closest('[aria-live], [role=alert], [role=status], [role=log]');
        return {
          ownLive: element?.getAttribute('aria-live') ?? null,
          around: around ? (around.getAttribute('role') ?? around.tagName.toLowerCase()) : null,
        };
      });
      expect(live.ownLive === null || live.ownLive === 'off').toBe(true);
      expect(live.around).toBeNull();
    });

    test('every rating button says whether it is pressed, and one at a time is', async ({
      page,
    }) => {
      await openWidget(page, locale);
      await page.keyboard.type('My refund for order 8841 has not arrived.');
      await page.keyboard.press('Enter');
      await server(
        page,
        `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'The trace is back.'); mock.end(); mock.offerCsat();`,
      );
      const card = page.getByRole('form', { name: t('csat.question') });
      const pressed = async () =>
        card
          .locator('.hd-csat-score')
          .evaluateAll((all) => all.map((button) => button.getAttribute('aria-pressed')));
      await expect(card.locator('.hd-csat-score')).toHaveCount(5);

      expect(await pressed()).toEqual(['false', 'false', 'false', 'false', 'false']);
      await card.getByRole('button', { name: score(4) }).click();
      expect(await pressed()).toEqual(['false', 'false', 'false', 'true', 'false']);
      await card.getByRole('button', { name: score(1) }).click();
      expect(await pressed()).toEqual(['true', 'false', 'false', 'false', 'false']);
    });
  });
}
