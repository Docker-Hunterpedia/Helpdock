import {
  addressInCidrs,
  type ResolveHostPolicy,
  resolvePublicHost,
  SafeFetchError,
} from '@helpdock/net';

/**
 * The check an outbound address passes when an admin saves it, so the form can
 * say "that is a private address" or "use https" there rather than in a log
 * entry an hour later (DOMAIN-RULES §13). Webhook endpoints (M8-03) and the
 * AI provider, embeddings and transcription URLs (ASVS 12.6.1, 9.2.2) share it.
 * The request itself checks the address again each time it is made, where it
 * goes through `safeFetch`.
 *
 * - A name that resolves to a blocked range is a problem, with the address,
 *   unless `OUTBOUND_ALLOW_CIDRS` allows it.
 * - Plain `http` is a problem unless the address is in `OUTBOUND_ALLOW_CIDRS`:
 *   an operator's own service may lack TLS, somebody else's may not.
 * - A name that does not resolve yet is judged by its scheme alone.
 */
export type DestinationProblem =
  | { readonly kind: 'https-required' }
  | { readonly kind: 'destination-blocked'; readonly address: string | undefined };

export const inspectDestination = async (
  raw: string,
  policy: ResolveHostPolicy,
): Promise<DestinationProblem | undefined> => {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  let address: string | undefined;
  try {
    ({ address } = await resolvePublicHost(hostname, policy));
  } catch (error) {
    if (error instanceof SafeFetchError && error.code === 'destination-blocked') {
      return { kind: 'destination-blocked', address: error.address };
    }
    // `dns-failure` and the like: decided by the scheme alone, below.
  }

  const allowed = address !== undefined && addressInCidrs(address, policy.allowCidrs ?? []);
  return url.protocol === 'http:' && !allowed ? { kind: 'https-required' } : undefined;
};
