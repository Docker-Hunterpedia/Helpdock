import {
  classifyMessagingEvent,
  type MetaEvent,
  type MetaInboundMessage,
} from '@helpdock/channels';
import {
  fixtureMid,
  instagramDeleted,
  instagramEcho,
  instagramReaction,
  instagramSeen,
  instagramStoryReply,
  instagramText,
  instagramUnsupported,
} from '@helpdock/channels/testing';
import type { DbTransaction, MetaAccount, MetaConversation, Ticket } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactFailure } from '../contacts/contact-failure.js';
import {
  InstagramInboundService,
  type InstagramInboundServiceOptions,
} from './instagram-inbound.service.js';
import { enqueueMetaProfile } from './meta-events.js';
import type { MetaEventContext } from './meta-inbound.service.js';

// The outbox row is the integration suite's to prove; here only that it is asked for.
vi.mock('./meta-events.js', () => ({
  enqueueMetaProfile: vi.fn(() => Promise.resolve('outbox-id')),
}));

const IG_ACCOUNT = '17841400000000000';
const IGSID = '17841499999999999';
const NOW = new Date('2026-10-11T08:00:00Z');

const account = {
  id: '0196a1b2-0000-7000-8000-000000000001',
  brandId: '0196a1b2-0000-7000-8000-000000000002',
  departmentId: '0196a1b2-0000-7000-8000-000000000003',
  platform: 'instagram',
  status: 'connected',
  externalId: IG_ACCOUNT,
} as MetaAccount;

const conversation = (overrides: Partial<MetaConversation> = {}): MetaConversation =>
  ({
    id: '0196a1b2-0000-7000-8000-000000000004',
    contactId: '0196a1b2-0000-7000-8000-000000000005',
    customerId: IGSID,
    ticketId: '0196a1b2-0000-7000-8000-000000000006',
    profileName: null,
    username: null,
    profileCheckedAt: null,
    ...overrides,
  }) as MetaConversation;

const ticket = {
  id: '0196a1b2-0000-7000-8000-000000000006',
  contactId: '0196a1b2-0000-7000-8000-000000000005',
} as Ticket;

const eventOf = (body: Record<string, unknown>): MetaEvent => {
  const entry = (body.entry as { messaging: unknown[] }[])[0];
  return classifyMessagingEvent(entry?.messaging[0], 'instagram');
};

interface Setup {
  readonly existing?: MetaConversation;
  readonly account?: MetaAccount;
  readonly appId?: string;
  readonly delivery?: { accountId: string };
  readonly advanced?: unknown;
  /** The message `messageByPlatformId` finds. */
  readonly found?: { ticketId: string; bodyText: string };
  /** The ticket the router calls open; undefined for a closed or missing one. */
  readonly open?: Ticket;
  /** Whether a system line with the external id is already in the brand. */
  readonly lineExists?: boolean;
}

