import {
  GraphApiFailure,
  type GraphClient,
  graphRefreshTokenSchema,
  parseGraph,
  redactToken,
} from '@helpdock/channels';
import { decryptSecret, encryptSecret, type Keyring } from '@helpdock/config';
import type { Db, DbTransaction, MetaAccount } from '@helpdock/db';
import { withSystemJob } from '../tenant/system-job.js';
import type { MetaRepository } from './meta.repository.js';

/**
 * Renewing an Instagram token (M10-10, ADR 0025, 3 and 10). An Instagram user
 * token lives 60 days and Meta renews it for another 60 on request, so
 * Helpdock asks once a week and a few refusals still leave weeks to paste a
 * new one. Messenger's Page tokens and WhatsApp's system-user tokens do not
 * expire, so for them there is nothing to renew.
 *
 * A plain function with no framework, because two callers need it: the hourly
 * `meta.health` job and the account page's "refresh now" route. Both get the
 * same effect on the row, so what the function learns it records itself.
 */

/** A token renewed more recently than this is left alone. */
export const INSTAGRAM_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Names this path on the audit rows its writes would carry. */
const REFRESH_PRINCIPAL = 'meta.token_refresh';

export interface TokenRefreshDeps {
  readonly db: Db;
  readonly repository: Pick<MetaRepository, 'account' | 'update' | 'markError'>;
  readonly keyring: Keyring;
  /** Only `get` is called: the renewal is a `GET`, as Meta defines it. */
  readonly graph: Pick<GraphClient, 'get'>;
  readonly now?: () => Date;
}

export type TokenRefreshAccount = Pick<
  MetaAccount,
  | 'id'
  | 'brandId'
  | 'platform'
  | 'accessToken'
  | 'tokenExpiresAt'
  | 'tokenRefreshedAt'
  | 'tokenUpdatedAt'
>;

export interface TokenRefreshResult {
  /**
   * `refreshed`: Meta issued a new expiry and the row holds it. `refused`: Meta
   * answered no, and the row says so. `not-due`: nothing was stored, because the
   * account is not Instagram, the token was renewed within a week, or an operator
   * replaced it while Meta was being asked.
   */
  readonly outcome: 'refreshed' | 'refused' | 'not-due';
  /** When the renewed token expires; only with `refreshed`. */
  readonly expiresAt?: Date;
}

/**
 * Whether an Instagram token is due: its last renewal, or when it was pasted if
 * it has never been renewed, is more than a week old. The expiry the row holds
 * is not part of the question. A token the row calls expired but Meta still
 * accepts has a stale date, and asking for a renewal is how it gets a true one.
 */
export const instagramRefreshDue = (
  account: Pick<TokenRefreshAccount, 'platform' | 'tokenRefreshedAt' | 'tokenUpdatedAt'>,
  now: Date,
): boolean =>
  account.platform === 'instagram' &&
  now.getTime() - (account.tokenRefreshedAt ?? account.tokenUpdatedAt).getTime() >
    INSTAGRAM_REFRESH_AFTER_MS;

/**
 * Asks Meta to renew an Instagram account's token when it is due
 * (`GET /refresh_access_token?grant_type=ig_refresh_token`) and stores what it
 * answers: the new token encrypted under the master key, its expiry and the
 * moment of the renewal.
 *
 * A refusal (Meta says the token cannot be renewed) is recorded as the
 * account's `last_error` and, when the row's expiry has passed, as
 * `token_expired`. A failure that is not an answer (Graph down, rate-limited)
 * is thrown for the caller to retry, because the token is not at fault.
 *
 * Each write is a transaction of its own: the renewal must not wait on a
 * caller's, and the new token must be on disk before anything else can fail.
 */
export const refreshInstagramToken = async (
  deps: TokenRefreshDeps,
  account: TokenRefreshAccount,
): Promise<TokenRefreshResult> => {
  const now = (deps.now ?? (() => new Date()))();
  if (!instagramRefreshDue(account, now)) {
    return { outcome: 'not-due' };
  }

  const token = decryptSecret(account.accessToken, deps.keyring);
  let renewed: { readonly access_token: string; readonly expires_in: number };
  try {
    renewed = parseGraph(
      graphRefreshTokenSchema,
      await deps.graph.get('/refresh_access_token', {
        token,
        api: 'instagram',
        query: { grant_type: 'ig_refresh_token' },
      }),
      'the token renewal',
      token,
    );
  } catch (error) {
    if (!(error instanceof GraphApiFailure) || !error.permanent) {
      throw error;
    }
    // Meta calling the token dead, or the row's own date having passed, is an
    // expired token. Any other refusal is a problem to read, not yet an outage.
    const expired =
      error.kind === 'token_dead' ||
      (account.tokenExpiresAt !== null && account.tokenExpiresAt.getTime() <= now.getTime());
    await whileTokenUnchanged(deps, account, async (tx) => {
      await deps.repository.markError(
        tx,
        account.id,
        redactToken(`Instagram would not renew the token: ${error.detail}`, token),
        now,
      );
      if (expired) {
        await deps.repository.update(tx, account.id, { status: 'token_expired' });
      }
    });

    return { outcome: 'refused' };
  }

  const expiresAt = new Date(now.getTime() + renewed.expires_in * 1000);
  const stored = await whileTokenUnchanged(deps, account, async (tx) => {
    await deps.repository.update(tx, account.id, {
      // Meta may answer with the token it was given or with a new string; either way the row holds what it said.
      accessToken: encryptSecret(renewed.access_token, deps.keyring),
      tokenExpiresAt: expiresAt,
      tokenRefreshedAt: now,
    });
  });

  return stored ? { outcome: 'refreshed', expiresAt } : { outcome: 'not-due' };
};

/**
 * Runs a write in a transaction of its own, unless the account's token is no
 * longer the one Meta was asked about: an operator may have pasted a new one
 * meanwhile, and what Meta said of the old one must not land on the new. The
 * write and the check share the transaction, so the window is a statement wide.
 */
const whileTokenUnchanged = (
  deps: TokenRefreshDeps,
  account: TokenRefreshAccount,
  write: (tx: DbTransaction) => Promise<void>,
): Promise<boolean> =>
  withSystemJob(deps.db, account.brandId, REFRESH_PRINCIPAL, async (tx) => {
    const current = await deps.repository.account(tx, account.id);
    if (current?.accessToken !== account.accessToken) {
      return false;
    }
    await write(tx);

    return true;
  });
