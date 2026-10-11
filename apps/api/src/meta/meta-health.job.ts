import type { GraphClient } from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import {
  claimReceipt,
  type JobLogger,
  META_HEALTH_CRON,
  type MetaHealthPayload,
  metaHealthJob,
  metaHealthReceiptKey,
  metaHealthScheduleJob,
  metaHealthSchedulerId,
  type OutboxEventHandler,
  parseJobPayloadOrFail,
} from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { isBrandGone } from '../brands/brand-availability.js';
import { withSystemJob } from '../tenant/system-job.js';
import type { MetaRepository } from './meta.repository.js';
import { metaAccountChangedEventSchema } from './meta-events.js';
import { checkMetaAccount, type MetaHealthUpdate } from './meta-health.js';
import { refreshInstagramToken } from './meta-token-refresh.js';

/**
 * The worker's half of M10-10 (ADR 0025, 10): the hourly check of every
 * connected Meta account, and the job schedulers that make it happen.
 *
 * ```
 * :00 every hour     meta.health (account A)   token, subscription, Instagram renewal
 *                    meta.health (account B)   (meta-health.ts decides; this file stores)
 * 05:30 every day    meta.health.schedule      registers every account's scheduler again
 * ```
 *
 * A check reads the account in its brand's system context, asks Graph with the
 * account's own token, and writes what it found back in the same transaction
 * as the hour's receipt, so a second worker, or a retry after the first
 * attempt committed, finds the receipt and stands down. The token is decrypted
 * here and nowhere it could be logged or stored in `last_error`.
 */

export interface MetaHealthDependencies {
  readonly db: Db;
  readonly log: JobLogger;
  readonly keyring: Keyring;
  readonly repository: MetaRepository;
  readonly graph: Pick<GraphClient, 'get' | 'post'>;
  readonly scheduler: MetaHealthScheduler;
  /** The install's Meta app id (`meta.appId`), empty when unset. Read per check: a setting can change. */
  readonly appId: () => Promise<string>;
  readonly now?: () => Date;
}

/** Why a tick checked nothing. */
export type MetaHealthSkip = 'account-gone' | 'brand-gone' | 'already-checked' | 'token-replaced';

export type MetaHealthRun =
  | { readonly ran: true; readonly update: MetaHealthUpdate }
  | { readonly ran: false; readonly reason: MetaHealthSkip };

/**
 * One account's check. A failure that is no answer from Graph (it is down,
 * rate-limited) is thrown with nothing written, which rolls the receipt back
 * and lets BullMQ ask again.
 */
export const runMetaHealth = async (
  deps: MetaHealthDependencies,
  { brandId, accountId }: MetaHealthPayload,
  jobId: string,
): Promise<MetaHealthRun> => {
  const now = (deps.now ?? (() => new Date()))();

  return withSystemJob(deps.db, brandId, jobId, async (tx): Promise<MetaHealthRun> => {
    const account = await deps.repository.account(tx, accountId);
    if (account === undefined) {
      // Disconnected, or its brand purged (which deletes rows without an event).
      await deps.scheduler.remove(accountId);
      return { ran: false, reason: 'account-gone' };
    }
    // M8-07: a brand being deleted gets no calls to Meta. The scheduler stays,
    // so a restore within the grace period picks up where checking stopped.
    if (await isBrandGone(deps.db, brandId)) {
      return { ran: false, reason: 'brand-gone' };
    }
    // Claimed before Graph is asked, and held by this transaction until it ends:
    // a second worker blocks here, then finds the key taken.
    if (!(await claimReceipt(tx, metaHealthReceiptKey(accountId, now)))) {
      return { ran: false, reason: 'already-checked' };
    }

    const update = await checkMetaAccount(
      {
        graph: deps.graph,
        appId: await deps.appId(),
        refresh: (row) =>
          refreshInstagramToken(
            {
              db: deps.db,
              repository: deps.repository,
              keyring: deps.keyring,
              graph: deps.graph,
              now: () => now,
            },
            row,
          ),
      },
      account,
      decryptSecret(account.accessToken, deps.keyring),
      now,
    );

    // An operator may have pasted a new token while Graph was being asked
    // about the old one. What was found is about a token no longer in use, so
    // it is not written; the next hour checks the new one.
    const current = await deps.repository.account(tx, accountId);
    if (current?.tokenUpdatedAt.getTime() !== account.tokenUpdatedAt.getTime()) {
      return { ran: false, reason: 'token-replaced' };
    }
    await deps.repository.update(tx, accountId, update);

    return { ran: true, update };
  });
};

