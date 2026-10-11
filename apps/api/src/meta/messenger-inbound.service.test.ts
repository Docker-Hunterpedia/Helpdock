import {
  META_FIXTURE,
  type MetaEvent,
  type MetaWebhookBody,
  metaEnvelopeSchema,
  pageAttachment,
  pageDelivery,
  pageEcho,
  pageEdit,
  pageFallback,
  pagePostback,
  pageReaction,
  pageRead,
  pageSticker,
  pageText,
  routeEnvelope,
} from '@helpdock/channels';
import type { DbTransaction, MetaAccount, MetaConversation, MetaDelivery } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessengerInboundService,
  type MessengerInboundServiceOptions,
} from './messenger-inbound.service.js';
import type { MetaEventContext } from './meta-inbound.service.js';

/**
 * The service's decisions with the database faked. That a message
 * opens a ticket under the right contact, that a watermark marks the right
 * deliveries and that a redelivery files nothing twice is proved against
 * Postgres in `meta-messenger.integration.test.ts`.
 */

const state = vi.hoisted(() => ({
  seen: new Set<string>(),
  threads: new Map<string, { ticketId: string; departmentId: string }>(),
  lines: [] as { thread: unknown; line: { text: string; key: string | null } }[],
  profileRequests: [] as { brandId: string; profile: unknown }[],
}));
vi.mock('./messenger-profile.js', () => ({
  enqueueMetaProfile: async (_tx: unknown, brandId: string, profile: unknown) => {
    state.profileRequests.push({ brandId, profile });
    return 'outbox-id';
  },
}));
vi.mock('./meta-inbound-gate.js', () => ({
  metaMessageSeen: async (_tx: unknown, _brand: string, _platform: string, messageId: string) =>
    state.seen.has(messageId),
  metaSenderBlocked: async () => false,
}));
vi.mock('./meta-thread.js', () => ({
  ticketOfMessage: async (_tx: unknown, _account: unknown, messageId: string) =>
    state.threads.get(messageId),
  writeSystemLine: async (
    _tickets: unknown,
    _tx: unknown,
    _account: unknown,
    thread: unknown,
    line: { text: string; key: string | null },
  ) => {
    state.lines.push({ thread, line });
    if (line.key !== null) {
      state.seen.add(line.key);
    }
  },
}));

const BRAND = '01924f00-0000-7000-8000-0000000000a1';
const ACCOUNT_ID = '01924f00-0000-7000-8000-0000000000b1';
const OTHER_ACCOUNT_ID = '01924f00-0000-7000-8000-0000000000b2';
const CONTACT = '01924f00-0000-7000-8000-0000000000c1';
const CONVERSATION = '01924f00-0000-7000-8000-0000000000d1';
const DELIVERY = '01924f00-0000-7000-8000-0000000000e1';
const THREAD = { ticketId: '01924f00-0000-7000-8000-0000000000f1', departmentId: 'dept-1' };
const NOW = new Date('2026-10-11T09:00:00.000Z');

const account = {
  id: ACCOUNT_ID,
  brandId: BRAND,
  platform: 'messenger',
  externalId: META_FIXTURE.pageId,
  departmentId: 'dept-1',
} as MetaAccount;

const eventOf = (body: MetaWebhookBody): MetaEvent => {
  const [event] = routeEnvelope(metaEnvelopeSchema.parse(body)).routes.flatMap(
    (route) => route.events,
  );
  if (event === undefined) {
    throw new Error('the fixture holds no event');
  }
  return event;
};

const conversation = (over: Partial<MetaConversation> = {}): MetaConversation =>
  ({
    id: CONVERSATION,
    brandId: BRAND,
    accountId: ACCOUNT_ID,
    customerId: META_FIXTURE.psid,
    contactId: CONTACT,
    ticketId: THREAD.ticketId,
    profileName: null,
    ...over,
  }) as MetaConversation;

