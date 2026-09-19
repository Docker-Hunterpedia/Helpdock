/**
 * A fixed-window counter per source address, in process.
 *
 * It exists for `/internal/domain-check`, which Caddy calls before it asks a
 * certificate authority for a certificate: an unbounded caller there turns into
 * unbounded database reads and, worse, into rate-limit trouble with the CA.
 *
 * In process and not in Redis on purpose. The endpoint's job is to let Caddy
 * decide whether a TLS handshake may proceed, and a limiter that needs Redis
 * would stop serving certificates whenever Redis blinked. The counter is
 * therefore per replica; the install-wide throttler over Redis (ARCHITECTURE §3)
 * arrives with the authenticated routes that need an exact budget.
 */

export interface IpRateLimiterOptions {
  /** Requests one address may make per window. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Addresses tracked at once. Reaching it drops the whole table rather than
   * evicting one entry: the window is short, and a table that grows with the
   * number of distinct sources is how a limiter becomes the denial of service.
   */
  readonly maxTrackedIps: number;
  /** Overridden by tests so a window can pass without waiting for one. */
  readonly now?: () => number;
}

export interface IpRateLimiter {
  /** True when this request is within the budget, false when it is refused. */
  allow(ip: string): boolean;
}

interface Window {
  count: number;
  startedAt: number;
}

export const createIpRateLimiter = ({
  limit,
  windowMs,
  maxTrackedIps,
  now = Date.now,
}: IpRateLimiterOptions): IpRateLimiter => {
  const windows = new Map<string, Window>();

  return {
    allow: (ip) => {
      const at = now();
      const current = windows.get(ip);

      if (current === undefined || at - current.startedAt >= windowMs) {
        if (windows.size >= maxTrackedIps) {
          windows.clear();
        }
        windows.set(ip, { count: 1, startedAt: at });
        return true;
      }

      current.count += 1;
      return current.count <= limit;
    },
  };
};
