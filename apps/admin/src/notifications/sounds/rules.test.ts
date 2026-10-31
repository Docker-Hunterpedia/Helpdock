import { NOTIFICATION_KINDS, NOTIFICATION_SOUND_DEFAULTS, type Ticket } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { MOCK_BRANDS } from '../../auth/mock-api.js';
import { MOCK_SELF_ID } from '../../staff/mock-api.js';
import { MOCK_TICKET_REFUND, MOCK_TICKET_SIGN_IN, MockTicketsApi } from '../../tickets/mock-api.js';
import {
  isCustomerReplyForMe,
  isSoundOn,
  isWaitingChat,
  remindsWhileWaiting,
  soundForCreatedTicket,
  soundForNotificationKind,
} from './rules.js';

const BRAND = MOCK_BRANDS[0]?.id ?? '';
const api = new MockTicketsApi();
const seeded = async (id: string): Promise<Ticket> => (await api.ticket(BRAND, id)).ticket;

/** The seeded chat is open and nobody's: a chat waiting for an agent. */
const waiting = (): Promise<Ticket> => seeded(MOCK_TICKET_SIGN_IN);

const message = async (
  overrides: Partial<Awaited<ReturnType<typeof api.messages>>['messages'][number]>,
) => {
  const [first] = (await api.messages(BRAND, MOCK_TICKET_SIGN_IN)).messages;
  if (first === undefined) throw new Error('fixture has no message');

  return { ...first, ...overrides };
};

describe('which tickets are waiting chats', () => {
  it('is an unassigned, open chat', async () => {
    expect(isWaitingChat(await waiting())).toBe(true);
  });

  it.each([
    ['assigned', { assigneeId: MOCK_SELF_ID }],
    ['on another channel', { channel: 'email' as const }],
    ['merged into another ticket', { mergedIntoId: MOCK_TICKET_REFUND }],
  ])('is not one when %s', async (_name, change) => {
    expect(isWaitingChat({ ...(await waiting()), ...change })).toBe(false);
  });

  it('is not one once closed or on hold, and still is one when escalated', async () => {
    const ticket = await waiting();
    const withState = (systemState: Ticket['status']['systemState']): Ticket => ({
      ...ticket,
      status: { ...ticket.status, systemState },
    });

    expect(isWaitingChat(withState('closed'))).toBe(false);
    expect(isWaitingChat(withState('on_hold'))).toBe(false);
    expect(isWaitingChat(withState('escalated'))).toBe(true);
  });
});

describe('the sound a created ticket earns', () => {
  it('is the waiting-chat sound for a chat nobody has, even if it was assigned a moment later', async () => {
    expect(soundForCreatedTicket(await waiting())).toBe('waitingChat');
  });

  it('is the new-conversation sound for any other customer channel', async () => {
    expect(soundForCreatedTicket(await seeded(MOCK_TICKET_REFUND))).toBe('newConversation');
    expect(soundForCreatedTicket({ ...(await waiting()), assigneeId: MOCK_SELF_ID })).toBe(
      'newConversation',
    );
  });

  it('is silent for a ticket typed in on the desk, which is mostly the person’s own', async () => {
    expect(soundForCreatedTicket({ ...(await waiting()), channel: 'manual' })).toBeNull();
  });
});

describe('the sound a customer’s reply earns', () => {
  const mine = async (): Promise<Ticket> => ({ ...(await waiting()), assigneeId: MOCK_SELF_ID });

  it('is earned by a public customer message after the first, on my ticket', async () => {
    expect(
      isCustomerReplyForMe(
        await mine(),
        await message({ authorType: 'contact', seq: 2 }),
        MOCK_SELF_ID,
      ),
    ).toBe(true);
  });

  it.each([
    ['the opening message', { seq: 1 }],
    ['a colleague’s reply', { authorType: 'staff' as const }],
    ['an automatic reply', { authorType: 'ai' as const }],
    ['a note', { kind: 'note' as const }],
  ])('is not earned by %s', async (_name, change) => {
    expect(
      isCustomerReplyForMe(
        await mine(),
        await message({ authorType: 'contact', seq: 2, ...change }),
        MOCK_SELF_ID,
      ),
    ).toBe(false);
  });

  it('is not earned on somebody else’s ticket or an unassigned one', async () => {
    const reply = await message({ authorType: 'contact', seq: 2 });

    expect(
      isCustomerReplyForMe({ ...(await mine()), assigneeId: 'someone-else' }, reply, MOCK_SELF_ID),
    ).toBe(false);
    expect(isCustomerReplyForMe(await waiting(), reply, MOCK_SELF_ID)).toBe(false);
  });
});

describe('the sound a notification earns', () => {
  it('is earned by an assignment and a mention, and by no other kind', () => {
    const earning = NOTIFICATION_KINDS.filter((kind) => soundForNotificationKind(kind) !== null);

    expect(earning).toEqual(['assigned', 'mentioned']);
    expect(soundForNotificationKind('assigned')).toBe('assignedOrMentioned');
  });
});

describe('the person’s switches', () => {
  it('reads each event’s own switch, all off by default', () => {
    expect(isSoundOn(NOTIFICATION_SOUND_DEFAULTS, 'customerReply')).toBe(false);
    expect(
      isSoundOn({ ...NOTIFICATION_SOUND_DEFAULTS, customerReply: true }, 'customerReply'),
    ).toBe(true);
  });

  it('repeats the waiting-chat sound only with both its switch and the reminder on', () => {
    const on = { ...NOTIFICATION_SOUND_DEFAULTS, waitingChat: true, waitingChatReminder: true };

    expect(remindsWhileWaiting(on)).toBe(true);
    expect(remindsWhileWaiting({ ...on, waitingChat: false })).toBe(false);
    expect(remindsWhileWaiting({ ...on, waitingChatReminder: false })).toBe(false);
  });
});
