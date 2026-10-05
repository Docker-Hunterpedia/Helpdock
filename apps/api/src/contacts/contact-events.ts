import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';

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
