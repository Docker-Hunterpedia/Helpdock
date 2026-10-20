import type { DbTransaction } from '@helpdock/db';
import {
  enqueueOutbox,
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
} from '@helpdock/jobs';

/**
 * M8-03: `contact.created`, written in the transaction that creates the
 * contact — by the admin, the public API, or a channel recognising somebody
 * new — so the `contact.created` webhook hears about every one of them. The
 * payload is the id; whoever handles it reads the row.
 */
export const CONTACT_CREATED_EVENT = 'contact.created';

const createdInTransaction = new WeakMap<DbTransaction, Set<string>>();

/**
 * Whether this transaction created the contact. `contact.created` already
 * tells a receiver about everything the row holds at commit, so a profile
 * change made after the insert, in the same transaction, is not news.
 */
export const wasContactCreatedIn = (tx: DbTransaction, contactId: string): boolean =>
  createdInTransaction.get(tx)?.has(contactId) ?? false;

export const markContactCreated = (tx: DbTransaction, contactId: string): void => {
  const created = createdInTransaction.get(tx) ?? new Set<string>();
  created.add(contactId);
  createdInTransaction.set(tx, created);
};

/** A savepoint is a new transaction object over the same transaction: it shares what the parent created. */
export const shareCreatedContacts = (parent: DbTransaction, savepoint: DbTransaction): void => {
  const created = createdInTransaction.get(parent) ?? new Set<string>();
  createdInTransaction.set(parent, created);
  createdInTransaction.set(savepoint, created);
};

export const enqueueContactCreated = async (
  tx: DbTransaction,
  brandId: string,
  contactId: string,
): Promise<string> => {
  const id = await enqueueOutbox(tx, {
    brandId,
    event: CONTACT_CREATED_EVENT,
    payload: { contactId },
  });
  const created = createdInTransaction.get(tx) ?? new Set<string>();
  created.add(contactId);
  createdInTransaction.set(tx, created);

  return id;
};

const logCreated: OutboxEventHandler = async ({ brandId, outboxId, payload, log }) => {
  log.info(
    { event: CONTACT_CREATED_EVENT, brandId, outboxId, contactId: payload.contactId },
    'contact created',
  );
};

/**
 * The owner's slot of `contact.created`, which only logs: the work is the
 * subscribers' (the webhooks module's, M8-03), and an event with no handler at
 * all would fail as unknown and burn its attempts.
 */
export const registerContactEventHandlers = (
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  dispatcher.register(CONTACT_CREATED_EVENT, logCreated);
};
