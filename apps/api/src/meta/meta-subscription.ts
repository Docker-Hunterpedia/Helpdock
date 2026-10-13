import {
  GraphApiFailure,
  type GraphSubscribedApp,
  graphSubscribedAppsSchema,
  graphSuccessSchema,
  parseGraph,
  subscribedAppsOf,
} from '@helpdock/channels';
import { META_SUBSCRIBED_FIELDS, type MetaPlatform } from '@helpdock/schemas';
import type { AccountGraph } from './account-graph.js';

/**
 * The app's webhook subscription to an account (ADR 0025, 10), asked and made
 * the same way by the accounts' routes ("Connect", "Subscribe now", the status
 * panel) and by the hourly health check, so the two cannot come to disagree on
 * where it lives, what counts as accepted or how a missing business account is
 * worded to the operator.
 */

/**
 * What an operator is told when a WhatsApp number has no business account on
 * record, which a connection made by this version cannot produce: Meta keeps the
 * subscription on the business account, so there is nowhere to ask.
 */
export const NO_BUSINESS_ACCOUNT =
  'This number has no WhatsApp business account on record. Disconnect it and connect it again so Helpdock can find it.';

/**
 * Where Meta keeps the app's webhook subscription: on the business account for a
 * WhatsApp number, whose own node has no such edge, and on the account itself for
 * a Page or an Instagram account. Null for a number whose business account was
 * never recorded.
 */
export const subscriptionNodeOf = (
  platform: MetaPlatform,
  externalId: string,
  wabaId: string | null,
): string | null => (platform === 'whatsapp' ? wabaId : externalId);

/** `GET /{node}/subscribed_apps`: every app subscribed to the node, in one shape. */
export const listSubscribedApps = async (
  graph: AccountGraph,
  node: string,
): Promise<GraphSubscribedApp[]> =>
  subscribedAppsOf(
    parseGraph(
      graphSubscribedAppsSchema,
      await graph.get(`/${node}/subscribed_apps`),
      'to the subscribed apps',
    ),
  );

/**
 * `POST /{node}/subscribed_apps` for the platform's fields, answering the fields
 * subscribed. WhatsApp subscribes the whole `messages` field and takes none by
 * name. A refusal is a {@link GraphApiFailure}, and so is a 200 that says
 * `success: false`.
 */
export const subscribeApp = async (
  graph: AccountGraph,
  platform: MetaPlatform,
  node: string,
): Promise<readonly string[]> => {
  const fields = META_SUBSCRIBED_FIELDS[platform];
  const answer = parseGraph(
    graphSuccessSchema,
    await graph.post(
      `/${node}/subscribed_apps`,
      platform === 'whatsapp' ? {} : { query: { subscribed_fields: fields.join(',') } },
    ),
    'to the subscription',
  );
  if (answer?.success === false) {
    throw new GraphApiFailure('permanent', 'Graph did not accept the subscription');
  }

  return fields;
};
