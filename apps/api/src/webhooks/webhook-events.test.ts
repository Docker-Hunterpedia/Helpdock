import type { DbTransaction } from '@helpdock/db';
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

/**
 * The subscriber's decisions that need no database. What it writes once an
 * endpoint has asked for an event — the delivery row with the ticket inside
 * it, and the `webhook.delivery_requested` row behind it — is proved against
 * real Postgres in `webhook-events.integration.test.ts`.
 */

const BRAND = '0192a000-0000-7000-8000-0000000000b1';
const OUTBOX = '0192a000-0000-7000-8000-0000000000a1';
const TICKET = '0192a000-0000-7000-8000-0000000000c1';
const tx = {} as DbTransaction;

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
  const handle = createWebhookSourceHandler(repository);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads nothing when no endpoint asked for the event', async () => {
    subscribedTo.mockResolvedValue([]);

    await handle(context('ticket.closed', { ticketId: TICKET }));

    expect(subscribedTo).toHaveBeenCalledWith(tx, 'ticket.closed');
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
