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
 * | 2. the subscription | `GET /{id}/subscribed_apps` (WhatsApp: on the business account, `wabaId`; a number whose business account is unknown is not checked: `last_error` only, no Graph call); the app missing: `POST` it again and read it back | still missing, or the `POST` refused: `unsubscribed`; a refused read: `last_error` only | thrown |
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

/** Everything a step needs to ask Graph about one account and to word what it finds. */
interface Run {
  readonly checks: MetaHealthChecks;
  readonly account: MetaAccount;
  readonly token: string;
  readonly now: Date;
  /** The id `subscribed_apps` is read and written on: see {@link subscriptionNode}. */
  readonly node: string;
}

/**
 * Where the webhook subscription lives. Meta keeps WhatsApp's on the business
 * account (`/{waba}/subscribed_apps`; the number's own id has no such edge) and
 * a Page's or an Instagram account's on the account itself. Null for a number
 * whose business account the row does not know.
 */
const subscriptionNode = ({ platform, wabaId, externalId }: MetaAccount): string | null =>
  platform === 'whatsapp' ? wabaId : externalId;

type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly dead: boolean; readonly detail: string };

/** A step either found what it looked for or ended the run with the update to store. */
type Outcome<T> = { readonly found: T } | { readonly problem: MetaHealthUpdate };

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

/** Graph's words, with the token taken out and cut to what `last_error` keeps. */
const errorText = (message: string, token: string): string =>
  redactToken(message, token).slice(0, META_ERROR_MAX_LENGTH);

const problem = (
  run: Pick<Run, 'token' | 'now'>,
  detail: string,
  status?: MetaAccountStatus,
): MetaHealthUpdate => ({
  ...(status === undefined ? {} : { status }),
  lastError: errorText(detail, run.token),
  lastErrorAt: run.now,
});

/** A dead token outranks whatever the step was doing when Graph said so. */
const stopped = (
  run: Run,
  step: Extract<Step<unknown>, { ok: false }>,
  prefix: string,
  otherwise?: MetaAccountStatus,
): MetaHealthUpdate =>
  step.dead
    ? problem(run, step.detail, 'token_expired')
    : problem(run, `${prefix}${step.detail}`, otherwise);

// --------------------------------------------------------------------------
// The token
// --------------------------------------------------------------------------

