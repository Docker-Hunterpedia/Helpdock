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
import type {
  DbTransaction,
  MetaAccount,
  MetaConversation,
  MetaDelivery,
  Ticket,
} from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactFailure } from '../contacts/contact-failure.js';
import {
  MessengerInboundService,
  type MessengerInboundServiceOptions,
} from './messenger-inbound.service.js';
import type { MetaEventContext } from './meta-inbound.service.js';

/**
 * The service's decisions with the database faked. That a message opens a
 * ticket under the right contact, that a watermark marks the right deliveries
 * and that a redelivery files nothing twice is proved against Postgres in
 * `meta-messenger.integration.test.ts`.
 */

const state = vi.hoisted(() => ({
  seen: new Set<string>(),
  profileRequests: [] as { brandId: string; profile: unknown }[],
}));
vi.mock('./meta-inbound-gate.js', () => ({
  metaMessageSeen: async (_tx: unknown, _brand: string, _platform: string, messageId: string) =>
    state.seen.has(messageId),
  metaSenderBlocked: async () => false,
}));
vi.mock('./messenger-profile.js', () => ({
  enqueueMetaProfile: async (_tx: unknown, brandId: string, profile: unknown) => {
    state.profileRequests.push({ brandId, profile });
    return 'outbox-id';
  },
}));

const BRAND = '01924f00-0000-7000-8000-0000000000a1';
const ACCOUNT_ID = '01924f00-0000-7000-8000-0000000000b1';
const OTHER_ACCOUNT_ID = '01924f00-0000-7000-8000-0000000000b2';
const CONTACT = '01924f00-0000-7000-8000-0000000000c1';
const CONVERSATION = '01924f00-0000-7000-8000-0000000000d1';
const DELIVERY = '01924f00-0000-7000-8000-0000000000e1';
const TICKET = {
  id: '01924f00-0000-7000-8000-0000000000f1',
  departmentId: 'dept-1',
  contactId: CONTACT,
} as Ticket;
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
    ticketId: TICKET.id,
    profileName: null,
    ...over,
  }) as MetaConversation;

/** A line the router was asked to write. */
interface WrittenLine {
  readonly ticket: Ticket;
  readonly accountId: string;
  readonly text: string;
  readonly externalMessageId?: string;
}

const harness = () => {
  const lines: WrittenLine[] = [];
  /** Messages by platform id, as `messageByPlatformId` finds them. */
  const messages = new Map<string, { id: string; ticketId: string; bodyText: string }>();
  const route = vi.fn(async (..._args: unknown[]) => ({
    kind: 'created' as const,
    ticketId: TICKET.id,
    messageId: 'm1',
    contactId: CONTACT,
    conversationId: CONVERSATION,
  }));
  const openTicket = vi.fn(async (..._args: unknown[]): Promise<Ticket | undefined> => TICKET);
  const writeSystemLine = vi.fn(async (_tx: unknown, line: WrittenLine) => {
    lines.push(line);
    if (line.externalMessageId !== undefined) {
      state.seen.add(line.externalMessageId);
    }
    return 'line-id';
  });
  const store = vi.fn(async () => undefined);
  const repository = {
    conversation: vi.fn(async (): Promise<MetaConversation | undefined> => undefined),
    delivery: vi.fn(async (): Promise<MetaDelivery | undefined> => undefined),
    advanceStatus: vi.fn(async () => undefined),
    advanceByWatermark: vi.fn(async () => []),
    markError: vi.fn(async (..._args: unknown[]) => undefined),
    upsertConversation: vi.fn(async () => conversation()),
    messageByPlatformId: vi.fn(
      async (_tx: unknown, _brand: string, _platform: string, id: string) => messages.get(id),
    ),
  };
  const localeForContact = vi.fn(async () => 'en' as 'en' | 'ar');
  const appId = vi.fn(async (): Promise<string> => META_FIXTURE.appId);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new MessengerInboundService({
    router: { route, openTicket, writeSystemLine },
    sink: { store },
    repository,
    lifecycleReads: { localeForContact },
    appId,
    log,
  } as unknown as MessengerInboundServiceOptions);
  const handle = (body: MetaWebhookBody, now = NOW) =>
    service.handle({ tx: {} as DbTransaction, account, now } as MetaEventContext, eventOf(body));

  return {
    handle,
    lines,
    messages,
    route,
    openTicket,
    writeSystemLine,
    repository,
    localeForContact,
    appId,
    log,
  };
};

beforeEach(() => {
  state.seen.clear();
  state.profileRequests.length = 0;
});

