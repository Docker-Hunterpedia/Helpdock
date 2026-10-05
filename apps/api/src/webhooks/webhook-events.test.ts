import type { DbTransaction, WebhookRow } from '@helpdock/db';
import { createOutboxDispatcher, type OutboxEventContext, silentLogger } from '@helpdock/jobs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeliveryRequestedHandler,
  createWebhookSourceHandler,
  registerWebhookEventHandlers,
  WEBHOOK_DELIVERY_REQUESTED_EVENT,
  WEBHOOK_SOURCE_EVENTS,
  webhookEventFor,
} from './webhook-events.js';
import type { WebhooksRepository } from './webhooks.repository.js';

const enqueueOutbox = vi.hoisted(() => vi.fn(async (_tx: unknown, _entry: unknown) => 'outbox-id'));
vi.mock('@helpdock/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@helpdock/jobs')>()),
  enqueueOutbox,
}));
const webhookDataFor = vi.hoisted(() => vi.fn());
vi.mock('./webhook-payload.js', () => ({ webhookDataFor }));

const BRAND = '0192a000-0000-7000-8000-0000000000b1';
const OUTBOX = '0192a000-0000-7000-8000-0000000000a1';
const TICKET = '0192a000-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-05T10:00:00Z');
const tx = {} as DbTransaction;

const endpoint = (id: string) => ({ id }) as WebhookRow;

const context = (event: string, payload: Record<string, unknown>): OutboxEventContext => ({
  outboxId: OUTBOX,
  brandId: BRAND,
  event,
  payload,
  tx,
  log: silentLogger,
});

describe('webhookEventFor', () => {
  it.each([
    ['ticket.created', {}, 'ticket.created'],
    ['ticket.updated', {}, 'ticket.updated'],
    ['ticket.reopened', {}, 'ticket.updated'],
    ['ticket.replied', { kind: 'public' }, 'ticket.replied'],
    ['ticket.replied', { kind: 'note' }, undefined],
    ['ticket.closed', {}, 'ticket.closed'],
    ['ticket.spam', {}, undefined],
    ['contact.created', {}, 'contact.created'],
    ['csat.received', {}, 'csat.received'],
    ['help_center.article_changed', { change: 'published' }, 'article.published'],
    ['help_center.article_changed', { change: 'archived' }, undefined],
  ])('%s %j is %s', (event, payload, expected) => {
    expect(webhookEventFor(event, payload)).toBe(expected);
  });
});

describe('the webhooks subscriber', () => {
  const insertDelivery = vi.fn();
  const subscribedTo = vi.fn();
  const repository = { insertDelivery, subscribedTo } as unknown as WebhooksRepository;
  const handle = createWebhookSourceHandler(repository, () => NOW);

  beforeEach(() => {
    vi.clearAllMocks();
    webhookDataFor.mockResolvedValue({ ticket: { id: TICKET } });
  });

  it('creates one delivery per subscribed endpoint, keyed by the outbox row, and asks for each', async () => {
    subscribedTo.mockResolvedValue([endpoint('w1'), endpoint('w2')]);
    insertDelivery.mockImplementation(async (_tx, values) => ({ id: `d-${values.webhookId}` }));

    await handle(context('ticket.created', { ticketId: TICKET }));

    expect(subscribedTo).toHaveBeenCalledWith(tx, 'ticket.created');
    expect(insertDelivery).toHaveBeenCalledWith(tx, {
      brandId: BRAND,
      webhookId: 'w1',
      eventId: OUTBOX,
      event: 'ticket.created',
      payload: {
        id: OUTBOX,
        event: 'ticket.created',
        createdAt: NOW.toISOString(),
        brandId: BRAND,
        data: { ticket: { id: TICKET } },
      },
    });
    expect(enqueueOutbox.mock.calls.map(([, entry]) => entry)).toEqual([
      { brandId: BRAND, event: WEBHOOK_DELIVERY_REQUESTED_EVENT, payload: { deliveryId: 'd-w1' } },
      { brandId: BRAND, event: WEBHOOK_DELIVERY_REQUESTED_EVENT, payload: { deliveryId: 'd-w2' } },
    ]);
  });

  it('asks for nothing again when a redelivered event finds its deliveries made', async () => {
    subscribedTo.mockResolvedValue([endpoint('w1')]);
    insertDelivery.mockResolvedValue(undefined);

    await handle(context('ticket.created', { ticketId: TICKET }));

    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it('reads nothing when no endpoint asked for the event', async () => {
    subscribedTo.mockResolvedValue([]);

    await handle(context('ticket.closed', { ticketId: TICKET }));

    expect(webhookDataFor).not.toHaveBeenCalled();
    expect(insertDelivery).not.toHaveBeenCalled();
  });

  it('sends nothing when the thing the event was about is gone', async () => {
    subscribedTo.mockResolvedValue([endpoint('w1')]);
    webhookDataFor.mockResolvedValue(undefined);

    await handle(context('ticket.updated', { ticketId: TICKET }));

    expect(insertDelivery).not.toHaveBeenCalled();
  });

  it('ignores a domain event that is no webhook event', async () => {
    await handle(context('ticket.note_added', { ticketId: TICKET }));

    expect(subscribedTo).not.toHaveBeenCalled();
  });
});

describe('webhook.delivery_requested', () => {
  it('adds the webhook.deliver job under the delivery id', async () => {
    const add = vi.fn(async () => undefined);

    await createDeliveryRequestedHandler({ add })(
      context(WEBHOOK_DELIVERY_REQUESTED_EVENT, { deliveryId: OUTBOX }),
    );

    expect(add).toHaveBeenCalledWith(
      { brandId: BRAND, deliveryId: OUTBOX },
      `webhook.deliver.${OUTBOX}`,
    );
  });
});

describe('registerWebhookEventHandlers', () => {
  it('subscribes as webhooks beside each event owner, and owns delivery_requested', () => {
    const dispatcher = createOutboxDispatcher();

    registerWebhookEventHandlers(
      { repository: {} as WebhooksRepository, queue: { add: vi.fn() } },
      dispatcher,
    );

    expect(dispatcher.events).toEqual(
      expect.arrayContaining([...WEBHOOK_SOURCE_EVENTS, WEBHOOK_DELIVERY_REQUESTED_EVENT]),
    );
  });
});
