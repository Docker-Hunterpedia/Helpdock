import {
  GraphApiFailure,
  graphRefreshTokenSchema,
  parseGraph,
  redactToken,
} from '@helpdock/channels';
import { encryptSecret, type Keyring } from '@helpdock/config';
import type { Db, MetaAccount as MetaAccountRow } from '@helpdock/db';
import { withSystemJob } from '../tenant/system-job.js';
import { type GraphClientFactory, graphForAccount } from './graph-factory.js';
import type { MetaRepository } from './meta.repository.js';

/**
 * An Instagram user token lasts 60 days and is renewed with one call, once it
 * is old enough (M10-07's `POST …/refresh`, M10-10's hourly job; ADR 0025, 3
 * and 10). One function so the route and the job cannot disagree about when a
 * token is due, what is stored when Graph renews it, or what is recorded when
 * it refuses.
 *
 * It runs in a transaction of its own for the account's brand, as a job does,
 * so the route can call it from a request and the job from the worker.
 */

/** Instagram renews a token that is at least a day old; Helpdock waits a week, as the artboards say. */
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface TokenRefreshDeps {
  readonly db: Db;
  readonly repository: MetaRepository;
  readonly keyring: Keyring;
  readonly graph: GraphClientFactory;
}

export interface TokenRefreshResult {
  /** `not-due` when the account has no expiring token or its token is younger than a week. */
  readonly outcome: 'refreshed' | 'refused' | 'not-due';
  /** The new expiry, when the token was renewed. */
  readonly expiresAt?: Date;
}

type Refreshable = Pick<
  MetaAccountRow,
  'platform' | 'tokenKind' | 'tokenRefreshedAt' | 'tokenUpdatedAt'
>;

/** Whether this account's token is one that is renewed, and old enough to be. */
export const isRefreshDue = (account: Refreshable, now: Date): boolean =>
  account.platform === 'instagram' &&
  account.tokenKind === 'instagram_user' &&
  now.getTime() - (account.tokenRefreshedAt ?? account.tokenUpdatedAt).getTime() >=
    REFRESH_AFTER_MS;

/**
 * Renews an Instagram account's token if it is due.
 *
 * - **Renewed**: the token Graph answers with is stored encrypted, with its new
 *   expiry and `token_refreshed_at`. Graph may hand back the same string or a
 *   new one; either way the stored one is what it said.
 * - **Refused**: `last_error` says why, in Graph's words without the token, and
 *   a token Graph calls dead (or one past its expiry) makes the account
 *   `token_expired`. The caller decides what that means to a person.
 * - **Graph or the network failed**: thrown as the {@link GraphApiFailure}, which
 *   a job retries; nothing is recorded, because nothing was learnt.
 */
export const refreshInstagramToken = async (
  { db, repository, keyring, graph }: TokenRefreshDeps,
  account: MetaAccountRow,
): Promise<TokenRefreshResult> => {
  const now = new Date();
  if (!isRefreshDue(account, now)) {
    return { outcome: 'not-due' };
  }

  try {
    const renewed = parseGraph(
      graphRefreshTokenSchema,
      await graphForAccount(account, keyring, graph).refreshInstagramToken(),
      'to the token refresh',
    );
    const expiresAt = new Date(now.getTime() + renewed.expires_in * 1_000);
    await withSystemJob(db, account.brandId, 'meta.token_refresh', (tx) =>
      repository.update(tx, account.id, {
        accessToken: encryptSecret(renewed.access_token, keyring),
        tokenExpiresAt: expiresAt,
        tokenRefreshedAt: now,
      }),
    );

    return { outcome: 'refreshed', expiresAt };
  } catch (error) {
    if (
      !(error instanceof GraphApiFailure) ||
      error.kind === 'retry' ||
      error.kind === 'rate_limited'
    ) {
      throw error;
    }
    const pastExpiry = account.tokenExpiresAt !== null && account.tokenExpiresAt <= now;
    await withSystemJob(db, account.brandId, 'meta.token_refresh', async (tx) => {
      await repository.markError(tx, account.id, redactToken(error.detail), now);
      if (error.kind === 'token_dead' || pastExpiry) {
        await repository.update(tx, account.id, { status: 'token_expired' });
      }
    });

    return { outcome: 'refused' };
  }
};
