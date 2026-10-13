import type { GraphClient } from '@helpdock/channels';
import type { Keyring } from '@helpdock/config';
import {
  type Db,
  type DbTransaction,
  type MetaAccount as MetaAccountRow,
  type MetaConversation as MetaConversationRow,
  withSystem,
} from '@helpdock/db';
import {
  claimReceipt,
  type JobLogger,
  type MetaProfileFetchPayload,
  metaProfileFetchJob,
  readJob,
} from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { failureFields } from '../channels/pg-errors.js';
import { graphForAccount } from './account-graph.js';
import type { MetaRepository } from './meta.repository.js';
import type { AccountFailureRecorder } from './meta-account-failure.js';
import { planProfileLookup, readProfile, wantsProfile } from './meta-profile.js';

/**
 * The `meta.profile_fetch` consumer (M10-05, shared with M10-04): reads a
 * Messenger or Instagram customer's name and, for Instagram, `@username` after
 * their first message has been filed, so the webhook never calls Graph
 * (ADR 0025, 6). Raised by a `meta.profile` outbox row beside the message.
 *
 * ```
 * 1. a short transaction: the conversation and the account, and whether the name is still wanted
 * 2. no transaction at all: GET /{customer id}?fields=…
 * 3. a short transaction: claim the receipt, write what Graph said
 * ```
 *
 * The job shares the `inbound` queue with email and Telegram polling, so no
 * transaction of the brand's waits on Meta: a slow Graph holds a worker, never
 * a pooled connection.
 *
 * | Graph answers | The job |
 * |---|---|
 * | a name or a handle | writes them on the conversation and, when the contact still has the name it was created with, on the contact; records the check |
 * | nothing in it | records the check |
 * | a refusal (the Page lacks the reviewed feature, the customer blocked the account) | records the check and stores nothing: "Messenger user" is drawn at render time, never kept as a name |
 * | Meta or the network failing, a rate limit | throws, so BullMQ asks again (three attempts from 30 seconds); nothing is recorded, so the customer's next message raises the lookup again |
 * | a token that no longer works | marks the account `token_expired` (in a transaction of its own) and throws; the row is left for the next attempt |
 *
 * **Idempotent** (DOMAIN-RULES §6): the receipt is `meta.profile_fetch:<conversation>`,
 * claimed in the transaction that writes, so two lookups raised by messages that
 * arrived before the first ran read once and write once; a lookup that finds the
 * conversation already answered does nothing, which holds after receipts are purged.
 */

export interface MetaProfileDependencies {
  readonly repository: Pick<
    MetaRepository,
    'account' | 'conversationById' | 'recordProfile' | 'recordProfileCheck'
  >;
  readonly keyring: Keyring;
  readonly graph: GraphClient;
  /** A short transaction of the brand's, as the system principal: the job has two. */
  readonly transaction: <T>(brandId: string, work: (tx: DbTransaction) => Promise<T>) => Promise<T>;
  /** Claims the delivery's receipt, in the transaction that writes what the delivery did. */
  readonly claim: (tx: DbTransaction, key: string) => Promise<boolean>;
  /** Marks the account `token_expired` in a transaction of its own: the throw that follows ends the attempt. */
  readonly recordAccountFailure: AccountFailureRecorder;
  readonly now?: () => Date;
}

/** What one delivery of the job is for. */
export interface MetaProfileRun {
  readonly payload: MetaProfileFetchPayload;
  readonly log: JobLogger;
  /** The receipt this delivery claims when it writes. */
  readonly receipt: string;
}

/** What the first transaction found to ask Graph about. */
interface Lookup {
  readonly conversation: MetaConversationRow;
  readonly account: MetaAccountRow;
}

export const createMetaProfileHandler = (deps: MetaProfileDependencies) => {
  const now = deps.now ?? (() => new Date());

  /**
   * The second transaction: the receipt, then the write. The conversation is
   * read again, because Graph took a while: a lookup that raced this one may
   * have answered it, and the name is then not written twice.
   */
  const write = (
    { payload, log, receipt }: MetaProfileRun,
    lookup: Lookup,
    record: (tx: DbTransaction, conversation: MetaConversationRow) => Promise<void>,
  ): Promise<void> =>
    deps.transaction(payload.brandId, async (tx) => {
      if (!(await deps.claim(tx, receipt))) {
        log.info(
          { conversationId: lookup.conversation.id, receipt },
          'duplicate delivery ignored; its receipt is already claimed',
        );
        return;
      }
      const current = await deps.repository.conversationById(tx, lookup.conversation.id);
      if (current === undefined || !wantsProfile(current)) {
        log.info(
          { conversationId: lookup.conversation.id },
          'the conversation was answered while Graph was asked',
        );
        return;
      }
      await record(tx, current);
    });

  /** A token Graph calls dead is recorded on the account, and a failure to record it never hides that one. */
  const expireToken = async (
    account: MetaAccountRow,
    detail: string,
    log: JobLogger,
  ): Promise<void> => {
    await deps
      .recordAccountFailure(account.brandId, account.id, { kind: 'token_dead', detail })
      .catch((error: unknown) => {
        log.error(
          { accountId: account.id, ...failureFields(error) },
          'could not mark a meta account token_expired',
        );
      });
  };

  return async (run: MetaProfileRun): Promise<void> => {
    const { payload, log } = run;
    const plan = await deps.transaction(payload.brandId, async (tx) =>
      planProfileLookup(
        payload,
        await deps.repository.conversationById(tx, payload.conversationId),
        await deps.repository.account(tx, payload.accountId),
      ),
    );
    if (!plan.read) {
      log.info(
        {
          brandId: payload.brandId,
          conversationId: payload.conversationId,
          reason: plan.reason,
        },
        'meta profile lookup skipped',
      );
      return;
    }
    const { conversation, account } = plan;
    const lookup = { conversation, account };

    const read = await readProfile({
      graph: graphForAccount(account, deps.keyring, deps.graph),
      platform: payload.platform,
      customerId: conversation.customerId,
    });
    switch (read.kind) {
      case 'named':
        await write(run, lookup, (tx, current) =>
          deps.repository.recordProfile(
            tx,
            { conversation: current, account },
            read.profile,
            now(),
          ),
        );
        return;
      case 'empty':
        await write(run, lookup, (tx, current) =>
          deps.repository.recordProfileCheck(tx, current.id, now()),
        );
        return;
      case 'refused':
        log.warn(
          {
            brandId: payload.brandId,
            accountId: account.id,
            reason: read.failure.kind,
            code: read.failure.code,
          },
          'meta profile read refused; the customer keeps no name',
        );
        await write(run, lookup, (tx, current) =>
          deps.repository.recordProfileCheck(tx, current.id, now()),
        );
        return;
      case 'retry':
        throw read.failure;
      case 'token_dead':
        await expireToken(account, read.failure.detail, log);
        throw read.failure;
    }
  };
};

/**
 * The handler behind the job's guards (the right job, an id, a payload that
 * parses) with a short transaction of the brand's for each of its two steps and
 * the receipt claimed in the second.
 */
export const createMetaProfileProcessor = ({
  db,
  log,
  ...deps
}: Omit<MetaProfileDependencies, 'transaction' | 'claim'> & {
  readonly db: Db;
  readonly log: JobLogger;
}): ((job: Job) => Promise<void>) => {
  const handler = createMetaProfileHandler({
    ...deps,
    transaction: (brandId, work) => withSystem(db, brandId, work),
    claim: claimReceipt,
  });

  return async (job) => {
    const { payload, key } = readJob(metaProfileFetchJob, job);
    await handler({ payload, log, receipt: key });
  };
};
