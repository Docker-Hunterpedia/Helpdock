import type { MetaInboundMessage } from '@helpdock/channels';
import type { DbTransaction, Ticket as TicketRow } from '@helpdock/db';
import type { MetaPlatform } from '@helpdock/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestAutoAssign } from '../assignment/assignment-events.js';
import { routesAutomatically } from '../assignment/ticket-assignment.js';
import { ContactFailure } from '../contacts/contact-failure.js';
import { attachVerifiedIdentity, findOrCreateContactByIdentity } from '../contacts/identity.js';
import { writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent } from '../tickets/ticket-events.js';
import {
  type FollowedTicket,
  type MetaAttachmentSink,
  MetaConversationRouter,
  type MetaRouteContext,
} from './meta-router.js';

vi.mock('../contacts/identity.js', () => ({
  findOrCreateContactByIdentity: vi.fn(),
  attachVerifiedIdentity: vi.fn(),
}));
vi.mock('../tickets/ticket-activity.js', () => ({ writeTicketActivity: vi.fn() }));
vi.mock('../tickets/ticket-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tickets/ticket-events.js')>()),
  enqueueTicketEvent: vi.fn(),
}));
vi.mock('../assignment/assignment-events.js', () => ({ requestAutoAssign: vi.fn() }));
vi.mock('../assignment/ticket-assignment.js', () => ({ routesAutomatically: vi.fn() }));

/**
 * Where a Meta message lands, against doubles for the repositories and the
 * helpers that write: which ticket takes it, what is quoted above it, what is
 * handed to the sink, and what a system line is. The same router against a
 * database, with the three platforms' services in front of it, is
 * `meta.integration.test.ts`, `meta-messenger.integration.test.ts` and
 * `meta-instagram.integration.test.ts`.
 */

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const ACCOUNT = '01937f5e-7e53-7000-8000-000000000010';
const DEPARTMENT = '01937f5e-7e53-7000-8000-000000000011';
const CONTACT = '01937f5e-7e53-7000-8000-000000000030';
const CONVERSATION = '01937f5e-7e53-7000-8000-000000000040';
const NOW = new Date('2026-10-11T10:00:00.000Z');
const tx = {} as DbTransaction;

const ticketRow = (id: string, overrides: Partial<TicketRow> = {}): TicketRow =>
  ({
    id,
    brandId: BRAND,
    departmentId: DEPARTMENT,
    channel: 'messenger',
    mergedIntoId: null,
    subject: 'Hello',
    priority: 'medium',
    createdAt: NOW,
    ...overrides,
  }) as TicketRow;

const followed = (
  id: string,
  status: Partial<FollowedTicket['status']> = {},
  ticket: Partial<TicketRow> = {},
): FollowedTicket => ({
  ticket: ticketRow(id, ticket),
  status: { id: 'status-open', isSpam: false, systemState: 'open', ...status } as never,
});

const message = (
  platform: MetaPlatform = 'messenger',
  overrides: Partial<MetaInboundMessage['meta']> = {},
  text = 'Where is my order?',
): MetaInboundMessage =>
  ({
    channel: platform,
    externalId: `${platform}:mid.1`,
    from: { kind: platform, value: `acct:cust-1`, name: null },
    cc: [],
    subject: '',
    bodyHtml: `<p>${text}</p>`,
    bodyText: text,
    files: [],
    hints: { messageIds: [], ticketNumbers: [] },
    receivedAt: NOW,
    meta: {
      platform,
      accountExternalId: 'acct',
      customerId: 'cust-1',
      messageId: 'mid.1',
      quotedId: null,
      fileRefs: [],
      profileName: null,
      username: null,
      waId: null,
      ...overrides,
    },
  }) as MetaInboundMessage;

const context = (platform: MetaPlatform = 'messenger'): MetaRouteContext => ({
  tx,
  brandId: BRAND,
  account: { id: ACCOUNT, departmentId: DEPARTMENT, platform, externalId: 'acct' },
  now: NOW,
});