const harness = (over: Partial<MessengerInboundServiceOptions> = {}) => {
  const route = vi.fn(async () => ({
    kind: 'created' as const,
    ticketId: THREAD.ticketId,
    messageId: 'm1',
    contactId: CONTACT,
  }));
  const store = vi.fn(async () => undefined);
  const lookups = {
    conversation: vi.fn(async (): Promise<MetaConversation | undefined> => undefined),
    delivery: vi.fn(async (): Promise<MetaDelivery | undefined> => undefined),
    advanceStatus: vi.fn(async () => undefined),
    advanceByWatermark: vi.fn(async () => []),
    markError: vi.fn(async () => undefined),
  };
  const localeForContact = vi.fn(async () => 'en' as const);
  const findTicket = vi.fn(async () => ({
    ticket: { id: THREAD.ticketId, departmentId: THREAD.departmentId },
  }));
  const appId = vi.fn(async () => META_FIXTURE.appId);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new MessengerInboundService({
    repository: lookups,
    router: { route },
    sink: { store },
    tickets: { insertMessage: vi.fn(), nextSeq: vi.fn(), findTicket },
    lifecycleReads: { localeForContact },
    app: { appId },
    log,
    ...over,
  } as unknown as MessengerInboundServiceOptions);
  const handle = (body: MetaWebhookBody, now = NOW) =>
    service.handle({ tx: {} as DbTransaction, account, now } as MetaEventContext, eventOf(body));

  return { handle, route, store, lookups, localeForContact, findTicket, appId, log };
};

beforeEach(() => {
  state.seen.clear();
  state.threads.clear();
  state.lines.length = 0;
  state.profileRequests.length = 0;
});

