import {
  classifyMessagingEvent,
  fixtureMid,
  instagramDeleted,
  instagramEcho,
  instagramReaction,
  instagramSeen,
  instagramStoryReply,
  instagramText,
  type MetaEvent,
  type MetaInboundMessage,
} from '@helpdock/channels';
import type { DbTransaction, MetaAccount, MetaConversation } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { TicketRepository } from '../tickets/tickets.repository.js';
import type { DeferredAttachmentSink } from './deferred-sink.js';
import {
  InstagramInboundService,
  type InstagramInboundServiceOptions,
} from './instagram-inbound.service.js';
import type { MetaRepository } from './meta.repository.js';
import { enqueueMetaProfile } from './meta-events.js';
import type { MetaEventContext } from './meta-inbound.service.js';
import type { MetaConversationRouter } from './meta-router.js';

const IG_ACCOUNT = '17841400000000000';
const IGSID = '17841499999999999';
const NOW = new Date('2026-10-11T08:00:00Z');

// The outbox row is the integration suite's to prove; here only that it is asked for.
vi.mock('./meta-events.js', () => ({
  enqueueMetaProfile: vi.fn(() => Promise.resolve('outbox-id')),
}));

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
    ticketId: null,
    profileName: null,
    username: null,
    profileCheckedAt: null,
    ...overrides,
  }) as MetaConversation;

const eventOf = (body: Record<string, unknown>): MetaEvent => {
  const entry = (body.entry as { messaging: unknown[] }[])[0];
  return classifyMessagingEvent(entry?.messaging[0], 'instagram');
};

interface Harness {
  readonly service: InstagramInboundService;
  readonly context: MetaEventContext;
  readonly routed: MetaInboundMessage[];
  readonly log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  readonly repository: {
    conversation: ReturnType<typeof vi.fn>;
    delivery: ReturnType<typeof vi.fn>;
    advanceStatus: ReturnType<typeof vi.fn>;
  };
}

const harness = (
  setup: {
    /** The conversation before the message, and (if it differs) as the router leaves it. */
    readonly existing?: MetaConversation;
    readonly afterRouting?: MetaConversation;
    readonly account?: MetaAccount;
    readonly appId?: string;
    readonly delivery?: { accountId: string };
    readonly advanced?: unknown;
  } = {},
): Harness => {
  const routed: MetaInboundMessage[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const repository = {
    // The service looks twice: before it routes, and again for the row the router wrote.
    conversation: vi
      .fn()
      .mockResolvedValueOnce(setup.existing)
      .mockResolvedValue(setup.afterRouting ?? setup.existing ?? conversation()),
    delivery: vi.fn(() => Promise.resolve(setup.delivery)),
    advanceStatus: vi.fn(() => Promise.resolve(setup.advanced)),
  };
  const options: InstagramInboundServiceOptions = {
    repository: repository as unknown as MetaRepository,
    router: {
      route: (_context: unknown, message: MetaInboundMessage) => {
        routed.push(message);
        return Promise.resolve({ kind: 'created', ticketId: 't', messageId: 'm', contactId: 'c' });
      },
    } as unknown as MetaConversationRouter,
    sink: {} as DeferredAttachmentSink,
    tickets: {} as TicketRepository,
    lifecycleReads: {
      localeForContact: () => Promise.resolve('en'),
    } as unknown as TicketLifecycleRepository,
    appId: () => Promise.resolve(setup.appId ?? '1234567890123456'),
    log,
  };

  return {
    service: new InstagramInboundService(options),
    context: { tx: {} as DbTransaction, account: setup.account ?? account, now: NOW },
    routed,
    log,
    repository,
  };
};

beforeEach(() => {
  vi.mocked(enqueueMetaProfile).mockClear();
});

describe('InstagramInboundService › a message', () => {
  it('files the message and asks for the customer’s name with an event beside it', async () => {
    const { service, context, routed } = harness({ afterRouting: conversation() });

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

  it.each([
    ['a name', { profileName: 'Sheena Nelson' }],
    ['a handle', { username: 'sheena.n' }],
    ['an answer from Graph, however it came out', { profileCheckedAt: NOW }],
  ])('asks for nothing about a customer who already has %s', async (_what, facts) => {
    const known = conversation(facts);
    const { service, context } = harness({ existing: known, afterRouting: known });

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

  it('drops silently an echo that names one of the account’s deliveries', async () => {
    const { service, context, repository } = harness({ delivery: { accountId: account.id } });
    const deliveryId = '0196a1b2-0000-7000-8000-0000000000aa';

    expect(await service.handle(context, echoWith({ metadata: deliveryId }))).toEqual({
      outcome: 'ignored',
      reason: 'own-echo',
    });
    expect(repository.delivery).toHaveBeenCalledWith(context.tx, deliveryId);
  });

  it('counts an echo of a delivery that belongs to another account', async () => {
    const { service, context, log } = harness({ delivery: { accountId: 'someone-else' } });

    expect(
      await service.handle(context, echoWith({ metadata: '0196a1b2-0000-7000-8000-0000000000aa' })),
    ).toEqual({ outcome: 'ignored', reason: 'echo' });
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('counts an echo typed outside Helpdock, and never asks the database about a metadata that is not an id', async () => {
    const { service, context, repository, log } = harness({ appId: '' });

    expect(
      await service.handle(context, echoWith({ metadata: 'campaign-7', app_id: '42' })),
    ).toEqual({
      outcome: 'ignored',
      reason: 'echo',
    });
    expect(repository.delivery).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('does not take an echo for the install’s when no app id is set', async () => {
    const { service, context } = harness({ appId: '' });

    expect(await service.handle(context, echoWith({}))).toEqual({
      outcome: 'ignored',
      reason: 'echo',
    });
  });
});

describe('InstagramInboundService › the rest', () => {
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
      reason: 'no-delivery',
    });
  });

  it('drops a reaction that was taken back without a line', async () => {
    const { service, context } = harness();

    expect(
      await service.handle(context, eventOf(instagramReaction({ action: 'unreact' }))),
    ).toEqual({ outcome: 'ignored', reason: 'unreact' });
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
      'delivery',
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

  it('writes no line for an unsent message it has no row for', async () => {
    // Both lookups (the marker, then the message) find nothing.
    const { service, context, routed } = harness();
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    };

    const outcome = await service.handle(
      { ...context, tx: tx as unknown as DbTransaction },
      eventOf(instagramDeleted({ mid: fixtureMid(9) })),
    );

    expect(outcome).toEqual({ outcome: 'ignored', reason: 'message-unknown' });
    expect(routed).toEqual([]);
  });
});