/** The tickets and conversations the router reads, by id, and what it wrote. */
const harness = (
  setup: {
    /** The ticket the conversation is on, with its status. */
    readonly current?: FollowedTicket;
    readonly tickets?: readonly FollowedTicket[];
    readonly quoted?: { ticketId: string; bodyText: string };
    readonly reopenedAs?: TicketRow;
    readonly conversationTicketId?: string | null;
  } = {},
) => {
  const byId = new Map<string, FollowedTicket>(
    [...(setup.tickets ?? []), ...(setup.current === undefined ? [] : [setup.current])].map(
      (entry) => [entry.ticket.id, entry],
    ),
  );
  const inserted: Record<string, unknown>[] = [];
  const meta = {
    upsertConversation: vi.fn(async () => ({
      id: CONVERSATION,
      ticketId:
        'conversationTicketId' in setup
          ? setup.conversationTicketId
          : (setup.current?.ticket.id ?? null),
    })),
    setConversationTicket: vi.fn(async () => undefined),
    messageByPlatformId: vi.fn(async () => setup.quoted),
  };
  const tickets = {
    findTicket: vi.fn(async (_tx: unknown, id: string) => byId.get(id)),
    findDefaultStatus: vi.fn(async () => ({ id: 'status-new' })),
    brandPrefix: vi.fn(async () => 'HD'),
    nextNumber: vi.fn(async () => 42),
    insertTicket: vi.fn(async (_tx: unknown, values: Record<string, unknown>) =>
      ticketRow('ticket-new', { ...values } as Partial<TicketRow>),
    ),
    insertMessage: vi.fn(async (_tx: unknown, values: Record<string, unknown>) => {
      inserted.push(values);
      return { id: `message-${inserted.length}` };
    }),
    nextSeq: vi.fn(async () => 7),
    updateTicket: vi.fn(async () => undefined),
  };
  const lifecycle = {
    onCreated: vi.fn(async () => undefined),
    onCustomerReply: vi.fn(async (_context: unknown, ticket: TicketRow) => ({
      ticket: setup.reopenedAs ?? ticket,
    })),
  };
  const lifecycleReads = { localeForContact: vi.fn(async () => 'en') };
  const log = { warn: vi.fn() };
  const router = new MetaConversationRouter({
    meta,
    tickets,
    lifecycle,
    lifecycleReads,
    assignment: {},
    log,
  } as never);

  return { router, meta, tickets, lifecycle, lifecycleReads, log, inserted };
};

const sinkDouble = () => {
  const stored: Parameters<MetaAttachmentSink['store']>[1][] = [];
  const sink: MetaAttachmentSink = { store: async (_tx, input) => void stored.push(input) };
  return { sink, stored };
};

beforeEach(() => {
  vi.mocked(findOrCreateContactByIdentity)
    .mockReset()
    .mockResolvedValue({ contact: { id: CONTACT } } as never);
  vi.mocked(attachVerifiedIdentity)
    .mockReset()
    .mockResolvedValue({ plan: 'attach', identity: {}, otherContactId: null } as never);
  vi.mocked(writeTicketActivity)
    .mockReset()
    .mockResolvedValue(undefined as never);
  vi.mocked(enqueueTicketEvent)
    .mockReset()
    .mockResolvedValue(undefined as never);
  vi.mocked(requestAutoAssign)
    .mockReset()
    .mockResolvedValue(undefined as never);
  vi.mocked(routesAutomatically).mockReset().mockResolvedValue(false);
});

