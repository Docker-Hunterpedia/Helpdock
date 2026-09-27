/**
 * The address half of {@link safeFetch}, for protocols that are not HTTP.
 *
 * M2-02's IMAP poller and M2-08's "Test IMAP" connect to a host a brand Admin
 * typed. That is the same exposure DOMAIN-RULES §13 guards the crawler against:
 * a form that makes the server open a socket to `10.0.0.5:5432` and report
 * whether it answered is a port scanner of the install's own network. So the
 * host goes through the same resolver and the same blocked ranges, the caller
 * connects to the one address this returns — never resolving the name a second
 * time, which is what defeats DNS rebinding — and keeps the name for TLS.
 */
import { type Destination, resolveDestination } from './destination.js';
import { SafeFetchError } from './errors.js';
import { reportBlocked, resolvePolicy, type SafeFetchPolicy } from './policy.js';

export type ResolveHostPolicy = Pick<SafeFetchPolicy, 'allowCidrs' | 'lookup' | 'onBlocked'>;

export interface ResolvedHost {
  readonly address: string;
  readonly family: Destination['family'];
}

/**
 * Resolves `hostname` and returns an address the caller may connect to, or
 * rejects with a {@link SafeFetchError} (`destination-blocked`, `dns-failure`,
 * `invalid-url`). Ports are the protocol's business and are not checked here.
 */
export async function resolvePublicHost(
  hostname: string,
  policy: ResolveHostPolicy = {},
): Promise<ResolvedHost> {
  const bare = hostname.trim().replace(/^\[|\]$/g, '');
  const url = URL.parse(`https://${bare.includes(':') ? `[${bare}]` : bare}`);
  if (bare === '' || url === null) {
    throw new SafeFetchError('invalid-url', `not a valid host: ${hostname}`, { hop: 0 });
  }

  const resolved = resolvePolicy(policy);
  try {
    const destination = await resolveDestination({ url, hostname: bare, port: 0 }, resolved, 0);
    return { address: destination.address, family: destination.family };
  } catch (error) {
    if (error instanceof SafeFetchError && error.code === 'destination-blocked') {
      reportBlocked(resolved, {
        code: error.code,
        url: url.href,
        host: bare,
        address: error.address,
        hop: 0,
        reason: error.message,
      });
    }
    throw error;
  }
}
