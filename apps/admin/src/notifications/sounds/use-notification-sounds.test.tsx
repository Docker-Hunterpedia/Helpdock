import {
  departmentRoom,
  NOTIFICATION_SOUND_DEFAULTS,
  type NotificationSounds,
  type TicketMessage,
} from '@helpdock/schemas';
import { act, screen, cleanup as screenCleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_BRANDS } from '../../auth/mock-api.js';
import { SessionProvider } from '../../auth/session.tsx';
import { MockRealtimeClient } from '../../realtime/mock-client.js';
import { RealtimeProvider } from '../../realtime/realtime-provider.tsx';
import { MOCK_DEPARTMENTS, MOCK_SELF_ID } from '../../staff/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import {
  MOCK_TICKET_ARABIC,
  MOCK_TICKET_REFUND,
  MOCK_TICKET_SIGN_IN,
  MockTicketsApi,
} from '../../tickets/mock-api.js';
import { MockNotificationsApi } from '../mock-api.js';
import { useNotificationSounds } from './use-notification-sounds.js';

const BRAND = MOCK_BRANDS[0]?.id ?? '';
const OTHER_BRAND = '01937f5e-7e53-7000-8000-0000000000ff';
const MENTION = '0192c3f0-1a2b-7c3d-8e4f-0000000a0002';
const BREACH = '0192c3f0-1a2b-7c3d-8e4f-0000000a0001';
const MINUTE = 60_000;

/** Records what would have been heard; `play()` resolves and the sound ends at once. */
class FakeAudio {
  static heard: string[] = [];
  currentTime = 0;
  preload = '';
  readonly #listeners = new Set<() => void>();

  constructor(readonly src: string) {}

  addEventListener(_type: 'ended', listener: () => void): void {
    this.#listeners.add(listener);
  }

  pause(): void {}

