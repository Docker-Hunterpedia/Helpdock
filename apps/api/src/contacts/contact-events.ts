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

export const enqueueContactCreated = (
  tx: DbTransaction,
  brandId: string,
  contactId: string,
): Promise<string> =>
  enqueueOutbox(tx, { brandId, event: CONTACT_CREATED_EVENT, payload: { contactId } });

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