describe('a message', () => {
  it('is routed under the Page-scoped identity, nameless until the profile job has been', async () => {
    const { handle, route } = harness();

    const outcome = await handle(pageText({ mid: 'mid.1', text: 'My order has not come' }));

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(route).toHaveBeenCalledOnce();
    const [context, message] = route.mock.calls[0] as unknown as [
      { brandId: string; account: MetaAccount },
      { externalId: string; from: unknown; bodyText: string; meta: { customerId: string } },
    ];
    expect(context).toMatchObject({ brandId: BRAND, account: { id: ACCOUNT_ID } });
    expect(message).toMatchObject({
      externalId: 'mid.1',
      bodyText: 'My order has not come',
      from: {
        kind: 'messenger',
        value: `${META_FIXTURE.pageId}:${META_FIXTURE.psid}`,
        name: null,
      },
      meta: { customerId: META_FIXTURE.psid },
    });
  });

  it('is filed under the name already stored for the conversation', async () => {
    const { handle, route, lookups } = harness();
    lookups.conversation.mockResolvedValue(conversation({ profileName: 'Mona Khalil' }));

    await handle(pageText({ mid: 'mid.2' }));

    expect(route.mock.calls[0]?.[1]).toMatchObject({ from: { name: 'Mona Khalil' } });
  });

  it('asks for the customer’s name, once the message is filed, when the conversation has none', async () => {
    const { handle, route, lookups } = harness();
    // Before the router there is no conversation; after it there is, with no name.
    lookups.conversation.mockResolvedValueOnce(undefined).mockResolvedValue(conversation());

    await handle(pageText({ mid: 'mid.1' }));

    expect(state.profileRequests).toEqual([
      {
        brandId: BRAND,
        profile: { conversationId: CONVERSATION, accountId: ACCOUNT_ID, platform: 'messenger' },
      },
    ]);
    expect(route).toHaveBeenCalledOnce();
  });

  it.each([
    ['it has a name', { profileName: 'Mona Khalil' }],
    ['the lookup was made and refused', { profileName: null, profileCheckedAt: NOW }],
  ])('does not ask again when %s', async (_why, over) => {
    const { handle, lookups } = harness();
    lookups.conversation.mockResolvedValue(conversation(over as Partial<MetaConversation>));

    await handle(pageText({ mid: 'mid.2' }));

    expect(state.profileRequests).toEqual([]);
  });

  it('refuses a customer id the contact layer could not spell, instead of failing the batch', async () => {
    const { handle, route } = harness();

    const outcome = await handle(pageText({ mid: 'mid.1', psid: 'a b' }));

    expect(outcome).toEqual({ outcome: 'ignored', reason: 'invalid-customer-id' });
    expect(route).not.toHaveBeenCalled();
    expect(state.profileRequests).toEqual([]);
  });

  it('files a message at the time Meta gave it, and never from the future', async () => {
    const past = harness();
    await past.handle(pageText({ mid: 'mid.1', timestamp: NOW.getTime() / 1_000 - 60 }));
    expect(past.route.mock.calls[0]?.[1]).toMatchObject({
      receivedAt: new Date(NOW.getTime() - 60_000),
    });

    const future = harness();
    await future.handle(pageText({ mid: 'mid.1', timestamp: NOW.getTime() / 1_000 + 3_600 }));
    expect(future.route.mock.calls[0]?.[1]).toMatchObject({ receivedAt: NOW });
  });

  it('carries attachments as CDN references with the declared type, and a sticker as one', async () => {
    const photo = harness();
    await photo.handle(pageAttachment({ mid: 'mid.1', type: 'image', text: 'Here it is' }));
    expect(photo.route.mock.calls[0]?.[1]).toMatchObject({
      bodyText: 'Here it is',
      meta: { fileRefs: [{ kind: 'cdn_url', type: 'image' }] },
    });

    const sticker = harness();
    await sticker.handle(pageSticker({ mid: 'mid.1' }));
    expect(sticker.route.mock.calls[0]?.[1]).toMatchObject({
      meta: { fileRefs: [{ kind: 'cdn_url', type: 'sticker' }] },
    });
  });

  it('files a fallback link as a text line with its URL', async () => {
    const { handle, route, lookups } = harness();
    lookups.conversation.mockResolvedValue(conversation());

    await handle(pageFallback({ mid: 'mid.1', url: 'https://maps.example.com/?q=1' }));

    expect(route.mock.calls[0]?.[1]).toMatchObject({
      bodyText: 'Brandenburg Gate\nhttps://maps.example.com/?q=1',
      meta: { fileRefs: [] },
    });
    expect(state.lines).toEqual([]);
  });

  it('adds no line when everything the message carried can be shown', async () => {
    const { handle } = harness();
    state.threads.set('mid.1', THREAD);

    await handle(pageAttachment({ mid: 'mid.1', type: 'image', text: 'See this' }));

    expect(state.lines).toEqual([]);
  });

  it('adds a line saying something is missing when a link came without a URL, beside the words that did', async () => {
    const { handle, route } = harness();
    state.threads.set('mid.1', THREAD);
    const body = pageFallback({ mid: 'mid.1', url: null });
    const message = (body as { entry: { messaging: { message: Record<string, unknown> }[] }[] })
      .entry[0]?.messaging[0]?.message;
    if (message === undefined) {
      throw new Error('the fixture has no message');
    }
    message.text = 'What is this place?';

    expect(await handle(body)).toEqual({ outcome: 'handled' });

    expect(route.mock.calls[0]?.[1]).toMatchObject({ bodyText: 'What is this place?' });
    expect(state.lines).toEqual([
      {
        thread: THREAD,
        line: {
          text: 'The customer sent something Helpdock cannot show.',
          key: 'unsupported:mid.1',
        },
      },
    ]);
  });
});