describe('followMerge', () => {
  it('follows a chain of merges to the ticket that ended it', async () => {
    const { router } = harness({
      tickets: [
        followed('a', {}, { mergedIntoId: 'b' }),
        followed('b', {}, { mergedIntoId: 'c' }),
        followed('c'),
      ],
    });

    expect((await router.followMerge(tx, 'a'))?.ticket.id).toBe('c');
  });

  it('answers undefined for a ticket that is gone, at any hop', async () => {
    const { router } = harness({ tickets: [followed('a', {}, { mergedIntoId: 'gone' })] });

    expect(await router.followMerge(tx, 'a')).toBeUndefined();
    expect(await router.followMerge(tx, 'missing')).toBeUndefined();
  });

  it('gives up on a cycle instead of following it for ever', async () => {
    const { router, tickets } = harness({
      tickets: [followed('a', {}, { mergedIntoId: 'b' }), followed('b', {}, { mergedIntoId: 'a' })],
    });

    expect(await router.followMerge(tx, 'a')).toBeUndefined();
    expect(tickets.findTicket).toHaveBeenCalledTimes(5);
  });
});

describe('openTicket', () => {
  it('answers the ticket a merge ended in when it is open', async () => {
    const { router } = harness({
      tickets: [followed('a', {}, { mergedIntoId: 'b' }), followed('b')],
    });

    expect((await router.openTicket(tx, 'a'))?.id).toBe('b');
  });

  it.each([
    ['closed', { systemState: 'closed' }],
    ['spam', { isSpam: true }],
  ] as const)(
    'answers undefined for a %s ticket: nobody reads a line there',
    async (_what, status) => {
      const { router } = harness({ tickets: [followed('a', status)] });

      expect(await router.openTicket(tx, 'a')).toBeUndefined();
    },
  );

  it('answers undefined for a ticket that is gone', async () => {
    expect(await harness().router.openTicket(tx, 'missing')).toBeUndefined();
  });
});

describe('writeSystemLine', () => {
  it('writes a system message on the ticket’s channel, escaped, in the next place of the thread', async () => {
    const { router, inserted } = harness();

    const id = await router.writeSystemLine(tx, {
      ticket: ticketRow('t-1', { channel: 'email' }),
      accountId: ACCOUNT,
      text: 'Reacted with <b>👍</b>',
    });

    expect(id).toBe('message-1');
    expect(inserted).toEqual([
      expect.objectContaining({
        ticketId: 't-1',
        seq: 7,
        kind: 'system',
        authorType: 'system',
        authorId: `meta:${ACCOUNT}`,
        bodyHtml: '<p>Reacted with &lt;b&gt;👍&lt;/b&gt;</p>',
        bodyText: 'Reacted with <b>👍</b>',
        channel: 'email',
      }),
    ]);
    expect(inserted[0]).not.toHaveProperty('externalMessageId');
  });

  it('carries the platform’s id for the event that caused the line, when it has one', async () => {
    const { router, inserted } = harness();

    await router.writeSystemLine(tx, {
      ticket: ticketRow('t-1'),
      accountId: ACCOUNT,
      text: 'Unsupported',
      externalMessageId: 'unsupported:mid.1',
    });

    expect(inserted[0]).toMatchObject({ externalMessageId: 'unsupported:mid.1' });
  });
});