  async play(): Promise<void> {
    FakeAudio.heard.push(this.src.split('/').pop()?.replace('.wav', '') ?? this.src);
    queueMicrotask(() => {
      for (const listener of this.#listeners) listener();
    });
  }
}

function Probe() {
  useNotificationSounds();

  return <p>mounted</p>;
}

const on = (...events: (keyof NotificationSounds)[]): NotificationSounds => ({
  ...NOTIFICATION_SOUND_DEFAULTS,
  ...Object.fromEntries(events.map((event) => [event, true])),
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

const mount = async (sounds: NotificationSounds, tickets = new MockTicketsApi()) => {
  const apis = await signedInMockApis();
  const session = await apis.auth.me();
  if (session === null) throw new Error('fixture did not produce a session');
  const notifications = new MockNotificationsApi();
  await notifications.updateSettings({ sounds });
  const client = new MockRealtimeClient();
  renderApp(
    <SessionProvider session={session}>
      <RealtimeProvider client={client}>
        <Probe />
      </RealtimeProvider>
    </SessionProvider>,
    { notificationsApi: notifications, ticketsApi: tickets, staffApi: apis.staff },
  );
  await screen.findByText('mounted');
  // The person's choice arrives from the account, a moment after mounting.
  const wantsRooms = sounds.waitingChat || sounds.newConversation || sounds.customerReply;
  await waitFor(() => {
    expect(client.rooms().length > 0 || !wantsRooms).toBe(true);
  });
  await settle();

  return { client, tickets, notifications };
};

const created = (client: MockRealtimeClient, ticketId: string, brandId = BRAND) => {
  act(() => {
    client.emitTicketChanged({
      brandId,
      ticketId,
      departmentId: MOCK_DEPARTMENTS[0]?.id ?? '',
      event: 'ticket.created',
    });
  });
};

beforeEach(() => {
  FakeAudio.heard = [];
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the live sounds', () => {
  it('play nothing and join no department room while every sound is off', async () => {
    const { client } = await mount(NOTIFICATION_SOUND_DEFAULTS);

    created(client, MOCK_TICKET_SIGN_IN);
    created(client, MOCK_TICKET_REFUND);
    await settle();

    expect(FakeAudio.heard).toEqual([]);
    expect(client.rooms()).toEqual([]);
  });

  it('join the brand’s department rooms once a ticket sound is on', async () => {
    const { client } = await mount(on('newConversation'));

    expect(client.rooms()).toEqual(
      MOCK_DEPARTMENTS.map((department) => departmentRoom(department.id)).sort(),
    );
  });

  it('play the waiting-chat sound for an unassigned chat, once however often the frame repeats', async () => {
    const { client } = await mount(on('waitingChat'));

    created(client, MOCK_TICKET_SIGN_IN);
    created(client, MOCK_TICKET_SIGN_IN);

    await waitFor(() => expect(FakeAudio.heard).toEqual(['waiting-chat']));
    await settle();
    expect(FakeAudio.heard).toEqual(['waiting-chat']);
  });

  it('count a waiting chat as a new conversation for somebody who has only that sound on', async () => {
    const { client } = await mount(on('newConversation'));

    created(client, MOCK_TICKET_SIGN_IN);
    await waitFor(() => expect(FakeAudio.heard).toEqual(['new-conversation']));

    await settle();
    created(client, MOCK_TICKET_REFUND);
    await waitFor(() => expect(FakeAudio.heard).toEqual(['new-conversation', 'new-conversation']));
  });

  it('ignore a frame about another brand, and a ticket that cannot be read', async () => {
    const { client } = await mount(on('waitingChat', 'newConversation'));

    created(client, MOCK_TICKET_SIGN_IN, OTHER_BRAND);
    created(client, '0192c3f0-1a2b-7c3d-8e4f-00000000dead');
    await settle();

    expect(FakeAudio.heard).toEqual([]);
  });

  it('play for an assignment or a mention, not for an SLA breach, and only when that sound is on', async () => {
    const { client } = await mount(on('assignedOrMentioned'));

    act(() => client.emitNotificationCreated({ brandId: BRAND, notificationId: BREACH }));
    await settle();
    expect(FakeAudio.heard).toEqual([]);

    act(() => client.emitNotificationCreated({ brandId: BRAND, notificationId: MENTION }));
    await waitFor(() => expect(FakeAudio.heard).toEqual(['assigned-or-mentioned']));
  });

  it('stay silent for a notification when its sound is off', async () => {
    const { client } = await mount(on('waitingChat'));

    act(() => client.emitNotificationCreated({ brandId: BRAND, notificationId: MENTION }));
    await settle();

    expect(FakeAudio.heard).toEqual([]);
  });

  describe('for a customer’s reply', () => {
    const reply = (overrides: Partial<TicketMessage>): TicketMessage => ({
      id: '0192c3f0-1a2b-7c3d-8e4f-00000000f002',
      ticketId: MOCK_TICKET_ARABIC,
      seq: 2,
      clientId: null,
      kind: 'public',
      authorType: 'contact',
      authorId: null,
      bodyHtml: '<p>Hello</p>',
      bodyText: 'Hello',
      channel: 'telegram',
      attachments: [],
      createdAt: '2026-10-31T10:00:00.000Z',
      ...overrides,
    });

    const frame = (client: MockRealtimeClient, message: TicketMessage) =>
      act(() =>
        client.emitTicketMessage({
          brandId: BRAND,
          ticketId: message.ticketId,
          departmentId: MOCK_DEPARTMENTS[0]?.id ?? '',
          messageId: message.id,
          seq: message.seq,
          kind: 'public',
          event: 'ticket.replied',
        }),
      );

    const withMessage = (message: TicketMessage): MockTicketsApi => {
      const tickets = new MockTicketsApi();
      vi.spyOn(tickets, 'messages').mockResolvedValue({
        messages: [message],
        nextAfter: null,
      } as Awaited<ReturnType<MockTicketsApi['messages']>>);

      return tickets;
    };

    it('plays when the customer wrote on my ticket', async () => {
      const message = reply({});
      const { client } = await mount(on('customerReply'), withMessage(message));

      frame(client, message);

      await waitFor(() => expect(FakeAudio.heard).toEqual(['customer-reply']));
    });

    it('is silent for my own reply', async () => {
      const own = reply({ authorType: 'staff', authorId: MOCK_SELF_ID });
      const { client } = await mount(on('customerReply'), withMessage(own));

      frame(client, own);
      await settle();

      expect(FakeAudio.heard).toEqual([]);
    });

    it('is silent for a customer’s message on a ticket that is not mine', async () => {
      const theirs = reply({ ticketId: MOCK_TICKET_SIGN_IN });
      const { client } = await mount(on('customerReply'), withMessage(theirs));

      frame(client, theirs);
      await settle();

      expect(FakeAudio.heard).toEqual([]);
    });

    it('is silent for the opening message of a conversation', async () => {
      const opening = reply({ seq: 1 });
      const { client } = await mount(on('customerReply'), withMessage(opening));

      frame(client, opening);
      await settle();

      expect(FakeAudio.heard).toEqual([]);
    });
  });

  describe('the reminder', () => {
    const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));
    const minute = () => act(async () => vi.advanceTimersByTimeAsync(MINUTE));

    it('repeats every minute while the chat waits and stops when it is picked up', async () => {
      const { client, tickets } = await mount(on('waitingChat', 'waitingChatReminder'));
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      created(client, MOCK_TICKET_SIGN_IN);
      await flush();
      expect(FakeAudio.heard).toEqual(['waiting-chat']);

      await minute();
      await minute();
      expect(FakeAudio.heard).toEqual(['waiting-chat', 'waiting-chat', 'waiting-chat']);

      await tickets.update(BRAND, MOCK_TICKET_SIGN_IN, { assigneeId: MOCK_SELF_ID });
      await minute();
      await minute();
      expect(FakeAudio.heard).toHaveLength(3);
    });

    it('stops as soon as the frame about the pick-up arrives, before the next minute', async () => {
      const { client, tickets } = await mount(on('waitingChat', 'waitingChatReminder'));
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      created(client, MOCK_TICKET_SIGN_IN);
      await flush();

      await tickets.update(BRAND, MOCK_TICKET_SIGN_IN, { assigneeId: MOCK_SELF_ID });
      act(() => {
        client.emitTicketChanged({
          brandId: BRAND,
          ticketId: MOCK_TICKET_SIGN_IN,
          departmentId: MOCK_DEPARTMENTS[0]?.id ?? '',
          event: 'ticket.updated',
        });
      });
      await flush();
      await minute();

      expect(FakeAudio.heard).toEqual(['waiting-chat']);
    });

    it('does not repeat without the reminder switch', async () => {
      const { client } = await mount(on('waitingChat'));
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      created(client, MOCK_TICKET_SIGN_IN);
      await flush();
      await minute();
      await minute();

      expect(FakeAudio.heard).toEqual(['waiting-chat']);
    });

    it('stops with the tab: leaving the shell ends every timer', async () => {
      const { client } = await mount(on('waitingChat', 'waitingChatReminder'));
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      created(client, MOCK_TICKET_SIGN_IN);
      await flush();

      client.stop();
      screenCleanup();
      await minute();

      expect(FakeAudio.heard).toEqual(['waiting-chat']);
    });
  });
});
