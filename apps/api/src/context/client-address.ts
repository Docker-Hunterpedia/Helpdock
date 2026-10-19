import { type TrustProxy, trustedPeerCheck } from '@helpdock/config';

/**
 * The client's address for a connection Fastify never sees as a request: the
 * Socket.IO handshake. It is `request.ip` by the same rule — `@fastify/proxy-addr`
 * under `TRUST_PROXY` (bootstrap) — so a visitor behind Caddy is keyed on their
 * own address over the socket exactly as over HTTP, and never on Caddy's.
 *
 * The walk starts at the socket's peer and moves left through
 * `x-forwarded-for` while each hop is one the setting believes; the first hop
 * it does not believe is the client. So with `TRUST_PROXY=false` the header is
 * never read, and an address a client wrote into it is never reached past a
 * proxy that appended the real one. Built once per setting.
 */
export const clientAddressResolver = (
  setting: TrustProxy,
): ((
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
) => string | undefined) => {
  const believes = trustedPeerCheck(setting);

  return (peer, forwardedFor) => {
    const hops = [peer, ...forwardedHopsNearestFirst(forwardedFor)];
    let client = 0;
    while (client < hops.length - 1 && believes(hops[client])) {
      client += 1;
    }
    return hops[client];
  };
};

/**
 * The entries a proxy appended, nearest first. A header sent twice arrives as
 * an array only from a caller that built it so; Node joins repeats into one
 * string, and `@fastify/forwarded` reads nothing but a string, so neither does this.
 */
const forwardedHopsNearestFirst = (header: string | string[] | undefined): string[] =>
  typeof header === 'string'
    ? header
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .reverse()
    : [];
