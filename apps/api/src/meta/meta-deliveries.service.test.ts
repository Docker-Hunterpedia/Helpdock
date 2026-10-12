import {
  attachments,
  type DbTransaction,
  type MetaAccount,
  type MetaConversation,
  type MetaDelivery,
  ticketMessages,
  tickets,
} from '@helpdock/db';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { MetaRepository } from './meta.repository.js';
import { MetaDeliveriesService } from './meta-deliveries.service.js';
import { MetaFailure } from './meta-failure.js';
import { conversationWindow } from './meta-window.js';
import type { OutboundMetaService } from './outbound-meta.service.js';

/**
 * The ticket view's Meta half against doubles: what the thread says about a
 * delivery, what Retry refuses and what it queues, and when the ticket has
 * nothing Meta to draw. The same service against a database, behind its routes
 * and the department scope, is `meta-replies.integration.test.ts`.
 */

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const TICKET = '01937f5e-7e53-7000-8000-00000000000b';
const ACCOUNT = '01937f5e-7e53-7000-8000-000000000010';
const NOW = new Date('2026-10-11T10:00:00.000Z');
const HOUR = 60 * 60 * 1_000;

interface Rows {
  readonly tickets?: readonly Record<string, unknown>[];
  readonly messages?: readonly Record<string, unknown>[];
  readonly files?: readonly Record<string, unknown>[];
}

/** The part of a Drizzle transaction the service reads: each query answers the rows of its table. */
const fakeTx = (rows: Rows): DbTransaction => {
  const byTable = new Map<unknown, readonly Record<string, unknown>[]>([
    [tickets, rows.tickets ?? []],
    [ticketMessages, rows.messages ?? []],
    [attachments, rows.files ?? []],
  ]);
  return {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => chain,
          // biome-ignore lint/suspicious/noThenProperty: Drizzle's builders are awaitable; the double must be too.
          then: (resolve: (value: readonly Record<string, unknown>[]) => unknown) =>
            resolve(byTable.get(table) ?? []),
        };
        return chain;
      },
    }),
  } as unknown as DbTransaction;
};

const ticketRow = (channel = 'messenger') => ({
  id: TICKET,
  contactId: 'contact-1',
  departmentId: 'department-1',
  channel,
});

const delivery = (overrides: Partial<MetaDelivery> = {}): MetaDelivery =>
  ({
    id: 'delivery-1',
    ticketId: TICKET,
    ticketMessageId: 'message-1',
    accountId: ACCOUNT,
    customerId: 'customer-1',
    status: 'failed',
    partsSent: 0,
    attempts: 2,
    lastError: '1: Meta is down',
    errorCode: '1',
    tag: null,
    templateName: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    failedAt: NOW,
    ...overrides,
  }) as MetaDelivery;

const account = (overrides: Partial<MetaAccount> = {}): MetaAccount =>
  ({
    id: ACCOUNT,
    platform: 'messenger',
    externalId: '112233445566778',
    displayName: 'Helpdock',
    username: null,
    displayPhone: null,
    humanAgentEnabled: false,
    ...overrides,
  }) as MetaAccount;

const conversation = (overrides: Partial<MetaConversation> = {}): MetaConversation =>
  ({
    customerId: 'customer-1',
    waId: null,
    profileName: null,
    username: null,
    lastInboundAt: new Date(NOW.getTime() - 30 * HOUR),
    ...overrides,
  }) as MetaConversation;

const build = (
  setup: {
    readonly delivery?: MetaDelivery | undefined;
    readonly deliveries?: readonly MetaDelivery[];
    readonly account?: MetaAccount | undefined;
    readonly accounts?: readonly MetaAccount[];
    readonly conversation?: MetaConversation | undefined;
    readonly target?: unknown;
  } = {},
) => {
  const accounts = new Map(
    [...(setup.accounts ?? []), ...(setup.account === undefined ? [] : [setup.account])].map(
      (row) => [row.id, row],
    ),
  );
  const repository = {
    delivery: vi.fn(async () => setup.delivery),
    deliveriesForTicket: vi.fn(async () => setup.deliveries ?? []),
    account: vi.fn(async (_tx: unknown, id: string) => accounts.get(id)),
    conversation: vi.fn(async () => setup.conversation),
  };
  const outbound = {
    targetFor: vi.fn(async () => setup.target),
    retry: vi.fn(async () => undefined),
  };
  const service = new MetaDeliveriesService(
    repository as unknown as MetaRepository,
    outbound as unknown as OutboundMetaService,
    () => NOW,
  );

  return { service, repository, outbound };
};

