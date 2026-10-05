import type { WebhookDeliveryRow } from '@helpdock/db';
import { WEBHOOK_SIGNATURE_HEADER } from '@helpdock/schemas';
import { signWebhook } from './webhook-signature.js';

/**
 * The request one delivery attempt sends (M8-03), built in one place so the
 * worker's POST and the delivery log's "Request headers" cannot drift apart.
 *
 * The signature's timestamp is the attempt's own (`last_attempt_at`, which the
 * worker records from the same clock reading), so the log shows the header the
 * receiver actually got.
 */

export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const webhookRequestBody = (delivery: Pick<WebhookDeliveryRow, 'payload'>): string =>
  JSON.stringify(delivery.payload);

export const webhookRequest = (
  delivery: Pick<WebhookDeliveryRow, 'id' | 'event' | 'eventId' | 'payload'>,
  secret: string,
  sentAt: Date,
): WebhookRequest => {
  const body = webhookRequestBody(delivery);
  return {
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Helpdock-Webhooks/1',
      'x-helpdock-event': delivery.event,
      'x-helpdock-event-id': delivery.eventId,
      'x-helpdock-delivery': delivery.id,
      [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, Math.floor(sentAt.getTime() / 1000), body),
    },
    body,
  };
};
