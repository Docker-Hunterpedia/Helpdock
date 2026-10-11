import {
  GRAPH_IDENTITY_FIELDS,
  GraphApiFailure,
  type GraphClient,
  type GraphSubscribedApp,
  graphApiFor,
  graphDebugTokenSchema,
  graphIdentitySchema,
  graphSubscribedAppsSchema,
  parseGraph,
  redactToken,
  subscribedAppsOf,
} from '@helpdock/channels';
import type { MetaAccount, NewMetaAccount } from '@helpdock/db';
import {
  META_ERROR_MAX_LENGTH,
  META_SUBSCRIBED_FIELDS,
  type MetaAccountStatus,
} from '@helpdock/schemas';
import type { TokenRefreshResult } from './meta-token-refresh.js';

/**
 * The four checks of one account (M10-10, ADR 0025, 10), as a decision from
 * what Graph says to what the row should say. It reads Graph and writes
 * nothing: `meta-health.job.ts` stores the answer, so the table below can be
 * proved with a Graph double and no database.
 *
 * | Step | Graph | A permanent refusal | A failure that is no answer |
 * |---|---|---|---|
 * | 1. the token | `GET /debug_token?input_token=<token>` with the token itself (WhatsApp, Messenger); `GET /me` on the Instagram root | a dead token: `token_expired`; any other refusal: `last_error` only | thrown, the job retries |
 * | 2. the subscription | `GET /{id}/subscribed_apps`; the app missing: `POST` it again and read it back | still missing, or the `POST` refused: `unsubscribed`; a refused read: `last_error` only | thrown |
 * | 3. the renewal | Instagram only, once the token is a week old (`meta-token-refresh.ts`) | recorded by the renewal itself; past the row's expiry: `token_expired` | thrown |
 * | 4. all well | | `status = connected`, `subscription_checked_at` | |
 *
 * A step that finds a problem ends the run: a dead token cannot read its
 * subscription, and a subscription that cannot be read says nothing about the
 * renewal. When Graph refuses a question without giving a verdict (a missing
 * permission, say) the run records Graph's words and leaves `status` as it was,
 * because `connected` or `token_expired` on that evidence would be a guess.
 */

/** What the row should say after the checks; a field left out stays as it is. */
export type MetaHealthUpdate = Pick<
  Partial<NewMetaAccount>,
  | 'status'
  | 'lastError'
  | 'lastErrorAt'
  | 'subscriptionCheckedAt'
  | 'subscribedFields'
  | 'subscribedAt'
>;

export interface MetaHealthChecks {
  readonly graph: Pick<GraphClient, 'get' | 'post'>;
  /** The install's Meta app id (`meta.appId`); empty when it is not set. */
  readonly appId: string;
  /** Step 3. Called for Instagram accounts only, and decides for itself whether the token is due. */
  readonly refresh: (account: MetaAccount) => Promise<TokenRefreshResult>;
}

type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly dead: boolean; readonly detail: string };

/**
 * One Graph call: a refusal Graph meant becomes a value the run decides on; a
 * failure that is no answer (Graph or the network down, a rate limit) is thrown,
 * because the account is not at fault and BullMQ will ask again.
 */
const attempt = async <T>(call: () => Promise<T>): Promise<Step<T>> => {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (error instanceof GraphApiFailure && error.permanent) {
      return { ok: false, dead: error.kind === 'token_dead', detail: error.detail };
    }
    throw error;
  }
};

/** Step 1. A 200 with `is_valid: false` is Graph's way of saying the token is dead. */
const verifyToken = async (
  graph: MetaHealthChecks['graph'],
  account: MetaAccount,
  token: string,
): Promise<void> => {
  if (account.platform === 'instagram') {
    parseGraph(
      graphIdentitySchema,
      await graph.get('/me', {
        token,
        api: 'instagram',
        query: { fields: GRAPH_IDENTITY_FIELDS.instagram },
      }),
      'the account',
      token,
    );
    return;
  }
  const { data } = parseGraph(
    graphDebugTokenSchema,
    await graph.get('/debug_token', { token, query: { input_token: token } }),
    'the token check',
    token,
  );
  if (data.is_valid === false) {
    const code = data.error?.code === undefined ? '' : `${String(data.error.code)}: `;
    throw new GraphApiFailure(
      'token_dead',
      `${code}${data.error?.message ?? 'Meta says the token is no longer valid'}`,
    );
  }
};

