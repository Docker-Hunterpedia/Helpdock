import { metaIdentityValue } from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import {
  contacts,
  type Db,
  type DbTransaction,
  type MetaAccount as MetaAccountRow,
  type MetaConversation as MetaConversationRow,
  metaConversations,
  withSystem,
} from '@helpdock/db';
import {
  createJobProcessor,
  type JobHandler,
  type JobLogger,
  type MetaProfileFetchPayload,
  metaProfileFetchJob,
} from '@helpdock/jobs';
import { META_ERROR_MAX_LENGTH } from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { GraphClientFactory } from './graph-client-factory.js';
import type { MetaRepository } from './meta.repository.js';
import {
  contactNameFor,
  hasPlaceholderName,
  type MetaProfile,
  planProfileLookup,
  readProfile,
} from './meta-profile.js';

/**
 * The `meta.profile_fetch` consumer (M10-05, shared with M10-04): reads a
 * Messenger or Instagram customer's name and, for Instagram, `@username` after
 * their first message has been filed, so the webhook never calls Graph
 * (ADR 0025, 6). Raised by a `meta.profile` outbox row beside the message.
 *
 * | Graph answers | The job |
 * |---|---|
 * | a name or a handle | writes them on the conversation and, when the contact still has the name it was created with, on the contact; records the check |
 * | nothing in it | records the check |
 * | a refusal (the Page lacks the reviewed feature, the customer blocked the account) | records the check and stores nothing: "Messenger user" is drawn at render time, never kept as a name |
 * | Meta or the network failing, a rate limit | throws, so BullMQ asks again (three attempts from 30 seconds); nothing is recorded, so the customer's next message raises the lookup again |
 * | a token that no longer works | marks the account `token_expired` (outside the job's transaction, which a throw rolls back) and throws; the row is left for the next attempt |
 *
 * **Idempotent** (DOMAIN-RULES §6): the receipt is `meta.profile_fetch:<conversation>`,
 * claimed in the job's transaction, so two lookups raised by messages that
 * arrived before the first ran read once; a lookup that finds the conversation
 * already answered does nothing, which holds after receipts are purged.
 */

export interface MetaProfileDependencies {
  readonly db: Db;
  readonly repository: MetaRepository;
  readonly keyring: Keyring;
  readonly graph: GraphClientFactory;
  readonly now?: () => Date;
}

const conversationOf = async (
  tx: DbTransaction,
  id: string,
): Promise<MetaConversationRow | undefined> => {
  const rows = await tx
    .select()
    .from(metaConversations)
    .where(eq(metaConversations.id, id))
    .limit(1);
  return rows[0];
};

const recordCheck = async (tx: DbTransaction, conversationId: string, at: Date): Promise<void> => {
  await tx
    .update(metaConversations)
    .set({ profileCheckedAt: at })
    .where(eq(metaConversations.id, conversationId));
};

/**
 * What Graph said, on the conversation and, when the contact has no better
 * name, on the contact. A part Graph did not send leaves what is stored alone.
 */
const recordProfile = async (
  tx: DbTransaction,
  { conversation, account }: { conversation: MetaConversationRow; account: MetaAccountRow },
  profile: MetaProfile,
  at: Date,
): Promise<void> => {
  await tx
    .update(metaConversations)
    .set({
      ...(profile.name === null ? {} : { profileName: profile.name }),
      ...(profile.username === null ? {} : { username: profile.username }),
      profileCheckedAt: at,
    })
    .where(eq(metaConversations.id, conversation.id));

  const name = contactNameFor(profile);
  if (name === null) {
    return;
  }
  const [contact] = await tx
    .select({ name: contacts.name })
    .from(contacts)
    .where(eq(contacts.id, conversation.contactId))
    .limit(1);
  const identity = metaIdentityValue(account.platform, account.externalId, conversation.customerId);
  if (contact !== undefined && hasPlaceholderName(contact.name, identity)) {
    await tx
      .update(contacts)
      .set({ name, updatedAt: at })
      .where(eq(contacts.id, conversation.contactId));
  }
};

export const createMetaProfileHandler = (
  deps: MetaProfileDependencies,
): JobHandler<MetaProfileFetchPayload> => {
  const now = deps.now ?? (() => new Date());

  /** Outside the job's transaction, which the throw that follows rolls back. */
  const expireToken = async (
    account: MetaAccountRow,
    detail: string,
    log: JobLogger,
  ): Promise<void> => {
    await withSystem(deps.db, account.brandId, (tx) =>
      deps.repository.update(tx, account.id, {
        status: 'token_expired',
        lastError: detail.slice(0, META_ERROR_MAX_LENGTH),
        lastErrorAt: now(),
      }),
    ).catch((error: unknown) => {
      log.error(
        { err: error, accountId: account.id },
        'could not mark a meta account token_expired',
      );
    });
  };

  return async ({ payload, brandId, tx, log }) => {
    const plan = planProfileLookup(
      payload,
      await conversationOf(tx, payload.conversationId),
      await deps.repository.account(tx, payload.accountId),
    );
    if (!plan.read) {
      log.info(
        { brandId, conversationId: payload.conversationId, reason: plan.reason },
        'meta profile lookup skipped',
      );
      return;
    }
    const { conversation, account } = plan;

    const read = await readProfile({
      graph: deps.graph(),
      platform: payload.platform,
      customerId: conversation.customerId,
      token: decryptSecret(account.accessToken, deps.keyring),
    });
    switch (read.kind) {
      case 'named':
        await recordProfile(tx, { conversation, account }, read.profile, now());
        return;
      case 'empty':
        await recordCheck(tx, conversation.id, now());
        return;
      case 'refused':
        log.warn(
          { brandId, accountId: account.id, reason: read.failure.kind, code: read.failure.code },
          'meta profile read refused; the customer keeps no name',
        );
        await recordCheck(tx, conversation.id, now());
        return;
      case 'retry':
        throw read.failure;
      case 'token_dead':
        await expireToken(account, read.failure.detail, log);
        throw read.failure;
    }
  };
};

export const createMetaProfileProcessor = (
  deps: MetaProfileDependencies & { readonly log: JobLogger },
): ((job: Job) => Promise<void>) =>
  createJobProcessor(metaProfileFetchJob, createMetaProfileHandler(deps), {
    db: deps.db,
    log: deps.log,
  });