describe('contactFor', () => {
  it.each([
    ['whatsapp', 'whatsapp.cloud'],
    ['messenger', 'messenger.page'],
    ['instagram', 'instagram.account'],
  ] as const)('keys a %s customer by the platform’s id, proven by %s', async (platform, source) => {
    const { router } = harness();

    const contact = await router.contactFor(tx, BRAND, message(platform));

    expect(contact.id).toBe(CONTACT);
    expect(findOrCreateContactByIdentity).toHaveBeenCalledWith(
      tx,
      BRAND,
      { kind: platform, value: 'acct:cust-1', source },
      {},
    );
  });

  it('names the contact only when the platform gave a name', async () => {
    const { router } = harness();
    const named = message('messenger');

    await router.contactFor(tx, BRAND, { ...named, from: { ...named.from, name: 'Omar Khalil' } });

    expect(findOrCreateContactByIdentity).toHaveBeenCalledWith(tx, BRAND, expect.anything(), {
      name: 'Omar Khalil',
    });
  });

  it('records the number beside a WhatsApp user id as a verified phone, and no other platform’s', async () => {
    const { router } = harness();

    await router.contactFor(tx, BRAND, message('whatsapp', { waId: '15550142' }));
    await router.contactFor(tx, BRAND, message('messenger', { waId: '15550142' }));
    await router.contactFor(tx, BRAND, message('whatsapp', { waId: null }));

    expect(attachVerifiedIdentity).toHaveBeenCalledExactlyOnceWith(tx, BRAND, CONTACT, {
      kind: 'phone',
      value: '+15550142',
      source: 'whatsapp.cloud',
    });
  });

  it('suggests a duplicate, and says so, when another contact holds the number with proof', async () => {
    vi.mocked(attachVerifiedIdentity).mockResolvedValue({
      plan: 'suggest',
      identity: {},
      otherContactId: 'other-contact',
    } as never);
    const { router, log } = harness();

    await router.contactFor(tx, BRAND, message('whatsapp', { waId: '15550142' }));

    expect(log.warn).toHaveBeenCalledWith(
      { contactId: CONTACT, otherContactId: 'other-contact' },
      expect.stringContaining('already held by another contact'),
    );
  });

  it('never costs the message a number that does not normalise, and never logs the number', async () => {
    vi.mocked(attachVerifiedIdentity).mockRejectedValue(new ContactFailure('identity-invalid'));
    const { router, log } = harness();

    await expect(
      router.contactFor(tx, BRAND, message('whatsapp', { waId: '15550142' })),
    ).resolves.toMatchObject({ id: CONTACT });

    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      { contactId: CONTACT },
      'a WhatsApp number is not a phone number; not recorded',
    );
  });

  it('lets any other failure through, because it is a bug and not a bad number', async () => {
    vi.mocked(attachVerifiedIdentity).mockRejectedValue(new Error('the database is down'));
    const { router } = harness();

    await expect(
      router.contactFor(tx, BRAND, message('whatsapp', { waId: '15550142' })),
    ).rejects.toThrow('the database is down');
  });
});

describe('route: a conversation with no ticket', () => {
  it('opens a ticket in the account’s department, on the platform’s channel, and files the message in it', async () => {
    const { router, tickets, lifecycle, meta, inserted } = harness({ conversationTicketId: null });

    const outcome = await router.route(
      context('messenger'),
      message('messenger'),
      sinkDouble().sink,
    );

    expect(outcome).toEqual({
      kind: 'created',
      ticketId: 'ticket-new',
      messageId: 'message-1',
      contactId: CONTACT,
      conversationId: CONVERSATION,
    });
    expect(tickets.insertTicket).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        brandId: BRAND,
        departmentId: DEPARTMENT,
        number: 42,
        prefix: 'HD',
        statusId: 'status-new',
        channel: 'messenger',
        contactId: CONTACT,
        subject: 'Where is my order?',
      }),
    );
    expect(inserted[0]).toMatchObject({
      seq: 1,
      kind: 'public',
      authorType: 'contact',
      authorId: CONTACT,
      externalMessageId: 'messenger:mid.1',
      bodyText: 'Where is my order?',
    });
    expect(lifecycle.onCreated).toHaveBeenCalledOnce();
    expect(meta.setConversationTicket).toHaveBeenCalledWith(tx, CONVERSATION, 'ticket-new');
    expect(vi.mocked(writeTicketActivity).mock.calls[0]?.[1]).toMatchObject({
      action: 'ticket.created',
      actor: { actorType: 'system', actorId: `meta:${ACCOUNT}`, via: 'system' },
    });
    expect(enqueueTicketEvent).toHaveBeenCalledWith(
      tx,
      BRAND,
      'ticket.created',
      expect.objectContaining({ ticketId: 'ticket-new' }),
    );
  });

  it('asks for the ticket to be routed only in a department that routes by itself', async () => {
    const { router } = harness({ conversationTicketId: null });

    await router.route(context(), message(), sinkDouble().sink);
    expect(requestAutoAssign).not.toHaveBeenCalled();

    vi.mocked(routesAutomatically).mockResolvedValue(true);
    await router.route(context(), message(), sinkDouble().sink);
    expect(requestAutoAssign).toHaveBeenCalledExactlyOnceWith(tx, BRAND, {
      ticketId: 'ticket-new',
      trigger: 'routed',
    });
  });

  it('opens a new ticket for a conversation whose ticket is gone', async () => {
    const { router } = harness({ conversationTicketId: 'deleted' });

    const outcome = await router.route(context(), message(), sinkDouble().sink);

    expect(outcome.kind).toBe('created');
  });
});

