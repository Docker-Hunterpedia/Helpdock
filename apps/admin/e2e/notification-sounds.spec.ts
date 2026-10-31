import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { SoundEvent } from '@helpdock/schemas';
import type { Page } from '@playwright/test';
import { MOCK_BRANDS } from '../src/auth/mock-api.js';
import { MOCK_SOUNDS_FAIL_STORAGE } from '../src/notifications/mock-api.js';
import type { MockRealtimeClient } from '../src/realtime/mock-client.js';
import { MOCK_DEPARTMENTS, MOCK_SELF_ID } from '../src/staff/mock-api.js';
import type { MockTicketsApi } from '../src/tickets/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-25 in the browser, in both languages (`Admin/Account-Notifications-Sounds`):
 * the Sounds card of Your account › Notifications, and the sounds themselves.
 *
 * `Audio` is replaced before the app loads, so nothing is played and every
 * attempt is recorded in `window.__heard`. The socket is `MockRealtimeClient`
 * and the tickets are `MockTicketsApi`; both are reached through the globals the
 * mock adapter sets, which is how this suite plays the server and a colleague.
 */

test.use({ reducedMotion: 'reduce' });

declare global {
  interface Window {
    __heard: string[];
    __helpdockMockRealtime?: MockRealtimeClient;
    __helpdockMockTickets?: MockTicketsApi;
  }
}

const BRAND = MOCK_BRANDS[0]?.id ?? '';
const MINUTE = 60_000;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__heard = [];
    class StubAudio {
      src: string;
      currentTime = 0;
      preload = '';
      listeners: (() => void)[] = [];
      constructor(src: string) {
        this.src = src;
      }
      addEventListener(_type: string, listener: () => void) {
        this.listeners.push(listener);
      }
      pause() {}
      async play() {
        window.__heard.push(this.src.split('/').pop()?.replace('.wav', '') ?? this.src);
        queueMicrotask(() => {
          for (const listener of this.listeners) listener();
        });
      }
    }
    // @ts-expect-error -- a stand-in with only what the player touches
    window.Audio = StubAudio;
  });
});

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
}

const openCard = async (page: Page, locale: Locale) => {
  const t = strings(locale);
  await signIn(page, locale);
  await page
    .getByRole('button', {
      name: t('admin:notifications.bell.labelUnread', { count: 3 }),
      exact: true,
    })
    .click();
  await page
    .getByRole('dialog', { name: t('admin:notifications.panel.title') })
    .getByRole('link', { name: t('admin:notifications.panel.settings') })
    .click();
  const card = page.getByRole('region', { name: t('me:notifications.sounds.heading') });
  await card.waitFor();

  return card;
};

const toggle = (card: ReturnType<Page['locator']>, locale: Locale, event: SoundEvent) =>
  card.getByRole('switch', { name: strings(locale)(`me:notifications.sounds.events.${event}`) });

const heard = (page: Page) => page.evaluate(() => window.__heard);

/** A chat that just arrived: made in the fixture, then announced as the server would. */
const waitingChatCreated = (page: Page) =>
  page.evaluate(
    async ([brandId, departmentId]) => {
      const created = await window.__helpdockMockTickets?.create(brandId as string, {
        subject: 'Hello',
        bodyHtml: '<p>Hello</p>',
        departmentId: departmentId as string,
        channel: 'chat',
      });
      const ticketId = created?.ticket.id as string;
      window.__helpdockMockRealtime?.emitTicketChanged({
        brandId: brandId as string,
        ticketId,
        departmentId: departmentId as string,
        event: 'ticket.created',
      });

      return ticketId;
    },
    [BRAND, MOCK_DEPARTMENTS[0]?.id],
  );

