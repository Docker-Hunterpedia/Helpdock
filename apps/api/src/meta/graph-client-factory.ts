import { GraphClient } from '@helpdock/channels';
import type { Env } from '@helpdock/config';

/**
 * The Graph client the Meta services share. The api builds it from the
 * `META_*` keys; a suite hands the module a client pointed at the local
 * stand-in for Graph (`FakeGraph`). Nothing in the webhook calls it: it is the
 * seam the account routes (M10-07), the profile lookups (M10-04, M10-05) and
 * the health job (M10-10) read the module's client through.
 */
export type GraphClientFactory = () => GraphClient;

type GraphEnv = Pick<
  Env,
  'META_GRAPH_VERSION' | 'META_GRAPH_API_ROOT' | 'META_INSTAGRAM_API_ROOT' | 'OUTBOUND_ALLOW_CIDRS'
>;

/**
 * One client for the process: it holds no state beyond the roots and the
 * version, and every call names its token. An unset key is the production
 * default, which lives beside the client.
 */
export const graphClientFactory = (env: GraphEnv): GraphClientFactory => {
  const client = new GraphClient({
    allowCidrs: env.OUTBOUND_ALLOW_CIDRS,
    ...(env.META_GRAPH_VERSION === undefined ? {} : { version: env.META_GRAPH_VERSION }),
    ...(env.META_GRAPH_API_ROOT === undefined ? {} : { root: env.META_GRAPH_API_ROOT }),
    ...(env.META_INSTAGRAM_API_ROOT === undefined
      ? {}
      : { instagramRoot: env.META_INSTAGRAM_API_ROOT }),
  });

  return () => client;
};