describe('an echo', () => {
  const echoOf = (over: Parameters<typeof pageEcho>[0] = {}) => pageEcho({ mid: 'mid.9', ...over });

  it('is dropped silently when the app that sent it is this install’s', async () => {
    const { handle, route, log } = harness();

    const outcome = await handle(echoOf({ appId: META_FIXTURE.appId }));

    expect(outcome).toEqual({ outcome: 'ignored', reason: 'echo' });
    expect(route).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('is dropped silently when its metadata names one of this account’s deliveries', async () => {
    const { handle, lookups, log } = harness();
    lookups.delivery.mockResolvedValue({ id: DELIVERY, accountId: ACCOUNT_ID } as MetaDelivery);

    const outcome = await handle(echoOf({ appId: '999', metadata: DELIVERY }));

    expect(outcome).toEqual({ outcome: 'ignored', reason: 'echo' });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('is counted when it is another app’s, a delivery of another account, or a metadata that is no id', async () => {
    const other = harness();
    other.lookups.delivery.mockResolvedValue({
      id: DELIVERY,
      accountId: OTHER_ACCOUNT_ID,
    } as MetaDelivery);
    expect(await other.handle(echoOf({ appId: '999', metadata: DELIVERY }))).toEqual({
      outcome: 'ignored',
      reason: 'echo-not-ours',
    });
    expect(other.log.info).toHaveBeenCalledWith(
      { accountId: ACCOUNT_ID },
      'messenger echo of a message Helpdock did not send; dropped',
    );

    const inbox = harness();
    expect(await inbox.handle(echoOf({ appId: '263902037430900' }))).toEqual({
      outcome: 'ignored',
      reason: 'echo-not-ours',
    });

    const noDelivery = harness();
    expect(await noDelivery.handle(echoOf({ appId: '999', metadata: DELIVERY }))).toEqual({
      outcome: 'ignored',
      reason: 'echo-not-ours',
    });

    const typed = harness();
    expect(await typed.handle(echoOf({ appId: '999', metadata: 'sent from the inbox' }))).toEqual({
      outcome: 'ignored',
      reason: 'echo-not-ours',
    });
    // Not an id at all: asking the database would be an error, not an answer.
    expect(typed.lookups.delivery).not.toHaveBeenCalled();
  });

  it('is never taken for ours by an app id when the install has none set', async () => {
    const { handle, appId } = harness();
    appId.mockResolvedValue('');

    expect(await handle(echoOf({ appId: META_FIXTURE.appId }))).toEqual({
      outcome: 'ignored',
      reason: 'echo-not-ours',
    });
  });
});

describe('a delivery or read report', () => {
  it.each([
    ['delivery', pageDelivery, 'delivered'],
    ['read', pageRead, 'read'],
  ] as const)(
    'marks the conversation’s deliveries up to a %s watermark, at its time',
    async (_kind, report, status) => {
      const { handle, lookups } = harness();
      lookups.conversation.mockResolvedValue(conversation());
      const watermark = META_FIXTURE.time + 120;

      expect(await handle(report({ watermark }))).toEqual({ outcome: 'handled' });

      expect(lookups.advanceByWatermark).toHaveBeenCalledWith(
        {},
        CONVERSATION,
        status,
        new Date(watermark * 1_000),
      );
      expect(lookups.advanceStatus).not.toHaveBeenCalled();
    },
  );

  it('also moves the messages a delivery names, one by one', async () => {
    const { handle, lookups } = harness();
    lookups.conversation.mockResolvedValue(conversation());
    const watermark = META_FIXTURE.time + 120;

    await handle(pageDelivery({ watermark, mids: ['mid.a', 'mid.b'] }));

    expect(lookups.advanceStatus.mock.calls).toEqual([
      [{}, 'mid.a', 'delivered', new Date(watermark * 1_000)],
      [{}, 'mid.b', 'delivered', new Date(watermark * 1_000)],
    ]);
  });

  it('is dropped for a customer the account has no conversation with', async () => {
    const { handle, lookups } = harness();

    expect(await handle(pageRead())).toEqual({ outcome: 'ignored', reason: 'no-conversation' });
    expect(lookups.advanceByWatermark).not.toHaveBeenCalled();
  });

  it('is dropped when it names neither a watermark nor a message', async () => {
    const { handle, lookups } = harness();
    lookups.conversation.mockResolvedValue(conversation());
    const body = pageDelivery({ mids: [] }) as {
      entry: { messaging: { delivery: Record<string, unknown> }[] }[];
    };
    const delivery = body.entry[0]?.messaging[0]?.delivery;
    if (delivery === undefined) {
      throw new Error('the fixture has no delivery');
    }
    delete delivery.watermark;

    expect(await handle(body)).toEqual({ outcome: 'ignored', reason: 'empty-receipt' });
    expect(lookups.advanceByWatermark).not.toHaveBeenCalled();
  });
});

describe('a reaction or an edit', () => {
  it('is a system line on the ticket of the message it is about, once however often it arrives', async () => {
    const { handle, lookups } = harness();
    lookups.conversation.mockResolvedValue(conversation());
    state.threads.set('mid.reply', THREAD);
    const reaction = pageReaction({ mid: 'mid.reply', emoji: '❤️' });

    expect(await handle(reaction)).toEqual({ outcome: 'handled' });
    expect(await handle(reaction)).toEqual({ outcome: 'duplicate' });

    expect(state.lines).toEqual([
      {
        thread: THREAD,
        line: {
          text: 'The customer reacted ❤️ to a message.',
          key: `reaction:mid.reply:${META_FIXTURE.psid}:react:${String(META_FIXTURE.time * 1_000)}`,
        },
      },
    ]);
  });

  it('tells a reaction that was taken back, and one without an emoji, apart', async () => {
    const { handle, lookups } = harness();
    lookups.conversation.mockResolvedValue(conversation());
    state.threads.set('mid.reply', THREAD);

    await handle(pageReaction({ mid: 'mid.reply', action: 'unreact' }));
    const plain = pageReaction({ mid: 'mid.reply', timestamp: META_FIXTURE.time + 1 });
    const message = (plain as { entry: { messaging: { reaction: Record<string, unknown> }[] }[] })
      .entry[0]?.messaging[0]?.reaction;
    if (message === undefined) {
      throw new Error('the fixture has no reaction');
    }
    delete message.emoji;
    await handle(plain);

    expect(state.lines.map(({ line }) => line.text)).toEqual([
      'The customer removed their reaction from a message.',
      'The customer reacted to a message.',
    ]);
  });

  it('is written in the contact’s language', async () => {
    const { handle, lookups, localeForContact } = harness();
    lookups.conversation.mockResolvedValue(conversation());
    localeForContact.mockResolvedValue('ar' as never);
    state.threads.set('mid.reply', THREAD);

    await handle(pageReaction({ mid: 'mid.reply', emoji: '👍' }));

    expect(state.lines[0]?.line.text).toBe('تفاعل العميل بـ 👍 مع رسالة.');
    expect(localeForContact).toHaveBeenCalledWith({}, BRAND, CONTACT);
  });

  it('is dropped for a message Helpdock never filed or sent', async () => {
    const { handle } = harness();

    expect(await handle(pageReaction({ mid: 'mid.unknown' }))).toEqual({
      outcome: 'ignored',
      reason: 'unknown-message',
    });
    expect(await handle(pageEdit({ mid: 'mid.unknown' }))).toEqual({
      outcome: 'ignored',
      reason: 'unknown-message',
    });
    expect(state.lines).toEqual([]);
  });

  it('keeps the edited words in the line, keyed by the edit', async () => {
    const { handle, lookups } = harness();
    lookups.conversation.mockResolvedValue(conversation());
    state.threads.set('mid.1', THREAD);

    expect(await handle(pageEdit({ mid: 'mid.1', text: 'Order 77, not 78', numEdit: 2 }))).toEqual({
      outcome: 'handled',
    });

    expect(state.lines).toEqual([
      {
        thread: THREAD,
        line: {
          text: 'The customer edited a message. It now reads: Order 77, not 78',
          key: 'edit:mid.1:2',
        },
      },
    ]);
  });

  it('drops an edit with no words in it', async () => {
    const { handle } = harness();
    state.threads.set('mid.1', THREAD);

    expect(await handle(pageEdit({ mid: 'mid.1', text: ' ' }))).toEqual({
      outcome: 'ignored',
      reason: 'empty-edit',
    });
  });
});

describe('something Helpdock cannot show', () => {
  /** Messenger's own flag for a message it will not describe. */
  const unsupported = (): MetaWebhookBody => {
    const body = pageText({ mid: 'mid.u' }) as {
      entry: { messaging: { message: Record<string, unknown> }[] }[];
    };
    const message = body.entry[0]?.messaging[0]?.message;
    if (message === undefined) {
      throw new Error('the fixture has no message');
    }
    message.text = '';
    message.is_unsupported = true;
    return body;
  };

  it('is a line on the conversation’s ticket, keyed by the message', async () => {
    const { handle, lookups } = harness();
    lookups.conversation.mockResolvedValue(conversation());

    expect(await handle(unsupported())).toEqual({ outcome: 'handled' });

    expect(state.lines).toEqual([
      {
        thread: { ticketId: THREAD.ticketId, departmentId: THREAD.departmentId },
        line: {
          text: 'The customer sent something Helpdock cannot show.',
          key: 'unsupported:mid.u',
        },
      },
    ]);
  });

  it('is dropped when the customer has no ticket to put it on', async () => {
    const none = harness();
    expect(await none.handle(unsupported())).toEqual({ outcome: 'ignored', reason: 'no-ticket' });

    const noTicket = harness();
    noTicket.lookups.conversation.mockResolvedValue(conversation({ ticketId: null }));
    expect(await noTicket.handle(unsupported())).toEqual({
      outcome: 'ignored',
      reason: 'no-ticket',
    });

    const gone = harness();
    gone.lookups.conversation.mockResolvedValue(conversation());
    gone.findTicket.mockResolvedValue(undefined as never);
    expect(await gone.handle(unsupported())).toEqual({ outcome: 'ignored', reason: 'no-ticket' });
    expect(state.lines).toEqual([]);
  });
});

describe('messaging policy enforcement', () => {
  const enforcement = (notice: { action?: string; reason?: string }): MetaWebhookBody => ({
    object: 'page',
    entry: [
      {
        id: META_FIXTURE.pageId,
        time: META_FIXTURE.time * 1_000,
        messaging: [{ 'policy-enforcement': notice }],
      },
    ],
  });

  it('is counted, dropped, and recorded on the account just after the event that carried it', async () => {
    const { handle, lookups } = harness();

    const outcome = await handle(
      enforcement({ action: 'block', reason: 'Messaging policy violation' }),
    );

    expect(outcome).toEqual({ outcome: 'ignored', reason: 'policy-enforcement' });
    expect(lookups.markError).toHaveBeenCalledWith(
      {},
      ACCOUNT_ID,
      'messaging_policy_enforcement block: Messaging policy violation',
      new Date(NOW.getTime() + 1),
    );
  });

  it('records a notice that names no action or reason', async () => {
    const { handle, lookups } = harness();

    await handle(enforcement({}));

    expect(lookups.markError.mock.calls[0]?.[2]).toBe('messaging_policy_enforcement');
  });

  it('does not call an unblock an error', async () => {
    const { handle, lookups } = harness();

    expect(await handle(enforcement({ action: 'unblock', reason: 'Restored' }))).toEqual({
      outcome: 'ignored',
      reason: 'policy-enforcement',
    });
    expect(lookups.markError).not.toHaveBeenCalled();
  });
});

describe('what Helpdock does not file', () => {
  it('counts and drops a postback, a referral and the other app’s thread', async () => {
    const { handle, route } = harness();

    expect(await handle(pagePostback())).toEqual({ outcome: 'ignored', reason: 'postback' });
    expect(
      await handle({
        object: 'page',
        entry: [
          {
            id: META_FIXTURE.pageId,
            time: 1,
            messaging: [
              {
                sender: { id: META_FIXTURE.psid },
                referral: { source: 'SHORTLINK', ref: 'spring' },
              },
            ],
          },
        ],
      }),
    ).toEqual({ outcome: 'ignored', reason: 'referral' });
    expect(
      await handle({
        object: 'page',
        entry: [{ id: META_FIXTURE.pageId, time: 1, standby: [{ sender: { id: '1' } }] }],
      }),
    ).toEqual({ outcome: 'ignored', reason: 'standby' });
    expect(route).not.toHaveBeenCalled();
  });

  it('drops, and warns about, an event only another platform sends', async () => {
    const { handle, log } = harness();
    const seenReceipt: MetaWebhookBody = {
      object: 'instagram',
      entry: [
        {
          id: META_FIXTURE.igAccountId,
          time: 1,
          messaging: [{ sender: { id: '1' }, read: { mid: 'mid.1' } }],
        },
      ],
    };

    expect(await handle(seenReceipt)).toEqual({
      outcome: 'ignored',
      reason: 'unexpected-seen',
    });
    expect(log.warn).toHaveBeenCalledWith(
      { kind: 'seen', platform: 'instagram' },
      'messenger received an event of another platform; dropped',
    );
  });
});
