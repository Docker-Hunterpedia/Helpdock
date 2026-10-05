import {
  addressInCidrs,
  type ResolveHostPolicy,
  resolvePublicHost,
  SafeFetchError,
} from '@helpdock/net';
import { WebhooksFailure } from './webhooks-failure.js';

/**
 * The check an endpoint URL passes when it is added or changed (M8-03), so the
 * Admin hears "that is a private address" in the form rather than in a log
 * entry an hour later. Delivery checks the address again on every attempt
 * (DOMAIN-RULES §13): a name that resolves publicly today may not tomorrow.
 *
 * - A name that resolves to a blocked range is refused, with the address.
 * - Plain `http` is refused unless the address is in `OUTBOUND_ALLOW_CIDRS`:
 *   an operator's own service may lack TLS, somebody else's endpoint may not.
 * - A name that does not resolve yet is let through over `https`; the delivery
 *   will fail and say so until it does.
 */
export type WebhookDestinationCheck = (url: string) => Promise<void>;

export const createWebhookDestinationCheck =
  (policy: ResolveHostPolicy): WebhookDestinationCheck =>
  async (raw) => {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    let address: string | undefined;
    try {
      ({ address } = await resolvePublicHost(hostname, policy));
    } catch (error) {
      if (error instanceof SafeFetchError && error.code === 'destination-blocked') {
        throw new WebhooksFailure('webhook-destination-blocked', error.address);
      }
      // `dns-failure` and the like: decided by the scheme alone, below.
    }

    if (
      url.protocol === 'http:' &&
      (address === undefined || !addressInCidrs(address, policy.allowCidrs ?? []))
    ) {
      throw new WebhooksFailure('webhook-https-required');
    }
  };