/**
 * The `maintenance` queue's processor for the two health jobs. Returns
 * `undefined` for any other job, so the worker hands it to the next processor.
 */
export const createMetaHealthProcessor =
  (deps: MetaHealthDependencies) =>
  (job: Pick<Job, 'name' | 'id' | 'data'>): Promise<void> | undefined => {
    switch (job.name) {
      case metaHealthScheduleJob.name:
        return scheduleAllMetaHealth(deps.db, deps.repository, deps.scheduler).then((accounts) =>
          deps.log.info({ job: job.name, accounts }, 'meta health checks scheduled'),
        );
      case metaHealthJob.name: {
        const payload = parseJobPayloadOrFail(metaHealthJob, job.data);
        return runMetaHealth(
          deps,
          payload,
          job.id ?? metaHealthSchedulerId(payload.accountId),
        ).then((run) => {
          const fields = { job: job.name, accountId: payload.accountId };
          if (!run.ran) {
            deps.log.info({ ...fields, skipped: run.reason }, 'meta health check skipped');
          } else if (
            run.update.status === 'token_expired' ||
            run.update.status === 'unsubscribed'
          ) {
            deps.log.warn({ ...fields, status: run.update.status }, 'meta account needs attention');
          } else {
            deps.log.info(
              { ...fields, status: run.update.status ?? 'unchanged' },
              'meta account checked',
            );
          }
        });
      }
      default:
        return undefined;
    }
  };

// --------------------------------------------------------------------------
// Scheduling
// --------------------------------------------------------------------------

/** What scheduling needs of BullMQ. The worker passes a queue; a test passes a double. */
export interface MetaHealthScheduler {
  upsert(account: { readonly id: string; readonly brandId: string }): Promise<void>;
  remove(accountId: string): Promise<void>;
}

export const queueMetaHealthScheduler = (queue: {
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string; tz: string },
    template: { name: string; data: unknown; opts: object },
  ): Promise<unknown>;
  removeJobScheduler(id: string): Promise<unknown>;
}): MetaHealthScheduler => ({
  upsert: async (account) => {
    await queue.upsertJobScheduler(
      metaHealthSchedulerId(account.id),
      { pattern: META_HEALTH_CRON, tz: 'UTC' },
      {
        name: metaHealthJob.name,
        data: { brandId: account.brandId, accountId: account.id } satisfies MetaHealthPayload,
        opts: metaHealthJob.options,
      },
    );
  },
  remove: async (accountId) => {
    await queue.removeJobScheduler(metaHealthSchedulerId(accountId));
  },
});

/**
 * `meta_account.changed`: an account connected is checked from the next hour
 * on, an account disconnected stops being checked.
 */
export const createMetaAccountChangedHandler =
  (
    repository: Pick<MetaRepository, 'account'>,
    scheduler: MetaHealthScheduler,
  ): OutboxEventHandler =>
  async ({ tx, payload }) => {
    const { accountId } = metaAccountChangedEventSchema.parse(payload);
    const account = await repository.account(tx, accountId);
    if (account === undefined) {
      await scheduler.remove(accountId);
    } else {
      await scheduler.upsert(account);
    }
  };

/** Every account's check, again, on worker boot (DOMAIN-RULES §10) and daily after. */
export const scheduleAllMetaHealth = async (
  db: Db,
  repository: Pick<MetaRepository, 'listAll'>,
  scheduler: MetaHealthScheduler,
): Promise<number> => {
  const accounts = await repository.listAll(db, 'meta.health.schedule');
  for (const account of accounts) {
    await scheduler.upsert(account);
  }

  return accounts.length;
};
