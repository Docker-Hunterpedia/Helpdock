import {
  enqueueOutbox,
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
  type WebhookDeliverPayload,
} from '@helpdock/jobs';
import { HC_ARTICLE_CHANGED_EVENT, type WebhookEvent } from '@helpdock/schemas';
import { z } from 'zod';
import { CONTACT_CREATED_EVENT } from '../contacts/contact-events.js';
import { CSAT_EVENTS } from '../csat/csat-events.js';
import { TICKET_EVENTS } from '../tickets/ticket-events.js';
import { webhookDataFor } from './webhook-payload.js';
import type { WebhooksRepository } from './webhooks.repository.js';

/**
 * How a domain event becomes deliveries (M8-03), the long way round DOMAIN-RULES
 * §6 requires:
 *
 * ```
 * request  →  domain rows + outbox(ticket.created)               (one transaction)
 * worker   →  this subscriber → webhook_deliveries
 *                              + outbox(webhook.delivery_requested)  (one transaction)
 * worker   →  that event's handler → BullMQ webhook.deliver          (after it committed)
 * worker   →  webhook.deliver → the endpoint, through @helpdock/net
 * ```
 *
 * The second hop exists so the job is added only once its delivery row has
 * committed — a job added from inside the transaction that writes the row could
 * run before the row exists — exactly as `email.send` is fed.
 */

/** What the webhooks module subscribes as, beside each event's own handler. */
export const WEBHOOKS_SUBSCRIBER = 'webhooks';

export const WEBHOOK_DELIVERY_REQUESTED_EVENT = 'webhook.delivery_requested';

const deliveryRequestedSchema = z.object({ deliveryId: z.uuid() });

/**
 * Which webhook event a domain event is, if any. A reopen is an update to a
 * receiver; `ticket.closed` keeps its own name because "it was resolved" is
 * what most integrations wait for. Spam and notes are not sent at all.
 */
export const webhookEventFor = (
  event: string,
  payload: Record<string, unknown>,
): WebhookEvent | undefined => {
  switch (event) {
    case TICKET_EVENTS.created:
      return 'ticket.created';
    case TICKET_EVENTS.updated:
    case TICKET_EVENTS.reopened:
      return 'ticket.updated';
    case TICKET_EVENTS.replied:
      return payload.kind === 'note' ? undefined : 'ticket.replied';
    case TICKET_EVENTS.closed:
      return 'ticket.closed';
    case CONTACT_CREATED_EVENT:
      return 'contact.created';
    case CSAT_EVENTS.received:
      return 'csat.received';
    case HC_ARTICLE_CHANGED_EVENT:
      return payload.change === 'published' ? 'article.published' : undefined;
    default:
      return undefined;
  }
};

/** The domain events the subscriber listens to. */
export const WEBHOOK_SOURCE_EVENTS = [
  TICKET_EVENTS.created,
  TICKET_EVENTS.updated,
  TICKET_EVENTS.reopened,
  TICKET_EVENTS.replied,
  TICKET_EVENTS.closed,
  CONTACT_CREATED_EVENT,
  CSAT_EVENTS.received,
  HC_ARTICLE_CHANGED_EVENT,
] as const;

/**
 * One delivery per switched-on endpoint that asked for the event, each with
 * the body it will send. The outbox row's id is the event's id, so a
 * redelivered event finds its deliveries and adds none.
 */
export const createWebhookSourceHandler =
  (repository: WebhooksRepository, now: () => Date = () => new Date()): OutboxEventHandler =>
  async ({ brandId, outboxId, event, payload, tx, log }) => {
    const webhookEvent = webhookEventFor(event, payload);
    if (webhookEvent === undefined) {
      return;
    }
    const endpoints = await repository.subscribedTo(tx, webhookEvent);
    if (endpoints.length === 0) {
      return;
    }
    const data = await webhookDataFor(tx, webhookEvent, payload);
    if (data === undefined) {
      return;
    }

    const envelope = {
      id: outboxId,
      event: webhookEvent,
      createdAt: now().toISOString(),
      brandId,
      data,
    };
    for (const endpoint of endpoints) {
      const delivery = await repository.insertDelivery(tx, {
        brandId,
        webhookId: endpoint.id,
        eventId: outboxId,
        event: webhookEvent,
        payload: envelope,
      });
      if (delivery !== undefined) {
        await enqueueOutbox(tx, {
          brandId,
          event: WEBHOOK_DELIVERY_REQUESTED_EVENT,
          payload: { deliveryId: delivery.id },
        });
      }
    }
    log.info(
      { brandId, event: webhookEvent, eventId: outboxId, endpoints: endpoints.length },
      'webhook deliveries created',
    );
  };

/** Adds `webhook.deliver` jobs. The worker passes BullMQ; a test passes a double. */
export interface WebhookDeliverQueue {
  add(payload: WebhookDeliverPayload, jobId: string): Promise<void>;
}

/** The BullMQ job id of one delivery. Dots, because BullMQ refuses colons. */
export const webhookDeliverJobId = (deliveryId: string): string => `webhook.deliver.${deliveryId}`;

export const createDeliveryRequestedHandler =
  (queue: WebhookDeliverQueue): OutboxEventHandler =>
  async ({ brandId, payload }) => {
    const { deliveryId } = deliveryRequestedSchema.parse(payload);
    await queue.add({ brandId, deliveryId }, webhookDeliverJobId(deliveryId));
  };

/**
 * Called by the worker's start-up, before any consumer exists. The webhooks
 * module is a named subscriber on the domain events, whose owners keep their
 * default slots, and owns `webhook.delivery_requested` outright.
 */
export const registerWebhookEventHandlers = (
  {
    repository,
    queue,
  }: { readonly repository: WebhooksRepository; readonly queue: WebhookDeliverQueue },
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  const source = createWebhookSourceHandler(repository);
  for (const event of WEBHOOK_SOURCE_EVENTS) {
    dispatcher.register(event, source, WEBHOOKS_SUBSCRIBER);
  }
  dispatcher.register(WEBHOOK_DELIVERY_REQUESTED_EVENT, createDeliveryRequestedHandler(queue));
};