describe('route: a conversation with a ticket', () => {
  it('adds a customer reply to it, through the same reopen policy as every channel', async () => {
    const { router, lifecycle, meta, inserted } = harness({ current: followed('t-1') });

    const outcome = await router.route(context(), message(), sinkDouble().sink);

    expect(outcome).toMatchObject({ kind: 'replied', ticketId: 't-1' });
    expect(lifecycle.onCustomerReply).toHaveBeenCalledOnce();
    expect(inserted[0]).toMatchObject({ ticketId: 't-1', seq: 7, authorType: 'contact' });
    expect(meta.setConversationTicket).toHaveBeenCalledWith(tx, CONVERSATION, 't-1');
    expect(vi.mocked(writeTicketActivity).mock.calls[0]?.[1]).toMatchObject({
      action: 'ticket.replied',
      ticketId: 't-1',
    });
    expect(enqueueTicketEvent).toHaveBeenCalledWith(
      tx,
      BRAND,
      'ticket.replied',
      expect.objectContaining({ ticketId: 't-1', kind: 'public' }),
    );
  });

  it('goes where the reopen policy sent it: the conversation moves to the continuation', async () => {
    const { router, meta, tickets, inserted } = harness({
      current: followed('t-1'),
      reopenedAs: ticketRow('t-2'),
    });

    const outcome = await router.route(context(), message(), sinkDouble().sink);

    expect(outcome).toMatchObject({ kind: 'replied', ticketId: 't-2' });
    expect(inserted[0]).toMatchObject({ ticketId: 't-2' });
    expect(meta.setConversationTicket).toHaveBeenCalledWith(tx, CONVERSATION, 't-2');
    // The place in the thread is taken on the ticket the message ends up on.
    expect(tickets.nextSeq).toHaveBeenCalledTimes(2);
  });

  it('follows a merge to the ticket that took the conversation over', async () => {
    const { router } = harness({
      tickets: [followed('t-1', {}, { mergedIntoId: 't-9' }), followed('t-9')],
      conversationTicketId: 't-1',
    });

    const outcome = await router.route(context(), message(), sinkDouble().sink);

    expect(outcome).toMatchObject({ kind: 'replied', ticketId: 't-9' });
  });

  it('leaves a spam ticket where it is: nothing reopens it', async () => {
    const { router, lifecycle } = harness({ current: followed('t-1', { isSpam: true }) });

    const outcome = await router.route(context(), message(), sinkDouble().sink);

    expect(outcome).toMatchObject({ kind: 'replied', ticketId: 't-1' });
    expect(lifecycle.onCustomerReply).not.toHaveBeenCalled();
  });
});