describe('a message', () => {
  it('is routed under the Page-scoped identity, nameless until the profile job has been', async () => {
    const { handle, route } = harness();

    const outcome = await handle(pageText({ mid: 'mid.1', text: 'My order has not come' }));

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(route).toHaveBeenCalledOnce();
    const [context, message] = route.mock.calls[0] as unknown as [
      { brandId: string; account: { id: string; platform: string; departmentId: string } },
      { externalId: string; from: unknown; bodyText: string; meta: { customerId: string } },
    ];
    expect(context).toMatchObject({
      brandId: BRAND,
      account: { id: ACCOUNT_ID, platform: 'messenger', departmentId: 'dept-1' },
    });
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
    const { handle, route, repository } = harness();
    repository.conversation.mockResolvedValue(conversation({ profileName: 'Mona Khalil' }));

    await handle(pageText({ mid: 'mid.2' }));

    expect(route.mock.calls[0]?.[1]).toMatchObject({ from: { name: 'Mona Khalil' } });
  });

  it('asks for the customer’s name, once the message is filed, when the conversation is new', async () => {
    const { handle, route } = harness();

    await handle(pageText({ mid: 'mid.1' }));

    expect(state.profileRequests).toEqual([
      {
        brandId: BRAND,
        profile: { conversationId: CONVERSATION, accountId: ACCOUNT_ID, platform: 'messenger' },
      },
    ]);
    expect(route).toHaveBeenCalledOnce();
  });

  it('asks again when the conversation exists but nobody has looked for a name', async () => {
    const { handle, repository } = harness();
    repository.conversation.mockResolvedValue(conversation());

    await handle(pageText({ mid: 'mid.2' }));

    expect(state.profileRequests).toHaveLength(1);
  });

  it.each([
    ['it has a name', { profileName: 'Mona Khalil' }],
    ['the lookup was made and refused', { profileName: null, profileCheckedAt: NOW }],
  ])('does not ask again when %s', async (_why, over) => {
    const { handle, repository } = harness();
    repository.conversation.mockResolvedValue(conversation(over as Partial<MetaConversation>));

    await handle(pageText({ mid: 'mid.2' }));

    expect(state.profileRequests).toEqual([]);
  });

  it('drops a customer id the contact layer refuses instead of failing the batch', async () => {
    const { handle, route, log } = harness();
    route.mockRejectedValue(new ContactFailure('identity-invalid', 'invalid-meta'));

    const outcome = await handle(pageText({ mid: 'mid.1', psid: 'a b' }));

    expect(outcome).toEqual({ outcome: 'ignored', reason: 'invalid-customer-id' });
    expect(state.profileRequests).toEqual([]);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('does not swallow a failure that is not the contact layer’s', async () => {
    const { handle, route } = harness();
    route.mockRejectedValue(new TypeError('a bug'));

    await expect(handle(pageText({ mid: 'mid.1' }))).rejects.toThrow('a bug');
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
    const { handle, route, lines } = harness();

    await handle(pageFallback({ mid: 'mid.1', url: 'https://maps.example.com/?q=1' }));

    expect(route.mock.calls[0]?.[1]).toMatchObject({
      bodyText: 'Brandenburg Gate\nhttps://maps.example.com/?q=1',
      meta: { fileRefs: [] },
    });
    expect(lines).toEqual([]);
  });

  it('adds no line when everything the message carried can be shown', async () => {
    const { handle, lines } = harness();

    await handle(pageAttachment({ mid: 'mid.1', type: 'image', text: 'See this' }));

    expect(lines).toEqual([]);
  });

  it('adds a line saying something is missing when a link came without a URL, beside the words that did', async () => {
    const { handle, route, lines, openTicket } = harness();
    const body = pageFallback({ mid: 'mid.1', url: null });
    const message = (body as { entry: { messaging: { message: Record<string, unknown> }[] }[] })
      .entry[0]?.messaging[0]?.message;
    if (message === undefined) {
      throw new Error('the fixture has no message');
    }
    message.text = 'What is this place?';

    expect(await handle(body)).toEqual({ outcome: 'handled' });

    expect(route.mock.calls[0]?.[1]).toMatchObject({ bodyText: 'What is this place?' });
    expect(openTicket).toHaveBeenCalledWith({}, TICKET.id);
    expect(lines).toEqual([
      {
        ticket: TICKET,
        accountId: ACCOUNT_ID,
        text: 'The customer sent something that cannot be shown here.',
        externalMessageId: 'unsupported:mid.1',
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
    const { handle, repository, log } = harness();
    repository.delivery.mockResolvedValue({ id: DELIVERY, accountId: ACCOUNT_ID } as MetaDelivery);

    const outcome = await handle(echoOf({ appId: '999', metadata: DELIVERY }));

    expect(outcome).toEqual({ outcome: 'ignored', reason: 'echo' });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('is counted when it is another app’s, a delivery of another account, or a metadata that is no id', async () => {
    const other = harness();
    other.repository.delivery.mockResolvedValue({
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
    expect(typed.repository.delivery).not.toHaveBeenCalled();
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
      const { handle, repository } = harness();
      repository.conversation.mockResolvedValue(conversation());
      const watermark = META_FIXTURE.time + 120;

      expect(await handle(report({ watermark }))).toEqual({ outcome: 'handled' });

      expect(repository.advanceByWatermark).toHaveBeenCalledWith(
        {},
        CONVERSATION,
        status,
        new Date(watermark * 1_000),
      );
      expect(repository.advanceStatus).not.toHaveBeenCalled();
    },
  );

  it('also moves the messages a delivery names, one by one', async () => {
    const { handle, repository } = harness();
    repository.conversation.mockResolvedValue(conversation());
    const watermark = META_FIXTURE.time + 120;

    await handle(pageDelivery({ watermark, mids: ['mid.a', 'mid.b'] }));

    expect(repository.advanceStatus.mock.calls).toEqual([
      [{}, 'mid.a', 'delivered', new Date(watermark * 1_000)],
      [{}, 'mid.b', 'delivered', new Date(watermark * 1_000)],
    ]);
  });

  it('is dropped for a customer the account has no conversation with', async () => {
    const { handle, repository } = harness();

    expect(await handle(pageRead())).toEqual({ outcome: 'ignored', reason: 'no-conversation' });
    expect(repository.advanceByWatermark).not.toHaveBeenCalled();
  });

  it('is dropped when it names neither a watermark nor a message', async () => {
    const { handle, repository } = harness();
    repository.conversation.mockResolvedValue(conversation());
    const body = pageDelivery({ mids: [] }) as {
      entry: { messaging: { delivery: Record<string, unknown> }[] }[];
    };
    const delivery = body.entry[0]?.messaging[0]?.delivery;
    if (delivery === undefined) {
      throw new Error('the fixture has no delivery');
    }
    delete delivery.watermark;

    expect(await handle(body)).toEqual({ outcome: 'ignored', reason: 'empty-receipt' });
    expect(repository.advanceByWatermark).not.toHaveBeenCalled();
  });
});

describe('a reaction or an edit', () => {
  const known = (messages: Map<string, { id: string; ticketId: string; bodyText: string }>) =>
    messages.set('mid.reply', { id: 'msg-1', ticketId: TICKET.id, bodyText: 'We are on it.' });

  it('is a system line on the ticket of the message it is about, once however often it arrives', async () => {
    const { handle, lines, messages } = harness();
    known(messages);
    const reaction = pageReaction({ mid: 'mid.reply', emoji: '❤️' });

    expect(await handle(reaction)).toEqual({ outcome: 'handled' });
    expect(await handle(reaction)).toEqual({ outcome: 'duplicate' });

    expect(lines).toEqual([
      {
        ticket: TICKET,
        accountId: ACCOUNT_ID,
        text: 'The customer reacted ❤️ to a message.',
        externalMessageId: `reaction:mid.reply:${META_FIXTURE.psid}:react:${String(META_FIXTURE.time * 1_000)}`,
      },
    ]);
  });

  it('tells a reaction that was taken back, and one without an emoji, apart', async () => {
    const { handle, lines, messages } = harness();
    known(messages);

    await handle(pageReaction({ mid: 'mid.reply', action: 'unreact' }));
    const plain = pageReaction({ mid: 'mid.reply', timestamp: META_FIXTURE.time + 1 });
    const reaction = (plain as { entry: { messaging: { reaction: Record<string, unknown> }[] }[] })
      .entry[0]?.messaging[0]?.reaction;
    if (reaction === undefined) {
      throw new Error('the fixture has no reaction');
    }
    delete reaction.emoji;
    await handle(plain);

    expect(lines.map((line) => line.text)).toEqual([
      'The customer removed their reaction to a message.',
      'The customer reacted to a message.',
    ]);
  });

  it('is written in the contact’s language, looked up by the ticket’s contact', async () => {
    const { handle, lines, messages, localeForContact } = harness();
    localeForContact.mockResolvedValue('ar');
    known(messages);

    await handle(pageReaction({ mid: 'mid.reply', emoji: '👍' }));

    expect(lines[0]?.text).toBe('تفاعل العميل بـ 👍 مع رسالة.');
    expect(localeForContact).toHaveBeenCalledWith({}, BRAND, CONTACT);
  });

  it('is dropped for a message Helpdock never filed or sent', async () => {
    const { handle, lines } = harness();

    expect(await handle(pageReaction({ mid: 'mid.unknown' }))).toEqual({
      outcome: 'ignored',
      reason: 'unknown-message',
    });
    expect(await handle(pageEdit({ mid: 'mid.unknown' }))).toEqual({
      outcome: 'ignored',
      reason: 'unknown-message',
    });
    expect(lines).toEqual([]);
  });

  it('is dropped when the ticket is closed or spam, as the router says', async () => {
    const { handle, lines, messages, openTicket } = harness();
    known(messages);
    openTicket.mockResolvedValue(undefined);

    expect(await handle(pageReaction({ mid: 'mid.reply' }))).toEqual({
      outcome: 'ignored',
      reason: 'no-open-ticket',
    });
    expect(lines).toEqual([]);
  });

  it('keeps the edited words in the line, keyed by the edit', async () => {
    const { handle, lines, messages } = harness();
    known(messages);

    expect(
      await handle(pageEdit({ mid: 'mid.reply', text: 'Order 77, not 78', numEdit: 2 })),
    ).toEqual({
      outcome: 'handled',
    });

    expect(lines).toEqual([
      {
        ticket: TICKET,
        accountId: ACCOUNT_ID,
        text: 'The customer edited a message. It now reads: Order 77, not 78',
        externalMessageId: 'edit:mid.reply:2',
      },
    ]);
  });

  it('drops an edit with no words in it', async () => {
    const { handle, messages } = harness();
    known(messages);

    expect(await handle(pageEdit({ mid: 'mid.reply', text: ' ' }))).toEqual({
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

  it('is a line on the conversation’s open ticket, keyed by the message, and opens the window', async () => {
    const { handle, lines, repository } = harness();
    repository.conversation.mockResolvedValue(conversation());

    expect(await handle(unsupported())).toEqual({ outcome: 'handled' });

    expect(lines).toEqual([
      {
        ticket: TICKET,
        accountId: ACCOUNT_ID,
        text: 'The customer sent something that cannot be shown here.',
        externalMessageId: 'unsupported:mid.u',
      },
    ]);
    expect(repository.upsertConversation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        customerId: META_FIXTURE.psid,
        contactId: CONTACT,
        inbound: { at: new Date(META_FIXTURE.time * 1_000), messageId: 'mid.u' },
      }),
    );
  });

  it('is dropped when the customer has no conversation or no open ticket to put it on', async () => {
    const none = harness();
    expect(await none.handle(unsupported())).toEqual({
      outcome: 'ignored',
      reason: 'no-conversation',
    });
    expect(none.repository.upsertConversation).not.toHaveBeenCalled();

    const noTicket = harness();
    noTicket.repository.conversation.mockResolvedValue(conversation({ ticketId: null }));
    expect(await noTicket.handle(unsupported())).toEqual({
      outcome: 'ignored',
      reason: 'no-open-ticket',
    });

    const closed = harness();
    closed.repository.conversation.mockResolvedValue(conversation());
    closed.openTicket.mockResolvedValue(undefined);
    expect(await closed.handle(unsupported())).toEqual({
      outcome: 'ignored',
      reason: 'no-open-ticket',
    });
    expect([...noTicket.lines, ...closed.lines]).toEqual([]);
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
    const { handle, repository } = harness();

    const outcome = await handle(
      enforcement({ action: 'block', reason: 'Messaging policy violation' }),
    );

    expect(outcome).toEqual({ outcome: 'ignored', reason: 'policy-enforcement' });
    expect(repository.markError).toHaveBeenCalledWith(
      {},
      ACCOUNT_ID,
      'messaging_policy_enforcement block: Messaging policy violation',
      new Date(NOW.getTime() + 1),
    );
  });

  it('records a notice that names no action or reason', async () => {
    const { handle, repository } = harness();

    await handle(enforcement({}));

    expect(repository.markError.mock.calls[0]?.[2]).toBe('messaging_policy_enforcement');
  });

  it('does not call an unblock an error', async () => {
    const { handle, repository } = harness();

    expect(await handle(enforcement({ action: 'unblock', reason: 'Restored' }))).toEqual({
      outcome: 'ignored',
      reason: 'policy-enforcement',
    });
    expect(repository.markError).not.toHaveBeenCalled();
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