test.describe('the Sounds card', () => {
  test('starts with every sound off, keeps a switch across pages, and has no axe violations', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const card = await openCard(page, locale);

    for (const event of [
      'waitingChat',
      'newConversation',
      'customerReply',
      'assignedOrMentioned',
    ] as const) {
      await expect(toggle(card, locale, event)).toHaveAttribute('aria-checked', 'false');
    }
    await expect(card.getByText(t('me:notifications.sounds.note'))).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await toggle(card, locale, 'customerReply').click();
    await expect(toggle(card, locale, 'customerReply')).toHaveAttribute('aria-checked', 'true');

    // Away to another page of Your account and back, inside the app (the mock session is in memory).
    await page.getByRole('link', { name: t('me:account.tabs.security') }).click();
    await page.getByRole('link', { name: t('me:account.tabs.notifications') }).click();
    const again = page.getByRole('region', { name: t('me:notifications.sounds.heading') });
    await expect(toggle(again, locale, 'customerReply')).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(again, locale, 'newConversation')).toHaveAttribute('aria-checked', 'false');
  });

  test('plays the sound of the button pressed, with its switch off', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    const card = await openCard(page, locale);
    const label = t('me:notifications.sounds.events.newConversation');

    await card
      .getByRole('button', { name: t('me:notifications.sounds.play', { event: label }) })
      .click();

    await expect.poll(() => heard(page)).toEqual(['new-conversation']);
  });
});

test.describe('a chat that waits', () => {
  test('plays when it arrives and again every minute until somebody picks it up', async ({
    page,
    appLocale: locale,
  }) => {
    await page.clock.install();
    const card = await openCard(page, locale);
    await toggle(card, locale, 'waitingChat').click();
    await expect(toggle(card, locale, 'waitingChat')).toHaveAttribute('aria-checked', 'true');
    const reminder = card.getByRole('checkbox', {
      name: strings(locale)('me:notifications.sounds.reminder'),
    });
    await reminder.click();
    await expect(reminder).toBeChecked();
    expect(await heard(page)).toEqual([]);

    const ticketId = await waitingChatCreated(page);
    await expect.poll(() => heard(page)).toEqual(['waiting-chat']);

    await page.clock.runFor(MINUTE);
    await expect.poll(() => heard(page)).toEqual(['waiting-chat', 'waiting-chat']);
    await page.clock.runFor(MINUTE);
    await expect.poll(() => heard(page)).toHaveLength(3);

    // Somebody takes it: the next minute is quiet, and so are all that follow.
    await page.evaluate(
      ([brandId, ticketId, self]) =>
        window.__helpdockMockTickets?.update(brandId as string, ticketId as string, {
          assigneeId: self as string,
        }),
      [BRAND, ticketId, MOCK_SELF_ID],
    );
    await page.clock.runFor(MINUTE);
    await page.clock.runFor(MINUTE);
    expect(await heard(page)).toHaveLength(3);
  });

  test('goes quiet, reminder included, once the waiting-chat sound is turned off', async ({
    page,
    appLocale: locale,
  }) => {
    await page.clock.install();
    const card = await openCard(page, locale);
    await toggle(card, locale, 'waitingChat').click();
    await expect(toggle(card, locale, 'waitingChat')).toHaveAttribute('aria-checked', 'true');
    await card
      .getByRole('checkbox', { name: strings(locale)('me:notifications.sounds.reminder') })
      .click();

    await waitingChatCreated(page);
    await expect.poll(() => heard(page)).toEqual(['waiting-chat']);

    await toggle(card, locale, 'waitingChat').click();
    await expect(toggle(card, locale, 'waitingChat')).toHaveAttribute('aria-checked', 'false');
    await page.clock.runFor(MINUTE);
    await page.clock.runFor(MINUTE);

    expect(await heard(page)).toEqual(['waiting-chat']);
  });
});

test.describe('a sound change that cannot be saved', () => {
  test('says so and puts the switch back', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    const card = await openCard(page, locale);
    await page.evaluate(
      (key) => window.localStorage.setItem(key, 'fail'),
      MOCK_SOUNDS_FAIL_STORAGE,
    );

    await toggle(card, locale, 'newConversation').click();

    await expect(page.getByText(t('me:notifications.sounds.failed'))).toBeVisible();
    await expect(toggle(card, locale, 'newConversation')).toHaveAttribute('aria-checked', 'false');
  });
});