describe('list', () => {
  it('is not found for a ticket the reader cannot see, or that was deleted', async () => {
    const { service } = build();

    await expect(service.list(fakeTx({ tickets: [] }), TICKET)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers nothing for a ticket with no deliveries, without reading the thread', async () => {
    const { service, repository } = build();

    await expect(service.list(fakeTx({ tickets: [ticketRow()] }), TICKET)).resolves.toEqual({
      items: [],
    });
    expect(repository.account).not.toHaveBeenCalled();
  });

  it('counts a reply’s parts from its text on the account’s platform', async () => {
    const { service } = build({
      deliveries: [delivery({ status: 'sent', partsSent: 1 })],
      account: account({ platform: 'messenger' }),
    });
    const tx = fakeTx({
      tickets: [ticketRow()],
      messages: [{ id: 'message-1', bodyText: 'x'.repeat(2_500) }],
    });

    const { items } = await service.list(tx, TICKET);

    // Messenger takes 2000 characters in a message, so the reply is two.
    expect(items).toEqual([
      expect.objectContaining({
        id: 'delivery-1',
        status: 'sent',
        partsSent: 1,
        partsTotal: 2,
        leftOut: [],
        failedAt: NOW.toISOString(),
        sentAt: null,
      }),
    ]);
  });

  it('asks once for each account the deliveries are through, and takes WhatsApp for one that is gone', async () => {
    const { service, repository } = build({
      deliveries: [
        delivery({ id: 'delivery-1', ticketMessageId: 'message-1' }),
        delivery({ id: 'delivery-2', ticketMessageId: 'message-2' }),
        delivery({ id: 'delivery-3', ticketMessageId: 'message-3', accountId: 'deleted' }),
      ],
      account: account(),
    });
    const tx = fakeTx({
      tickets: [ticketRow()],
      messages: [
        { id: 'message-1', bodyText: 'one' },
        { id: 'message-2', bodyText: 'two' },
        { id: 'message-3', bodyText: 'three' },
      ],
    });

    const { items } = await service.list(tx, TICKET);

    expect(items.map((item) => item.partsTotal)).toEqual([1, 1, 1]);
    expect(repository.account).toHaveBeenCalledTimes(2);
  });
});

describe('ticketContext', () => {
  it('draws nothing Meta for a ticket that is not on a Meta channel, and asks nobody', async () => {
    const { service, outbound } = build();

    const result = await service.ticketContext(fakeTx({ tickets: [ticketRow('email')] }), TICKET);

    expect(result).toEqual({ context: null, deliveries: [], unsent: [] });
    expect(outbound.targetFor).not.toHaveBeenCalled();
  });

  it('draws nothing Meta for a Meta ticket whose conversation is gone', async () => {
    const { service, outbound } = build({ target: undefined });

    const result = await service.ticketContext(fakeTx({ tickets: [ticketRow()] }), TICKET);

    expect(result.context).toBeNull();
    expect(outbound.targetFor).toHaveBeenCalledWith(expect.anything(), ticketRow(), true);
  });

  it('says who the thread is with, through which account, and where the window stands', async () => {
    const wa = account({
      platform: 'whatsapp',
      externalId: '106540352242922',
      displayPhone: '+1 555 0142',
    });
    const talking = conversation({
      waId: '15550100',
      profileName: 'Sheena Nelson',
      lastInboundAt: new Date(NOW.getTime() - HOUR),
    });
    const window = conversationWindow({
      conversation: talking,
      account: wa,
      personAuthored: true,
      now: NOW,
    });
    const { service } = build({
      target: { account: wa, conversation: talking, window },
    });

    const { context } = await service.ticketContext(
      fakeTx({ tickets: [ticketRow('whatsapp')] }),
      TICKET,
    );

    expect(context).toMatchObject({
      account: {
        id: ACCOUNT,
        platform: 'whatsapp',
        displayName: 'Helpdock',
        displayPhone: '+1 555 0142',
      },
      customerId: 'customer-1',
      phone: '+15550100',
      phoneVerified: true,
      profileName: 'Sheena Nelson',
      window: { state: 'open' },
    });
    expect(context?.account).not.toHaveProperty('username');
  });
});

describe('retry', () => {
  const retry = (service: MetaDeliveriesService, rows: Rows = { tickets: [ticketRow()] }) =>
    service.retry(fakeTx(rows), BRAND, TICKET, 'delivery-1');

  it('is not found for a ticket the reader cannot see', async () => {
    const { service, outbound } = build({ delivery: delivery() });

    await expect(retry(service, { tickets: [] })).rejects.toBeInstanceOf(NotFoundException);
    expect(outbound.retry).not.toHaveBeenCalled();
  });

  it.each([
    ['one that is not there', undefined],
    ['one of another ticket', delivery({ ticketId: 'another-ticket' })],
  ])('is not found for %s', async (_what, row) => {
    const { service, outbound } = build({ delivery: row });

    await expect(retry(service)).rejects.toBeInstanceOf(NotFoundException);
    expect(outbound.retry).not.toHaveBeenCalled();
  });

  it('puts a failed reply back in the queue', async () => {
    const { service, outbound } = build({ delivery: delivery({ status: 'failed' }) });

    await retry(service);

    expect(outbound.retry).toHaveBeenCalledExactlyOnceWith(expect.anything(), BRAND, [
      'delivery-1',
    ]);
  });

  describe('a refused reply', () => {
    const refused = delivery({ status: 'refused', errorCode: '10/2018278' });
    const person = { messages: [{ authorType: 'staff' }] };

    it('is refused again with the window’s facts, because Retry cannot reopen a window', async () => {
      const { service, outbound } = build({
        delivery: refused,
        account: account({ platform: 'messenger' }),
        conversation: conversation({ lastInboundAt: new Date('2026-10-10T01:00:00.000Z') }),
      });

      const failure = await retry(service, { tickets: [ticketRow()], ...person }).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(MetaFailure);
      expect(failure).toMatchObject({
        reason: 'reply-window-closed',
        details: {
          platform: 'messenger',
          anchorAt: '2026-10-10T01:00:00.000Z',
          closedAt: '2026-10-11T01:00:00.000Z',
        },
      });
      expect(outbound.retry).not.toHaveBeenCalled();
    });

    it('is refused without facts when the customer has written since, which is a new reply to write', async () => {
      const { service } = build({
        delivery: refused,
        account: account(),
        conversation: conversation({ lastInboundAt: new Date(NOW.getTime() - HOUR) }),
      });

      const failure = await retry(service, { tickets: [ticketRow()], ...person }).catch(
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({ reason: 'reply-window-closed' });
      expect((failure as MetaFailure).details).toBeUndefined();
    });

    it.each([
      ['the conversation', { account: account(), conversation: undefined }],
      ['the account', { account: undefined, conversation: conversation() }],
    ])('is refused without facts when %s is gone', async (_what, setup) => {
      const { service } = build({ delivery: refused, ...setup });

      const failure = await retry(service, { tickets: [ticketRow()], ...person }).catch(
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({ reason: 'reply-window-closed' });
      expect((failure as MetaFailure).details).toBeUndefined();
    });

    it('is judged as the assistant’s reply, with no extended window, when no person wrote it', async () => {
      const { service } = build({
        delivery: refused,
        account: account({ platform: 'messenger', humanAgentEnabled: true }),
        // Three days on: closed for the assistant, open for a person with Human Agent on.
        conversation: conversation({ lastInboundAt: new Date(NOW.getTime() - 72 * HOUR) }),
      });

      const byAssistant = await retry(service, {
        tickets: [ticketRow()],
        messages: [{ authorType: 'ai' }],
      }).catch((error: unknown) => error);
      const byPerson = await retry(service, { tickets: [ticketRow()], ...person }).catch(
        (error: unknown) => error,
      );

      expect((byAssistant as MetaFailure).details).toMatchObject({ platform: 'messenger' });
      expect((byPerson as MetaFailure).details).toBeUndefined();
    });
  });
});