/** A 200 with `is_valid: false` is Graph's way of saying the token is dead. */
const verifyToken = async ({ checks, account, token }: Run): Promise<void> => {
  if (account.platform === 'instagram') {
    parseGraph(
      graphIdentitySchema,
      await checks.graph.get('/me', {
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
    await checks.graph.get('/debug_token', { token, query: { input_token: token } }),
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

/** The update that ends the run when the token is not good, or undefined when it is. */
const tokenProblem = async (run: Run): Promise<MetaHealthUpdate | undefined> => {
  const step = await attempt(() => verifyToken(run));

  return step.ok ? undefined : stopped(run, step, 'Meta would not confirm the token: ');
};

// --------------------------------------------------------------------------
// The subscription
// --------------------------------------------------------------------------

const NO_BUSINESS_ACCOUNT = 'The business account id is not known; reconnect the number';
const DROPPED = "Meta dropped Helpdock's webhook subscription for this account";
const UNREADABLE = 'Could not read the webhook subscription: ';

interface Subscribed {
  readonly fields: readonly string[];
  /** The job had to subscribe the app itself. */
  readonly resubscribed: boolean;
}

const listSubscribedApps = async ({
  checks,
  account,
  token,
  node,
}: Run): Promise<GraphSubscribedApp[]> =>
  subscribedAppsOf(
    parseGraph(
      graphSubscribedAppsSchema,
      await checks.graph.get(`/${node}/subscribed_apps`, {
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
const subscribe = async ({ checks, account, token, node }: Run): Promise<void> => {
  await checks.graph.post(`/${node}/subscribed_apps`, {
    token,
    api: graphApiFor(account.platform),
    ...(account.platform === 'whatsapp'
      ? {}
      : { query: { subscribed_fields: META_SUBSCRIBED_FIELDS[account.platform].join(',') } }),
  });
};

/** Helpdock's own app among those subscribed; any app while the install has no app id. */
const ourApp = (run: Run, apps: readonly GraphSubscribedApp[]): GraphSubscribedApp | undefined =>
  apps.find((app) => run.checks.appId === '' || app.id === run.checks.appId);

/** Subscribes the app again and reads the subscription back. */
const resubscribe = async (run: Run): Promise<Outcome<Subscribed>> => {
  const posted = await attempt(() => subscribe(run));
  if (!posted.ok) {
    return { problem: stopped(run, posted, `${DROPPED} and refused it again: `, 'unsubscribed') };
  }
  const again = await attempt(() => listSubscribedApps(run));
  if (!again.ok) {
    return { problem: stopped(run, again, UNREADABLE) };
  }
  const app = ourApp(run, again.value);
  if (app === undefined) {
    const detail = `${DROPPED} and still does not list the app after subscribing again.`;
    return { problem: problem(run, detail, 'unsubscribed') };
  }

  return { found: { fields: app.subscribedFields, resubscribed: true } };
};

const ensureSubscribed = async (run: Run): Promise<Outcome<Subscribed>> => {
  const listed = await attempt(() => listSubscribedApps(run));
  if (!listed.ok) {
    return { problem: stopped(run, listed, UNREADABLE) };
  }
  const app = ourApp(run, listed.value);

  return app === undefined
    ? resubscribe(run)
    : { found: { fields: app.subscribedFields, resubscribed: false } };
};

// --------------------------------------------------------------------------
// All well
// --------------------------------------------------------------------------

/**
 * `connected` says messages flow, which a refused renewal of a token that still
 * works does not change: the refusal is on the row as `last_error` for the
 * operator, and the token's own date makes it `token_expired` when it passes.
 */
const healthy = (
  { account, now }: Run,
  subscribed: Subscribed,
  renewal: TokenRefreshResult | undefined,
): MetaHealthUpdate => {
  const refused = renewal?.outcome === 'refused';
  const pastExpiry =
    refused && account.tokenExpiresAt !== null && account.tokenExpiresAt.getTime() <= now.getTime();

  return {
    status: pastExpiry ? 'token_expired' : 'connected',
    subscriptionCheckedAt: now,
    // WhatsApp lists no fields, and the row keeps what it had rather than blank it.
    ...(subscribed.fields.length > 0 ? { subscribedFields: [...subscribed.fields] } : {}),
    ...(subscribed.resubscribed ? { subscribedAt: now } : {}),
    // The error a `token_expired` or `unsubscribed` account was showing is over.
    // The one a renewal has just written is not, and a connected account's may
    // be the inbound pipeline's.
    ...(account.status !== 'connected' && !refused ? { lastError: null, lastErrorAt: null } : {}),
  };
};

/**
 * Runs the checks against one account with its decrypted token and returns what
 * the row should say. Never logs or returns the token.
 */
export const checkMetaAccount = async (
  checks: MetaHealthChecks,
  account: MetaAccount,
  token: string,
  now: Date,
): Promise<MetaHealthUpdate> => {
  const node = subscriptionNode(account);
  if (node === null) {
    // Nothing is asked of Meta: without the business account the subscription cannot be read.
    return problem({ token, now }, NO_BUSINESS_ACCOUNT);
  }
  const run: Run = { checks, account, token, now, node };

  const unconfirmed = await tokenProblem(run);
  if (unconfirmed !== undefined) {
    return unconfirmed;
  }
  const subscription = await ensureSubscribed(run);
  if ('problem' in subscription) {
    return subscription.problem;
  }
  const renewal = account.platform === 'instagram' ? await checks.refresh(account) : undefined;

  return healthy(run, subscription.found, renewal);
};
