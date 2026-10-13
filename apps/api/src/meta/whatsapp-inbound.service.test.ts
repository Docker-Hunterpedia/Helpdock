import { type MetaEvent, metaEnvelopeSchema, routeEnvelope } from '@helpdock/channels';
import {
  fixtureWamid,
  META_FIXTURE,
  type MetaWebhookBody,
  whatsappImage,
  whatsappNoWaId,
  whatsappReaction,
  whatsappStatus,
  whatsappText,
  whatsappUnsupported,
  whatsappUserChangedNumber,
} from '@helpdock/channels/testing';
import type { DbTransaction, MetaAccount, MetaConversation, Ticket } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactFailure } from '../contacts/contact-failure.js';
import { attachVerifiedIdentity, removeIdentity } from '../contacts/identity.js';
import { isSenderBlocked } from '../ticketing/sender-gate.js';
import type { MetaEventContext } from './meta-inbound.service.js';
import {
  WhatsAppInboundService,
  type WhatsAppInboundServiceOptions,
} from './whatsapp-inbound.service.js';

/**
 * The service's decisions with the database faked. That a message opens a
 * ticket under the right contact, that a status moves the right delivery and
 * that a redelivery files nothing twice is proved against Postgres in
 * `meta.integration.test.ts`.
 */

vi.mock('../contacts/identity.js', () => ({
  attachVerifiedIdentity: vi.fn(async () => ({ plan: 'attached' })),
  removeIdentity: vi.fn(async () => undefined),
  findByIdentity: vi.fn(async () => undefined),
}));
vi.mock('../ticketing/sender-gate.js', () => ({
  isSenderBlocked: vi.fn(async () => ({ blocked: false })),
}));

const BRAND = '01924f00-0000-7000-8000-0000000000a1';
const ACCOUNT_ID = '01924f00-0000-7000-8000-0000000000b1';
const CONTACT = '01924f00-0000-7000-8000-0000000000c1';
const CONVERSATION = '01924f00-0000-7000-8000-0000000000d1';
const TICKET = {
  id: '01924f00-0000-7000-8000-0000000000f1',
  departmentId: 'dept-1',
  contactId: CONTACT,
} as Ticket;
const NOW = new Date('2026-10-11T09:00:00.000Z');

const account = {
  id: ACCOUNT_ID,
  brandId: BRAND,
  platform: 'whatsapp',
  status: 'connected',
  externalId: META_FIXTURE.phoneNumberId,
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
    customerId: META_FIXTURE.userId,
    contactId: CONTACT,
    ticketId: TICKET.id,
    waId: META_FIXTURE.waId,
    ...over,
  }) as MetaConversation;

interface WrittenLine {
  readonly ticket: Ticket;
  readonly accountId: string;
  readonly text: string;
  readonly externalMessageId?: string;
}

const harness = () => {
  const lines: WrittenLine[] = [];
  const seen = new Set<string>();
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
      seen.add(line.externalMessageId);
    }
    return 'line-id';
  });
  const repository = {
    conversation: vi.fn(async (): Promise<MetaConversation | undefined> => undefined),
    advanceStatus: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'delivery' })),
    failByReport: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'delivery' })),
    recordPricing: vi.fn(async (..._args: unknown[]) => undefined),
    markError: vi.fn(async (..._args: unknown[]) => undefined),
    systemLineSeen: vi.fn(async (_tx: unknown, _brand: string, key: string) => seen.has(key)),
    upsertConversation: vi.fn(async (..._args: unknown[]) => conversation()),
    messageByPlatformId: vi.fn(
      async (_tx: unknown, _brand: string, _platform: string, id: string) => messages.get(id),
    ),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new WhatsAppInboundService({
    router: { route, openTicket, writeSystemLine },
    sink: { store: vi.fn() },
    repository,
    lifecycleReads: { localeForContact: vi.fn(async () => 'en' as const) },
    log,
  } as unknown as WhatsAppInboundServiceOptions);
  const handle = (body: MetaWebhookBody, now = NOW) =>
    service.handle({ tx: {} as DbTransaction, account, now } as MetaEventContext, eventOf(body));

  return { handle, lines, messages, route, openTicket, repository, log };
};

