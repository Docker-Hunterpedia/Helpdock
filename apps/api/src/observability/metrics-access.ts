import { timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Who may read `/metrics`.
 *
 * The endpoint is `@Public()` because a scraper has no session, but "public" is
 * not what it is: the series name every route this install serves, how many 5xx
 * it returns, how deep its queues are and how many jobs have failed. That is
 * reconnaissance, and prom-client's default metrics add the process's heap,
 * handle counts and start time on top.
 *
 * So two doors, and a request needs one of them:
 *
 * 1. **It reached this process directly from the private network or this host.**
 *    A Prometheus in the same Compose network, a sidecar, an operator on a
 *    tunnel.
 * 2. **It presents `METRICS_TOKEN` as a bearer.** For anything else.
 *
 * Two things about the address, and the second is the one that matters.
 *
 * The address checked is the *socket's* peer, never `x-forwarded-for`: Fastify's
 * `request.ip` follows that header when `TRUST_PROXY` is on, and a header a
 * client controls must not be able to claim a private address.
 *
 * But the socket peer is only evidence of *who dialled this port*. Behind a
 * reverse proxy it is always the proxy, which sits on the private network — so
 * a request the proxy forwarded from the public internet would pass the address
 * check on the proxy's credentials, not its own. A request that arrived through
 * a proxy therefore does not get door 1 at all: it must present the token. A
 * scraper that dials `api:3000` itself carries no forwarding header and is
 * unaffected, which is the deployment the address check exists for.
 *
 * The reverse proxy must still not route `/metrics` publicly — that is the
 * first line, and this is what holds when it is misconfigured
 * (docs/guides/operations.md).
 */

export type MetricsAccess = 'private-network' | 'token' | 'denied';

/** Loopback, RFC 1918, link-local and carrier-grade NAT, in IPv4. */
const isPrivateIPv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined || parts.some(Number.isNaN)) {
    return false;
  }

  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

/** Loopback, unique-local (`fc00::/7`) and link-local (`fe80::/10`), in IPv6. */
const isPrivateIPv6 = (address: string): boolean => {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (normalized === '::1' || normalized === '::') {
    return true;
  }

  // An IPv4 peer on a dual-stack socket arrives as `::ffff:10.0.0.4`.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  if (mapped?.[1] !== undefined) {
    return isPrivateIPv4(mapped[1]);
  }

  const group = Number.parseInt(normalized.split(':')[0] ?? '', 16);
  if (Number.isNaN(group)) {
    return false;
  }

  return (group & 0xfe00) === 0xfc00 || (group & 0xffc0) === 0xfe80;
};

/**
 * Anything that is not an IP address is not a private one. The check is
 * explicit because `isPrivateIPv6` parses a leading hex run, which would
 * otherwise read `fe80.evil.example` as link-local and fail open.
 */
export const isPrivateAddress = (address: string | undefined): boolean => {
  if (address === undefined) {
    return false;
  }

  if (isIPv4(address)) {
    return isPrivateIPv4(address);
  }

  // A zone index is part of a link-local address but not of the literal.
  return isIPv6(address.split('%')[0] ?? '') && isPrivateIPv6(address);
};

/** The value after `Bearer `, or undefined. The scheme is matched case-insensitively. */
export const bearerToken = (header: string | undefined): string | undefined => {
  if (header === undefined) {
    return undefined;
  }

  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1];
};

/**
 * Constant-time comparison, so the number of correct leading characters cannot
 * be read off the response time. Lengths are compared first and in the clear,
 * which leaks only the length — unavoidable, and not a secret worth the
 * complexity of padding.
 */
export const tokenMatches = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
};

export interface MetricsAccessInput {
  /** `socket.remoteAddress`, never a forwarded header. */
  readonly remoteAddress: string | undefined;
  readonly authorization: string | undefined;
  /** `METRICS_TOKEN`, or undefined when the install did not set one. */
  readonly expectedToken: string | undefined;
  /**
   * True when this request reached the process through a reverse proxy, in
   * which case the socket peer describes the proxy and not the client.
   */
  readonly viaProxy: boolean;
}

export const metricsAccess = ({
  remoteAddress,
  authorization,
  expectedToken,
  viaProxy,
}: MetricsAccessInput): MetricsAccess => {
  if (!viaProxy && isPrivateAddress(remoteAddress)) {
    return 'private-network';
  }

  const presented = bearerToken(authorization);
  if (
    expectedToken !== undefined &&
    presented !== undefined &&
    tokenMatches(presented, expectedToken)
  ) {
    return 'token';
  }

  return 'denied';
};
