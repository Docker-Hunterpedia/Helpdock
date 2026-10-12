import { GraphClient } from '@helpdock/channels';
import type { Env } from '@helpdock/config';

/**
 * The Graph client the Meta services share. The api and the worker build one
 * from the `META_*` keys; a suite hands the module a client pointed at the
 * local stand-in for Graph (`FakeGraph`).
 */

type GraphEnv = Pick<
  Env,
  'META_GRAPH_VERSION' | 'META_GRAPH_API_ROOT' | 'META_INSTAGRAM_API_ROOT' | 'OUTBOUND_ALLOW_CIDRS'
>;

/** Where a refused destination is written (DOMAIN-RULES §13). */
export interface GraphLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * One client for the process: it holds no state beyond the roots and the
 * version, and every call names its token. An unset key is the production
 * default, which lives beside the client.
 *
 * Every destination the client refuses, a host that is not Meta's or an address
 * the SSRF-safe client will not connect to, is logged with the host, the address
 * and the code, so an operator can see probing or a DNS anomaly. Never the query
 * string, which carries a media link's signature.
 */
export const createGraphClient = (env: GraphEnv, log?: GraphLog): GraphClient =>
  new GraphClient({
    allowCidrs: env.OUTBOUND_ALLOW_CIDRS,
    ...(env.META_GRAPH_VERSION === undefined ? {} : { version: env.META_GRAPH_VERSION }),
    ...(env.META_GRAPH_API_ROOT === undefined ? {} : { root: env.META_GRAPH_API_ROOT }),
    ...(env.META_INSTAGRAM_API_ROOT === undefined
      ? {}
      : { instagramRoot: env.META_INSTAGRAM_API_ROOT }),
    ...(log === undefined
      ? {}
      : {
          onBlocked: (event) =>
            log.warn(
              { host: event.host, address: event.address, code: event.code },
              'a Meta call to a destination Helpdock does not allow was refused',
            ),
        }),
  });
