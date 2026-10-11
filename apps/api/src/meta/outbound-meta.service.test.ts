import type {
  DbTransaction,
  MetaAccount,
  MetaConversation,
  MetaDelivery,
  NewMetaDelivery,
} from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaRepository } from './meta.repository.js';
import { enqueueMetaReply } from './meta-events.js';
import { OutboundMetaService, WINDOW_CLOSED_NOTE } from './outbound-meta.service.js';

vi.mock('./meta-events.js', () => ({ enqueueMetaReply: vi.fn(async () => 'outbox-1') }));

const tx = {} as DbTransaction;
const HOUR = 3_600_000;
const customerWrote = new Date('2026-10-10T08:00:00.000Z');
const at = (hours: number): Date => new Date(customerWrote.getTime() + hours * HOUR);

const ticket = { id: 'ticket-1', contactId: 'contact-1', departmentId: 'department-1' };

const account = (overrides: Partial<MetaAccount> = {}): MetaAccount =>
  ({
    id: 'account-1',
    platform: 'whatsapp',
    humanAgentEnabled: false,
    ...overrides,
  }) as MetaAccount;

const conversation = (overrides: Partial<MetaConversation> = {}): MetaConversation =>
  ({
    id: 'conversation-1',
    accountId: 'account-1',
    customerId: '16505551234',
    lastInboundAt: customerWrote,
    ...overrides,
  }) as MetaConversation;

const setup = (
  found: { account?: MetaAccount; conversation?: MetaConversation | null; existing?: boolean } = {},
  now = at(1),
) => {
  const inserted: NewMetaDelivery[] = [];
  const requeued: string[][] = [];
  const repository = {
    conversationForTicket: async () =>
      found.conversation === null ? undefined : (found.conversation ?? conversation()),
    account: async () => found.account ?? account(),
    insertDelivery: async (_tx: DbTransaction, values: NewMetaDelivery) => {
      inserted.push(values);
      return found.existing === true
        ? undefined
        : ({ id: 'delivery-1', ...values } as MetaDelivery);
    },
    requeue: async (_tx: DbTransaction, ids: readonly string[]) => {
      requeued.push([...ids]);
      return ids.map((id) => ({ id }) as MetaDelivery);
    },
  } as unknown as MetaRepository;

  return { inserted, requeued, service: new OutboundMetaService(repository, () => now) };
};

const reply = { brandId: 'brand-1', ticket, messageId: 'message-1' };

beforeEach(() => {
  vi.mocked(enqueueMetaReply).mockClear();
});

describe('OutboundMetaService.queueReply', () => {
  it('writes a queued delivery to the conversation’s customer and one outbox row', async () => {
    const { inserted, service } = setup();

    const delivery = await service.queueReply(tx, { ...reply, personAuthored: true });

    expect(inserted).toEqual([
      {
        brandId: 'brand-1',
        departmentId: 'department-1',
        ticketId: 'ticket-1',
        ticketMessageId: 'message-1',
        accountId: 'account-1',
        conversationId: 'conversation-1',
        customerId: '16505551234',
      },
    ]);
    expect(delivery?.id).toBe('delivery-1');
    expect(enqueueMetaReply).toHaveBeenCalledExactlyOnceWith(tx, 'brand-1', 'delivery-1');
  });

  it('queues nothing for a ticket no conversation belongs to, and the reply stands', async () => {
    const { inserted, service } = setup({ conversation: null });

    expect(await service.queueReply(tx, { ...reply, personAuthored: true })).toBeUndefined();
    expect(inserted).toEqual([]);
    expect(enqueueMetaReply).not.toHaveBeenCalled();
  });

  it('queues a reply once, however often the same message is offered', async () => {
    const { service } = setup({ existing: true });

    expect(await service.queueReply(tx, { ...reply, personAuthored: true })).toBeUndefined();
    expect(enqueueMetaReply).not.toHaveBeenCalled();
  });

  it.each([
    ['whatsapp', '131047'],
    ['messenger', '10/2018278'],
    ['instagram', '10/2018278'],
  ] as const)(
    'writes a %s reply past the window as refused with the platform’s code, and no outbox row',
    async (platform, code) => {
      const { inserted, service } = setup({ account: account({ platform }) }, at(25));

      const delivery = await service.queueReply(tx, { ...reply, personAuthored: true });

      expect(inserted).toEqual([
        expect.objectContaining({
          status: 'refused',
          errorCode: code,
          lastError: WINDOW_CLOSED_NOTE,
          failedAt: at(25),
          ticketMessageId: 'message-1',
        }),
      ]);
      expect(delivery?.id).toBe('delivery-1');
      expect(enqueueMetaReply).not.toHaveBeenCalled();
    },
  );

  it('gives a person the seven days on Messenger with the switch on, and the assistant never', async () => {
    const humanAgent = { account: account({ platform: 'messenger', humanAgentEnabled: true }) };

    const person = setup(humanAgent, at(72));
    await person.service.queueReply(tx, { ...reply, personAuthored: true });
    expect(person.inserted[0]).not.toHaveProperty('status');
    expect(enqueueMetaReply).toHaveBeenCalledTimes(1);

    const assistant = setup(humanAgent, at(72));
    await assistant.service.queueReply(tx, { ...reply, personAuthored: false });
    expect(assistant.inserted[0]).toMatchObject({ status: 'refused' });
    expect(enqueueMetaReply).toHaveBeenCalledTimes(1);
  });

  it('refuses a reply to a customer who never wrote', async () => {
    const { inserted, service } = setup({ conversation: conversation({ lastInboundAt: null }) });

    await service.queueReply(tx, { ...reply, personAuthored: true });

    expect(inserted[0]).toMatchObject({ status: 'refused' });
    expect(enqueueMetaReply).not.toHaveBeenCalled();
  });
});

describe('OutboundMetaService.targetFor', () => {
  it('answers the conversation, its account and the window for the author', async () => {
    const { service } = setup({}, at(23));

    expect(await service.targetFor(tx, ticket, true)).toMatchObject({
      conversation: { id: 'conversation-1' },
      account: { id: 'account-1' },
      window: { state: 'open', closesAt: at(24) },
    });
  });

  it('answers undefined for a ticket with no conversation', async () => {
    const { service } = setup({ conversation: null });

    expect(await service.targetFor(tx, ticket, true)).toBeUndefined();
  });
});

describe('OutboundMetaService.retry', () => {
  it('puts each failed delivery back with an outbox row of its own', async () => {
    const { requeued, service } = setup();

    expect(await service.retry(tx, 'brand-1', ['d-1', 'd-2'])).toBe(2);

    expect(requeued).toEqual([['d-1', 'd-2']]);
    expect(vi.mocked(enqueueMetaReply).mock.calls.map((call) => call[2])).toEqual(['d-1', 'd-2']);
  });
});
