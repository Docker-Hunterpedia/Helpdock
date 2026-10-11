import {
  classifyMessagingEvent,
  fixtureMid,
  GraphApiFailure,
  instagramDeleted,
  instagramEcho,
  instagramReaction,
  instagramSeen,
  instagramStoryReply,
  instagramText,
  type MetaEvent,
  type MetaInboundMessage,
} from '@helpdock/channels';
import { createKeyring, encryptSecret } from '@helpdock/config';
import type { DbTransaction, MetaAccount, MetaConversation } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { TicketRepository } from '../tickets/tickets.repository.js';
import type { DeferredAttachmentSink } from './deferred-sink.js';
import {
  InstagramInboundService,
  type InstagramInboundServiceOptions,
} from './instagram-inbound.service.js';
import type { MetaRepository } from './meta.repository.js';
import type { MetaEventContext } from './meta-inbound.service.js';
import type { MetaConversationRouter } from './meta-router.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });
const TOKEN = 'IGQWRPbGl0ZXN0dG9rZW4xMjM0NTY3ODkw';
const IG_ACCOUNT = '17841400000000000';
const IGSID = '17841499999999999';
const NOW = new Date('2026-10-11T08:00:00Z');

const account = {
  id: '0196a1b2-0000-7000-8000-000000000001',
  brandId: '0196a1b2-0000-7000-8000-000000000002',
  departmentId: '0196a1b2-0000-7000-8000-000000000003',
  platform: 'instagram',
  externalId: IG_ACCOUNT,
  accessToken: encryptSecret(TOKEN, keyring),
} as MetaAccount;

const conversation = (overrides: Partial<MetaConversation> = {}): MetaConversation =>
  ({
    id: '0196a1b2-0000-7000-8000-000000000004',
    contactId: '0196a1b2-0000-7000-8000-000000000005',
    ticketId: null,
    profileName: null,
    username: null,
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
  readonly graph: { get: ReturnType<typeof vi.fn> };
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
    readonly existing?: MetaConversation;
    readonly profile?: unknown;
    readonly profileFails?: unknown;
    readonly appId?: string;
    readonly delivery?: { accountId: string };
    readonly advanced?: unknown;
  } = {},
): Harness => {
  const routed: MetaInboundMessage[] = [];
  const graph = {
    get: vi.fn(() =>
      setup.profileFails === undefined
        ? Promise.resolve(
            setup.profile ?? { id: IGSID, name: 'Sheena Nelson', username: 'sheena.n' },
          )
        : Promise.reject(setup.profileFails),
    ),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const repository = {
    conversation: vi.fn(() => Promise.resolve(setup.existing)),
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
    graph: () => graph as never,
    keyring,
    appId: () => Promise.resolve(setup.appId ?? '1234567890123456'),
    log,
  };

  return {
    service: new InstagramInboundService(options),
    context: { tx: {} as DbTransaction, account, now: NOW },
    routed,
    graph,
    log,
    repository,
  };
};

describe('InstagramInboundService › a message', () => {
  it('reads the profile once for a new conversation and files the message under it', async () => {
    const { service, context, routed, graph } = harness();

    const outcome = await service.handle(context, eventOf(instagramText({ text: 'Hi there' })));

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(graph.get).toHaveBeenCalledExactlyOnceWith(`/${IGSID}`, {
      token: TOKEN,
      api: 'instagram',
      query: { fields: 'name,username' },
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      channel: 'instagram',
      externalId: fixtureMid(1),
      bodyText: 'Hi there',
      from: { kind: 'instagram', value: `${IG_ACCOUNT}:${IGSID}`, name: 'Sheena Nelson' },
      meta: { profileName: 'Sheena Nelson', username: 'sheena.n', customerId: IGSID },
    });
  });

  it('does not read it again for a conversation that has a handle', async () => {
    const { service, context, routed, graph } = harness({
      existing: conversation({ username: 'sheena.n' }),
    });

    await service.handle(context, eventOf(instagramText()));

    expect(graph.get).not.toHaveBeenCalled();
    expect(routed[0]?.meta.username).toBeNull();
  });

  it('reads it again for a conversation whose earlier read failed', async () => {
    const { service, context, graph } = harness({ existing: conversation() });

    await service.handle(context, eventOf(instagramText()));

    expect(graph.get).toHaveBeenCalledOnce();
  });

  it('files the message without a name when the profile read fails, and logs no token', async () => {
    const { service, context, routed, log } = harness({
      profileFails: new GraphApiFailure('permission', `denied ${TOKEN}`, { code: 10 }),
    });

    const outcome = await service.handle(context, eventOf(instagramText()));

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(routed[0]?.from.name).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(TOKEN);
    expect(log.warn.mock.calls[0]?.[0]).toEqual({
      accountId: account.id,
      reason: 'permission',
      code: 10,
    });
  });

  it('files the message when the stored token cannot be opened', async () => {
    const { service, context, routed, graph, log } = harness();
    const broken = { ...context, account: { ...account, accessToken: 'not-an-envelope' } };

    const outcome = await service.handle(broken, eventOf(instagramText()));

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(graph.get).not.toHaveBeenCalled();
    expect(routed).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      { accountId: account.id, reason: 'SecretDecryptionError' },
      expect.any(String),
    );
  });

  it('files the message and names the class of whatever else the read threw', async () => {
    const { service, context, routed, graph, log } = harness();
    graph.get.mockImplementation(() => {
      throw new RangeError('a bug that quotes nothing secret');
    });

    const outcome = await service.handle(context, eventOf(instagramText()));

    expect(outcome).toEqual({ outcome: 'handled' });
    expect(routed).toHaveLength(1);
    expect(log.warn.mock.calls[0]?.[0]).toEqual({
      accountId: account.id,
      reason: 'RangeError',
      code: null,
    });
  });

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
