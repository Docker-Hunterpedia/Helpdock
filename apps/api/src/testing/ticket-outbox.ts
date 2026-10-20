import type { RealtimeBroadcast } from '../realtime/broadcast.js';
import { registerTicketEventHandlers } from '../tickets/ticket-events.js';
import { registerWebhookEventHandlers } from '../webhooks/webhook-events.js';
import { WebhooksRepository } from '../webhooks/webhooks.repository.js';

/** Real ticket and webhook subscribers for suites that drain the whole outbox. */
export const registerTicketOutboxForTest = (broadcast: RealtimeBroadcast): void => {
  registerTicketEventHandlers(broadcast);
  registerWebhookEventHandlers({
    repository: new WebhooksRepository(),
    queue: {
      add: async () => {
        throw new Error(
          'This suite has no webhook delivery worker; use the webhook integration suite',
        );
      },
    },
  });
};