beforeEach(() => {
  vi.mocked(isSenderBlocked).mockClear();
  vi.mocked(isSenderBlocked).mockResolvedValue({ blocked: false } as never);
  vi.mocked(attachVerifiedIdentity).mockClear();
  vi.mocked(removeIdentity).mockClear();
});

describe('a message', () => {
  it('is routed under the business-scoped user id, with the number as what Meta sent beside it', async () => {
    const { handle, route } = harness();

    const outcome = await handle(whatsappText({ text: 'Does it come in blue?' }));

    expect(outcome).toEqual({ outcome: 'handled' });
    const [context, message] = route.mock.calls[0] as unknown as [
      { brandId: string; account: { platform: string; id: string } },
      { externalId: string; bodyText: string; from: unknown; meta: { waId: string } },
    ];
    expect(context).toMatchObject({
      brandId: BRAND,
      account: { id: ACCOUNT_ID, platform: 'whatsapp' },
    });
    expect(message).toMatchObject({
      externalId: fixtureWamid(1),
      bodyText: 'Does it come in blue?',
      from: { kind: 'whatsapp', value: META_FIXTURE.userId, name: META_FIXTURE.profileName },
      meta: { waId: META_FIXTURE.waId },
    });
  });

  it('files a customer who withheld their number by the user id alone', async () => {
    const { handle, route } = harness();

    expect(await handle(whatsappNoWaId())).toEqual({ outcome: 'handled' });

    expect(route.mock.calls[0]?.[1]).toMatchObject({
      from: { kind: 'whatsapp', value: META_FIXTURE.userId },
      meta: { waId: null },
    });
  });

  it('dates the message by Meta’s clock, and never from the future', async () => {
    const past = harness();
    await past.handle(whatsappText({ timestamp: NOW.getTime() / 1_000 - 60 }));
    expect(past.route.mock.calls[0]?.[1]).toMatchObject({
      receivedAt: new Date(NOW.getTime() - 60_000),
    });

    const future = harness();
    await future.handle(whatsappText({ timestamp: NOW.getTime() / 1_000 + 3_600 }));
    expect(future.route.mock.calls[0]?.[1]).toMatchObject({ receivedAt: NOW });
  });

  it('is dropped, counted, when its sender’s phone number is on the block list', async () => {
    const { handle, route } = harness();
    vi.mocked(isSenderBlocked).mockResolvedValue({ blocked: true } as never);

    expect(await handle(whatsappText())).toEqual({ outcome: 'ignored', reason: 'blocked-sender' });

    expect(route).not.toHaveBeenCalled();
    expect(isSenderBlocked).toHaveBeenCalledWith(
      expect.anything(),
      BRAND,
      { kind: 'phone', value: `+${META_FIXTURE.waId}` },
      { now: NOW },
    );
  });

  it('is not asked about a phone number for a customer who withheld it', async () => {
    const { handle } = harness();

    await handle(whatsappNoWaId());

    expect(isSenderBlocked).not.toHaveBeenCalled();
  });

  it('records Meta’s refusal to serve a file on the file, and says so in the log', async () => {
    const { handle, route, log } = harness();
    const body = whatsappImage() as { entry: { changes: { value: { messages: object[] } }[] }[] };
    const message = body.entry[0]?.changes[0]?.value.messages[0];
    Object.assign(message ?? {}, { errors: [{ code: 131_052, title: 'Media download error' }] });

    expect(await handle(body)).toEqual({ outcome: 'handled' });

    expect(route.mock.calls[0]?.[3]).toEqual({ fileRefusal: 'unreadable' });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('drops a customer id the contact layer refuses instead of failing the batch', async () => {
    const { handle, route, log } = harness();
    route.mockRejectedValue(new ContactFailure('identity-invalid', 'invalid-meta'));

    expect(await handle(whatsappText())).toEqual({
      outcome: 'ignored',
      reason: 'invalid-customer-id',
    });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('does not swallow a failure that is not the contact layer’s', async () => {
    const { handle, route } = harness();
    route.mockRejectedValue(new TypeError('a bug'));

    await expect(handle(whatsappText())).rejects.toThrow('a bug');
  });
});

describe('a status report', () => {
  it('is ignored for “sent”, which the send job recorded when Meta accepted the message', async () => {
    const { handle, repository } = harness();

    expect(await handle(whatsappStatus({ status: 'sent' }))).toEqual({
      outcome: 'ignored',
      reason: 'status-sent',
    });
    expect(repository.advanceStatus).not.toHaveBeenCalled();
  });

  it.each(['delivered', 'read'] as const)('moves a reply to %s', async (status) => {
    const { handle, repository } = harness();

    expect(await handle(whatsappStatus({ status }))).toEqual({ outcome: 'handled' });

    expect(repository.advanceStatus).toHaveBeenCalledWith(
      expect.anything(),
      fixtureWamid(1),
      status,
      expect.any(Date),
    );
  });

  it('records what Meta billed the message as', async () => {
    const { handle, repository } = harness();

    await handle(whatsappStatus({ status: 'delivered', category: 'utility' }));

    expect(repository.recordPricing).toHaveBeenCalledWith(
      expect.anything(),
      fixtureWamid(1),
      'utility',
    );
  });

  it('counts a report for a message Helpdock did not send', async () => {
    const { handle, repository } = harness();
    repository.advanceStatus.mockResolvedValue(undefined);

    expect(await handle(whatsappStatus({ status: 'read' }))).toEqual({
      outcome: 'ignored',
      reason: 'no-delivery-to-advance',
    });
  });

  it('dates a report by Meta’s clock, and never from the future', async () => {
    const { handle, repository } = harness();

    await handle(whatsappStatus({ status: 'delivered', timestamp: NOW.getTime() / 1_000 + 3_600 }));

    expect(repository.advanceStatus.mock.calls[0]?.[3]).toEqual(NOW);
  });

  it('fails the delivery with Meta’s words when the message could not be delivered', async () => {
    const { handle, repository } = harness();

    expect(await handle(whatsappStatus({ status: 'failed', errorCode: 131_026 }))).toEqual({
      outcome: 'handled',
    });

    expect(repository.failByReport).toHaveBeenCalledWith(expect.anything(), fixtureWamid(1), {
      status: 'failed',
      error: '131026: Message undeliverable',
      errorCode: '131026',
      at: expect.any(Date),
    });
  });

  it('refuses, rather than fails, a delivery whose 24 hours had run out when Meta tried', async () => {
    const { handle, repository } = harness();

    await handle(
      whatsappStatus({ status: 'failed', errorCode: 131_047, errorTitle: 'Re-engagement message' }),
    );

    expect(repository.failByReport.mock.calls[0]?.[2]).toMatchObject({
      status: 'refused',
      errorCode: '131047',
    });
  });

  it('counts a failure report for a message Helpdock did not send', async () => {
    const { handle, repository } = harness();
    repository.failByReport.mockResolvedValue(undefined);

    expect(await handle(whatsappStatus({ status: 'failed' }))).toEqual({
      outcome: 'ignored',
      reason: 'no-delivery-to-fail',
    });
  });
});

describe('a changed number', () => {
  const changed = () => whatsappUserChangedNumber({ userId: META_FIXTURE.userId });

  it('is ignored for a customer the account has no conversation with', async () => {
    const { handle } = harness();

    expect(await handle(changed())).toEqual({ outcome: 'ignored', reason: 'unknown-conversation' });
    expect(attachVerifiedIdentity).not.toHaveBeenCalled();
  });

  it('makes the new number the contact’s verified phone, takes the old one off, and says so on the ticket', async () => {
    const { handle, repository, lines } = harness();
    repository.conversation.mockResolvedValue(conversation());

    expect(await handle(changed())).toEqual({ outcome: 'handled' });

    expect(attachVerifiedIdentity).toHaveBeenCalledWith(expect.anything(), BRAND, CONTACT, {
      kind: 'phone',
      value: '+16505559876',
      source: 'whatsapp.cloud',
    });
    expect(removeIdentity).toHaveBeenCalledWith(expect.anything(), BRAND, CONTACT, {
      kind: 'phone',
      value: `+${META_FIXTURE.waId}`,
    });
    expect(repository.upsertConversation.mock.calls[0]?.[1]).toMatchObject({
      waId: '16505559876',
      inbound: null,
    });
    expect(lines.map((line) => line.text)).toEqual([
      `The customer's WhatsApp number changed from +${META_FIXTURE.waId} to +16505559876.`,
    ]);
  });

  it('tells the same change once however often Meta delivers it, without the customer in the key', async () => {
    const { handle, repository, lines } = harness();
    repository.conversation.mockResolvedValue(conversation());

    expect(await handle(changed())).toEqual({ outcome: 'handled' });
    expect(await handle(changed())).toEqual({ outcome: 'duplicate' });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.externalMessageId).toBe(
      `number:${CONVERSATION}:${String(META_FIXTURE.time * 1_000)}`,
    );
    expect(lines[0]?.externalMessageId).not.toContain(META_FIXTURE.userId);
  });

  it('moves the number even where there is no open ticket to say so', async () => {
    const { handle, repository, openTicket, lines } = harness();
    repository.conversation.mockResolvedValue(conversation());
    openTicket.mockResolvedValue(undefined);

    expect(await handle(changed())).toEqual({ outcome: 'handled' });

    expect(attachVerifiedIdentity).toHaveBeenCalledOnce();
    expect(lines).toEqual([]);
  });

  it('is ignored, and warned about, when the new number is not a phone number', async () => {
    const { handle, repository, log } = harness();
    repository.conversation.mockResolvedValue(conversation());
    vi.mocked(attachVerifiedIdentity).mockRejectedValueOnce(
      new ContactFailure('identity-invalid', 'invalid-meta'),
    );

    expect(await handle(changed())).toEqual({ outcome: 'ignored', reason: 'invalid-number' });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(repository.upsertConversation).not.toHaveBeenCalled();
  });

  it('does not swallow a failure that is not the contact layer’s', async () => {
    const { handle, repository } = harness();
    repository.conversation.mockResolvedValue(conversation());
    vi.mocked(attachVerifiedIdentity).mockRejectedValueOnce(new TypeError('a bug'));

    await expect(handle(changed())).rejects.toThrow('a bug');
  });
});

describe('something Helpdock cannot show', () => {
  it('moves the window to the message and writes a line keyed by it on the open ticket', async () => {
    const { handle, repository, lines } = harness();
    repository.conversation.mockResolvedValue(conversation());

    expect(await handle(whatsappUnsupported())).toEqual({ outcome: 'handled' });

    expect(repository.upsertConversation.mock.calls[0]?.[1]).toMatchObject({
      customerId: META_FIXTURE.userId,
      inbound: { at: new Date(META_FIXTURE.time * 1_000), messageId: fixtureWamid(1) },
    });
    expect(lines).toEqual([
      {
        ticket: TICKET,
        accountId: ACCOUNT_ID,
        text: 'The customer sent something that cannot be shown here.',
        externalMessageId: `unsupported:${fixtureWamid(1)}`,
      },
    ]);
  });

  it('is a duplicate when its line is already there, and moves nothing', async () => {
    const { handle, repository } = harness();
    repository.conversation.mockResolvedValue(conversation());

    await handle(whatsappUnsupported());
    repository.upsertConversation.mockClear();

    expect(await handle(whatsappUnsupported())).toEqual({ outcome: 'duplicate' });
    expect(repository.upsertConversation).not.toHaveBeenCalled();
  });

  it('is counted for a first message, which has no conversation to note it on', async () => {
    const { handle, repository, log } = harness();

    expect(await handle(whatsappUnsupported())).toEqual({
      outcome: 'ignored',
      reason: 'no-conversation',
    });
    expect(repository.upsertConversation).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('is counted where the ticket is closed or spam', async () => {
    const { handle, repository, openTicket } = harness();
    repository.conversation.mockResolvedValue(conversation());
    openTicket.mockResolvedValue(undefined);

    expect(await handle(whatsappUnsupported())).toEqual({
      outcome: 'ignored',
      reason: 'no-open-ticket',
    });
  });
});

describe('a reaction', () => {
  const known = (messages: Map<string, { id: string; ticketId: string; bodyText: string }>) =>
    messages.set('wamid.reply', { id: 'msg-1', ticketId: TICKET.id, bodyText: 'We are on it.' });

  it('is a line on the ticket of the message reacted to, once however often it arrives', async () => {
    const { handle, lines, messages } = harness();
    known(messages);
    const reaction = whatsappReaction({ reactsTo: 'wamid.reply', emoji: '❤️' });

    expect(await handle(reaction)).toEqual({ outcome: 'handled' });
    expect(await handle(reaction)).toEqual({ outcome: 'duplicate' });

    expect(lines).toEqual([
      {
        ticket: TICKET,
        accountId: ACCOUNT_ID,
        text: 'The customer reacted ❤️ to a message.',
        // The key names the message, the way and the time, and not the customer.
        externalMessageId: `reaction:wamid.reply:react:${String(META_FIXTURE.time * 1_000)}`,
      },
    ]);
  });

  it('says a reaction was taken back when Meta sends no emoji', async () => {
    const { handle, lines, messages } = harness();
    known(messages);

    await handle(whatsappReaction({ reactsTo: 'wamid.reply', emoji: '' }));

    expect(lines.map((line) => line.text)).toEqual([
      'The customer removed their reaction to a message.',
    ]);
  });

  it('is dropped for a message Helpdock never filed or sent', async () => {
    const { handle, lines } = harness();

    expect(await handle(whatsappReaction())).toEqual({
      outcome: 'ignored',
      reason: 'unknown-message',
    });
    expect(lines).toEqual([]);
  });

  it('is dropped when the ticket is closed or spam, as the router says', async () => {
    const { handle, messages, openTicket } = harness();
    known(messages);
    openTicket.mockResolvedValue(undefined);

    expect(await handle(whatsappReaction({ reactsTo: 'wamid.reply' }))).toEqual({
      outcome: 'ignored',
      reason: 'no-open-ticket',
    });
  });
});

describe('an error about the account', () => {
  it('goes on the account, in Meta’s words, and in the log', async () => {
    const { handle, repository, log } = harness();
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: META_FIXTURE.wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: META_FIXTURE.displayPhone,
                  phone_number_id: META_FIXTURE.phoneNumberId,
                },
                errors: [{ code: 131_031, title: 'Account has been locked' }],
              },
            },
          ],
        },
      ],
    };

    expect(await handle(body)).toEqual({ outcome: 'handled' });

    expect(repository.markError).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      '131031: Account has been locked',
      NOW,
    );
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe('what a WhatsApp number does not receive', () => {
  it('drops, and warns about, a Messenger watermark', async () => {
    const { handle, log } = harness();
    const delivery: MetaWebhookBody = {
      object: 'page',
      entry: [
        {
          id: META_FIXTURE.pageId,
          time: 1,
          messaging: [{ sender: { id: META_FIXTURE.psid }, delivery: { watermark: 1, mids: [] } }],
        },
      ],
    };

    expect(await handle(delivery)).toEqual({ outcome: 'ignored', reason: 'wrong-platform' });
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
