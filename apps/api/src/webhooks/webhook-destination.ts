import type { ResolveHostPolicy } from '@helpdock/net';
import { inspectDestination } from '../http/outbound-destination.js';
import { WebhooksFailure } from './webhooks-failure.js';

/**
 * The check an endpoint URL passes when it is added or changed (M8-03), so the
 * Admin hears "that is a private address" in the form rather than in a log
 * entry an hour later. The rules are `http/outbound-destination.ts`'s; delivery
 * checks the address again on every attempt (DOMAIN-RULES §13): a name that
 * resolves publicly today may not tomorrow.
 */
export type WebhookDestinationCheck = (url: string) => Promise<void>;

export const createWebhookDestinationCheck =
  (policy: ResolveHostPolicy): WebhookDestinationCheck =>
  async (url) => {
    const problem = await inspectDestination(url, policy);
    if (problem?.kind === 'destination-blocked') {
      throw new WebhooksFailure('webhook-destination-blocked', problem.address);
    }
    if (problem !== undefined) {
      throw new WebhooksFailure('webhook-https-required');
    }
  };