describe('route: what is quoted', () => {
  const reply = (quoted: { ticketId: string; bodyText: string } | undefined) =>
    harness({ current: followed('t-1'), ...(quoted === undefined ? {} : { quoted }) });

  it('puts a quoted message above the reply when it is on this ticket', async () => {
    const { router, inserted, meta } = reply({ ticketId: 't-1', bodyText: 'Your order shipped' });

    await router.route(context(), message('messenger', { quotedId: 'mid.0' }), sinkDouble().sink);

    expect(meta.messageByPlatformId).toHaveBeenCalledWith(tx, BRAND, 'messenger', 'mid.0');
    expect(inserted[0]?.bodyHtml).toBe(
      '<blockquote><p>Your order shipped</p></blockquote><p>Where is my order?</p>',
    );
    expect(inserted[0]?.bodyText).toContain('Your order shipped');
  });

  it('never quotes a message from another ticket: it is a stranger’s words in this thread', async () => {
    const { router, inserted } = reply({ ticketId: 'other', bodyText: 'Somebody else’s order' });

    await router.route(context(), message('messenger', { quotedId: 'mid.0' }), sinkDouble().sink);

    expect(inserted[0]?.bodyHtml).toBe('<p>Where is my order?</p>');
  });

  it('quotes nothing for a message the desk never filed, or one that quotes nothing', async () => {
    const unknown = reply(undefined);
    await unknown.router.route(
      context(),
      message('messenger', { quotedId: 'mid.0' }),
      sinkDouble().sink,
    );
    const none = reply({ ticketId: 't-1', bodyText: 'unused' });
    await none.router.route(context(), message('messenger'), sinkDouble().sink);

    expect(unknown.inserted[0]?.bodyHtml).toBe('<p>Where is my order?</p>');
    expect(none.inserted[0]?.bodyHtml).toBe('<p>Where is my order?</p>');
    expect(none.meta.messageByPlatformId).not.toHaveBeenCalled();
  });

  it('clips a long quote and escapes it', async () => {
    const { router, inserted } = reply({
      ticketId: 't-1',
      bodyText: `<script>${'x'.repeat(400)}`,
    });

    await router.route(context(), message('messenger', { quotedId: 'mid.0' }), sinkDouble().sink);

    const html = String(inserted[0]?.bodyHtml);
    expect(html).not.toContain('<script>');
    expect(html).toContain('…');
    expect(html.length).toBeLessThan(400);
  });

  it('never quotes on a new ticket, which has nothing earlier on it', async () => {
    const { router, inserted, meta } = harness({ conversationTicketId: null });

    await router.route(context(), message('messenger', { quotedId: 'mid.0' }), sinkDouble().sink);

    expect(meta.messageByPlatformId).not.toHaveBeenCalled();
    expect(inserted[0]?.bodyHtml).toBe('<p>Where is my order?</p>');
  });
});

describe('route: the files a message named', () => {
  const refs = [
    { kind: 'cdn_url', url: 'https://scontent.xx.fbcdn.net/a.jpg', type: 'image' },
    { kind: 'cdn_url', url: 'https://scontent.xx.fbcdn.net/b.jpg', type: 'image' },
  ] as const;

  it('hands the references to the sink with a fresh id each, and the account whose token fetches them', async () => {
    const { router } = harness({ conversationTicketId: null });
    const { sink, stored } = sinkDouble();

    await router.route(context(), message('messenger', { fileRefs: refs }), sink);

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      brandId: BRAND,
      ticketId: 'ticket-new',
      departmentId: DEPARTMENT,
      messageId: 'message-1',
      contactId: CONTACT,
      accountId: ACCOUNT,
      refs,
    });
    expect(stored[0]?.ids).toHaveLength(2);
    expect(new Set(stored[0]?.ids).size).toBe(2);
    expect(stored[0]).not.toHaveProperty('refusal');
  });

  it('says why Meta could not serve them, so they are recorded rejected and never fetched', async () => {
    const { router } = harness({ current: followed('t-1') });
    const { sink, stored } = sinkDouble();

    await router.route(context(), message('messenger', { fileRefs: refs }), sink, {
      fileRefusal: 'object_missing',
    });

    expect(stored[0]).toMatchObject({ refusal: 'object_missing' });
  });

  it('does not call the sink for a message with no files', async () => {
    const { router } = harness({ current: followed('t-1') });
    const { sink, stored } = sinkDouble();

    await router.route(context(), message(), sink);

    expect(stored).toEqual([]);
  });
});