const listSubscribedApps = async (
  graph: MetaHealthChecks['graph'],
  account: MetaAccount,
  token: string,
): Promise<GraphSubscribedApp[]> =>
  subscribedAppsOf(
    parseGraph(
      graphSubscribedAppsSchema,
      await graph.get(`/${account.externalId}/subscribed_apps`, {
        token,
        api: graphApiFor(account.platform),
      }),
      'the webhook subscriptions',
      token,
    ),
  );

/**
 * WhatsApp subscribes the whole `messages` field; Messenger and Instagram name
 * the fields (ADR 0025, 10).
 */
const subscribe = async (
  graph: MetaHealthChecks['graph'],
  account: MetaAccount,
  token: string,
): Promise<void> => {
  await graph.post(`/${account.externalId}/subscribed_apps`, {
    token,
    api: graphApiFor(account.platform),
    ...(account.platform === 'whatsapp'
      ? {}
      : { query: { subscribed_fields: META_SUBSCRIBED_FIELDS[account.platform].join(',') } }),
  });
};

const DROPPED = "Meta dropped Helpdock's webhook subscription for this account";
const UNREADABLE = 'Could not read the webhook subscription: ';

/** Graph's words, with the token taken out and cut to what `last_error` keeps. */
const errorText = (message: string, token: string): string =>
  redactToken(message, token).slice(0, META_ERROR_MAX_LENGTH);

/**
 * Runs the four steps against one account with its decrypted token and returns
 * what the row should say. Never logs or returns the token.
 */
export const checkMetaAccount = async (
  checks: MetaHealthChecks,
  account: MetaAccount,
  token: string,
  now: Date,
): Promise<MetaHealthUpdate> => {
  const problem = (detail: string, status?: MetaAccountStatus): MetaHealthUpdate => ({
    ...(status === undefined ? {} : { status }),
    lastError: errorText(detail, token),
    lastErrorAt: now,
  });
  /** A dead token outranks whatever the step was doing when Graph said so. */
  const stopped = (
    step: Extract<Step<unknown>, { ok: false }>,
    prefix: string,
    otherwise?: MetaAccountStatus,
  ): MetaHealthUpdate =>
    step.dead
      ? problem(step.detail, 'token_expired')
      : problem(`${prefix}${step.detail}`, otherwise);

  // 1. The token.
  const tokenStep = await attempt(() => verifyToken(checks.graph, account, token));
  if (!tokenStep.ok) {
    return stopped(tokenStep, 'Meta would not confirm the token: ');
  }

  // 2. The subscription.
  const ours = (apps: readonly GraphSubscribedApp[]) =>
    apps.find((app) => checks.appId === '' || app.id === checks.appId);
  const listed = await attempt(() => listSubscribedApps(checks.graph, account, token));
  if (!listed.ok) {
    return stopped(listed, UNREADABLE);
  }
  let app = ours(listed.value);
  let resubscribed = false;
  if (app === undefined) {
    const posted = await attempt(() => subscribe(checks.graph, account, token));
    if (!posted.ok) {
      return stopped(posted, `${DROPPED} and refused it again: `, 'unsubscribed');
    }
    const again = await attempt(() => listSubscribedApps(checks.graph, account, token));
    if (!again.ok) {
      return stopped(again, UNREADABLE);
    }
    app = ours(again.value);
    if (app === undefined) {
      return problem(
        `${DROPPED} and still does not list the app after subscribing again.`,
        'unsubscribed',
      );
    }
    resubscribed = true;
  }

  // 3. The renewal, which records its own refusal.
  const renewal = account.platform === 'instagram' ? await checks.refresh(account) : undefined;
  const refused = renewal?.outcome === 'refused';
  const pastExpiry =
    refused && account.tokenExpiresAt !== null && account.tokenExpiresAt.getTime() <= now.getTime();

  // 4. Well. `connected` says messages flow, which a refused renewal of a token
  // that still works does not change; it is on the row as `last_error` for
  // the operator, and the token's own date will make it `token_expired` later.
  return {
    status: pastExpiry ? 'token_expired' : 'connected',
    subscriptionCheckedAt: now,
    // WhatsApp lists no fields, and the row keeps what it had rather than blank it.
    ...(app.subscribedFields.length > 0 ? { subscribedFields: [...app.subscribedFields] } : {}),
    ...(resubscribed ? { subscribedAt: now } : {}),
    // The error the job (or the operator's last attempt) reported is over. One
    // the renewal has just written is not.
    ...(account.status !== 'connected' && !refused ? { lastError: null, lastErrorAt: null } : {}),
  };
};