const harness = (setup: Setup = {}) => {
  const routed: MetaInboundMessage[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const repository = {
    conversation: vi.fn(() => Promise.resolve(setup.existing)),
    delivery: vi.fn(() => Promise.resolve(setup.delivery)),
    advanceStatus: vi.fn(() => Promise.resolve(setup.advanced)),
    messageByPlatformId: vi.fn(() =>
      Promise.resolve(setup.found === undefined ? undefined : { id: 'm', ...setup.found }),
    ),
    systemLineSeen: vi.fn(() => Promise.resolve(setup.lineExists === true)),
    upsertConversation: vi.fn(() => Promise.resolve(conversation())),
  };
  const router = {
    route: vi.fn((_context: unknown, message: MetaInboundMessage) => {
      routed.push(message);
      return Promise.resolve({
        kind: 'created' as const,
        ticketId: 't',
        messageId: 'm',
        contactId: 'c',
        conversationId: conversation().id,
      });
    }),
    openTicket: vi.fn(() => Promise.resolve(setup.open)),
    writeSystemLine: vi.fn((_tx: DbTransaction, _input: { text: string }) =>
      Promise.resolve('line-id'),
    ),
  };
  const options = {
    router,
    sink: { store: vi.fn() },
    repository,
    lifecycleReads: { localeForContact: () => Promise.resolve('en' as const) },
    appId: () => Promise.resolve(setup.appId ?? '1234567890123456'),
    log,
  } as unknown as InstagramInboundServiceOptions;
  const tx = {} as DbTransaction;
  const context: MetaEventContext = { tx, account: setup.account ?? account, now: NOW };

  return {
    service: new InstagramInboundService(options),
    context,
    routed,
    log,
    repository,
    router,
  };
};

beforeEach(() => {
  vi.mocked(enqueueMetaProfile).mockClear();
});

describe('InstagramInboundService › a message', () => {
  it('files the message and asks for the customer’s name with an event beside it', async () => {
    const { service, context, routed } = harness();

    const outcome = await service.handle(context, eventOf(instagramText({ text: 'Hi there' })));

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      channel: 'instagram',
      externalId: fixtureMid(1),
      bodyText: 'Hi there',
      // Meta's message carries no name: the profile job fills it in afterwards.
      from: { kind: 'instagram', value: `${IG_ACCOUNT}:${IGSID}`, name: null },
      meta: { profileName: null, username: null, customerId: IGSID },
    });
    expect(enqueueMetaProfile).toHaveBeenCalledExactlyOnceWith(context.tx, account.brandId, {
      conversationId: conversation().id,
      accountId: account.id,
      platform: 'instagram',
    });
  });

  it('drops a customer id the contact layer refuses instead of failing every event of the batch', async () => {
    const { service, context, router, log } = harness();
    router.route.mockRejectedValue(new ContactFailure('identity-invalid', 'invalid-meta'));

    const outcome = await service.handle(context, eventOf(instagramText({ text: 'Hi' })));

    expect(outcome).toEqual({ outcome: 'ignored', reason: 'invalid-customer-id' });
    expect(enqueueMetaProfile).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('does not swallow a failure that is not the contact layer’s', async () => {
    const { service, context, router } = harness();
    router.route.mockRejectedValue(new TypeError('a bug'));

    await expect(service.handle(context, eventOf(instagramText()))).rejects.toThrow('a bug');
  });

  it.each([
    ['a name', { profileName: 'Sheena Nelson' }],
    ['a handle', { username: 'sheena.n' }],
    ['an answer from Graph, however it came out', { profileCheckedAt: NOW }],
  ])('asks for nothing about a customer who already has %s', async (_what, facts) => {
    const { service, context } = harness({ existing: conversation(facts) });

    await service.handle(context, eventOf(instagramText()));

    expect(enqueueMetaProfile).not.toHaveBeenCalled();
  });

  it('asks again for a customer whose earlier lookup could not be answered', async () => {
    // Nothing was recorded: Meta was down, or the token had stopped working.
    const { service, context } = harness({ existing: conversation() });

    await service.handle(context, eventOf(instagramText()));

    expect(enqueueMetaProfile).toHaveBeenCalledOnce();
  });

  it.each(['token_expired', 'unsubscribed'] as const)(
    'asks for nothing on an account that is %s: it could not answer',
    async (status) => {
      const { service, context } = harness({ account: { ...account, status } });

      await service.handle(context, eventOf(instagramText()));

      expect(enqueueMetaProfile).not.toHaveBeenCalled();
    },
  );

  it('files a story reply with the story’s line, its media reference and the localised words', async () => {
    const { service, context, routed } = harness({ existing: conversation({ username: 'x' }) });

    await service.handle(
      context,
      eventOf(
        instagramStoryReply({ text: 'Love this one!', url: 'https://lookaside.fbsbx.com/s' }),
      ),
    );

    expect(routed[0]?.bodyText).toBe(
      'Love this one!\nReplied to your story\nhttps://lookaside.fbsbx.com/s',
    );
    expect(routed[0]?.meta.fileRefs).toEqual([
      { kind: 'cdn_url', url: 'https://lookaside.fbsbx.com/s', type: 'story' },
    ]);
  });

  it('dates the message by Meta’s clock, never later than its own', async () => {
    const { service, context, routed } = harness({ existing: conversation({ username: 'x' }) });
    const future = instagramText({ timestamp: Math.floor(NOW.getTime() / 1_000) + 3_600 });
    const past = instagramText({
      mid: fixtureMid(2),
      timestamp: Math.floor(NOW.getTime() / 1_000) - 90,
    });

    await service.handle(context, eventOf(future));
    await service.handle(context, eventOf(past));

    expect(routed[0]?.receivedAt).toEqual(NOW);
    expect(routed[1]?.receivedAt).toEqual(new Date(NOW.getTime() - 90_000));
  });
});

describe('InstagramInboundService › echoes', () => {
  const echoWith = (extra: Record<string, unknown>) => {
    const body = instagramEcho();
    const message = (body.entry as { messaging: { message: Record<string, unknown> }[] }[])[0]
      ?.messaging[0]?.message;
    Object.assign(message ?? {}, extra);
    return eventOf(body);
  };

  it('drops silently an echo that carries the install’s app id', async () => {
    const { service, context, log } = harness({ appId: '1234567890123456' });

    expect(await service.handle(context, echoWith({ app_id: '1234567890123456' }))).toEqual({
      outcome: 'ignored',
      reason: 'own-echo',
    });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('counts an echo typed outside Helpdock', async () => {
    const { service, context, log } = harness({ appId: '' });

    expect(await service.handle(context, echoWith({ app_id: '42' }))).toEqual({
      outcome: 'ignored',
      reason: 'foreign-echo',
    });
    expect(log.info).toHaveBeenCalledOnce();
  });
});

describe('InstagramInboundService › an unsent message', () => {
  const found = { ticketId: ticket.id, bodyText: 'Wrong thread, sorry' };

  it('keeps the message and writes one line on the open ticket, keyed by the message it marks', async () => {
    const { service, context, router } = harness({ found, open: ticket });

    const outcome = await service.handle(
      context,
      eventOf(instagramDeleted({ mid: fixtureMid(9) })),
    );

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(router.writeSystemLine).toHaveBeenCalledExactlyOnceWith(context.tx, {
      ticket,
      accountId: account.id,
      text: 'The customer unsent this message.',
      externalMessageId: `unsent:${fixtureMid(9)}`,
    });
  });

  it('is a duplicate when the line is already there, and asks nothing else', async () => {
    const { service, context, repository } = harness({ found, open: ticket, lineExists: true });

    expect(await service.handle(context, eventOf(instagramDeleted()))).toEqual({
      outcome: 'duplicate',
    });
    expect(repository.messageByPlatformId).not.toHaveBeenCalled();
  });

  it('writes no line for a message Helpdock never filed', async () => {
    const { service, context, router } = harness();

    expect(await service.handle(context, eventOf(instagramDeleted()))).toEqual({
      outcome: 'ignored',
      reason: 'unknown-message',
    });
    expect(router.writeSystemLine).not.toHaveBeenCalled();
  });

  it('writes no line on a ticket that is closed or spam', async () => {
    const { service, context, router } = harness({ found });

    expect(await service.handle(context, eventOf(instagramDeleted()))).toEqual({
      outcome: 'ignored',
      reason: 'no-open-ticket',
    });
    expect(router.writeSystemLine).not.toHaveBeenCalled();
  });
});

describe('InstagramInboundService › something it cannot show', () => {
  it('moves the window to the message and writes a line on the open ticket', async () => {
    const { service, context, repository, router } = harness({
      existing: conversation(),
      open: ticket,
    });
    const at = Math.floor(NOW.getTime() / 1_000) - 10;

    const outcome = await service.handle(
      context,
      eventOf(instagramUnsupported({ mid: fixtureMid(7), timestamp: at })),
    );

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(repository.upsertConversation).toHaveBeenCalledWith(
      context.tx,
      expect.objectContaining({
        accountId: account.id,
        customerId: IGSID,
        contactId: conversation().contactId,
        inbound: { at: new Date(at * 1_000), messageId: fixtureMid(7) },
      }),
    );
    expect(router.writeSystemLine).toHaveBeenCalledExactlyOnceWith(context.tx, {
      ticket,
      accountId: account.id,
      text: 'The customer sent something that cannot be shown here.',
      externalMessageId: `unsupported:${fixtureMid(7)}`,
    });
  });

  it('counts a first message, which has no conversation to note it on', async () => {
    const { service, context, repository, router } = harness();

    expect(await service.handle(context, eventOf(instagramUnsupported()))).toEqual({
      outcome: 'ignored',
      reason: 'no-conversation',
    });
    expect(repository.upsertConversation).not.toHaveBeenCalled();
    expect(router.writeSystemLine).not.toHaveBeenCalled();
  });

  it('is a duplicate when its line is already there, and moves nothing', async () => {
    const { service, context, repository } = harness({
      existing: conversation(),
      open: ticket,
      lineExists: true,
    });

    expect(await service.handle(context, eventOf(instagramUnsupported()))).toEqual({
      outcome: 'duplicate',
    });
    expect(repository.upsertConversation).not.toHaveBeenCalled();
  });
});

describe('InstagramInboundService › receipts and reactions', () => {
  it('moves a reply to read when the customer has seen it', async () => {
    const { service, context, repository } = harness({ advanced: { id: 'delivery' } });

    const outcome = await service.handle(context, eventOf(instagramSeen({ mid: fixtureMid(7) })));

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(repository.advanceStatus).toHaveBeenCalledExactlyOnceWith(
      context.tx,
      fixtureMid(7),
      'read',
      expect.any(Date),
    );
  });

  it('counts a receipt for a message Helpdock did not send', async () => {
    const { service, context } = harness({ advanced: undefined });

    expect(await service.handle(context, eventOf(instagramSeen()))).toEqual({
      outcome: 'ignored',
      reason: 'no-delivery-to-advance',
    });
  });

  it.each([
    ['a reaction with its emoji', { action: 'react', emoji: '❤️' }, 'reacted ❤️ to a message'],
    ['a reaction taken back', { action: 'unreact' }, 'removed their reaction'],
  ] as const)('writes %s as a line on the open ticket', async (_what, input, words) => {
    const { service, context, router } = harness({
      found: { ticketId: ticket.id, bodyText: 'We ship worldwide.' },
      open: ticket,
    });

    const outcome = await service.handle(context, eventOf(instagramReaction(input)));

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(router.writeSystemLine).toHaveBeenCalledOnce();
    expect(vi.mocked(router.writeSystemLine).mock.calls[0]?.[1].text).toContain(words);
  });

  it('words a reaction Meta sent without an emoji as a reaction to a message, and cuts a long one', async () => {
    const { service, context, router } = harness({
      found: { ticketId: ticket.id, bodyText: 'x' },
      open: ticket,
    });
    const bare = eventOf(instagramReaction());
    if (bare.kind !== 'reaction') {
      throw new Error('the fixture is a reaction');
    }

    await service.handle(context, { ...bare, emoji: null });
    await service.handle(context, { ...bare, emoji: 'x'.repeat(100) });

    const texts = vi.mocked(router.writeSystemLine).mock.calls.map((call) => call[1].text);
    expect(texts[0]).toBe('The customer reacted to a message.');
    expect(texts[1]).toBe(`The customer reacted ${'x'.repeat(32)} to a message.`);
  });

  it('drops a reaction to a message it does not know', async () => {
    const { service, context, router } = harness();

    expect(await service.handle(context, eventOf(instagramReaction()))).toEqual({
      outcome: 'ignored',
      reason: 'unknown-message',
    });
    expect(router.writeSystemLine).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a postback',
      { sender: { id: IGSID }, postback: { payload: 'x', title: 'Start' } },
      'postback',
    ],
    ['a referral', { sender: { id: IGSID }, referral: { ref: 'campaign' } }, 'referral'],
    [
      'a Messenger-style delivery receipt',
      { sender: { id: IGSID }, delivery: { watermark: 1 } },
      'wrong-platform',
    ],
    ['an event it does not know', { sender: { id: IGSID }, optin: {} }, 'unknown-event'],
  ])('counts and drops %s', async (_name, raw, reason) => {
    const { service, context, routed } = harness();

    expect(await service.handle(context, classifyMessagingEvent(raw, 'instagram'))).toEqual({
      outcome: 'ignored',
      reason,
    });
    expect(routed).toEqual([]);
  });
});
