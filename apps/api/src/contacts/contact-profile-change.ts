import { isDeepStrictEqual } from 'node:util';
import { contacts, type DbTransaction } from '@helpdock/db';
import { inArray } from 'drizzle-orm';
import { readV1Contact } from '../api-v1/v1-contact-view.js';
import { enqueueWebhookEvent } from '../webhooks/enqueue-webhook-event.js';
import { wasContactCreatedIn } from './contact-events.js';

/** Compare receiver-visible fields, excluding the timestamp maintained by writes. */
export const withContactProfileChange = async <T>(
  tx: DbTransaction,
  contactId: string,
  change: () => Promise<T>,
  lockWith: readonly string[] = [],
): Promise<T> => {
  // Acquire every affected contact in id order before comparing either profile:
  // opposite-direction identity transfers must queue rather than deadlock.
  const locked = await tx
    .select()
    .from(contacts)
    .where(inArray(contacts.id, [contactId, ...lockWith]))
    .orderBy(contacts.id)
    .for('update');
  const row = locked.find((contact) => contact.id === contactId);
  const before = await readV1Contact(tx, contactId);
  const result = await change();
  const after = await readV1Contact(tx, contactId);
  if (row !== undefined && before !== undefined && after !== undefined) {
    const { updatedAt: _beforeTime, ...previous } = before;
    const { updatedAt: _afterTime, ...current } = after;
    if (!isDeepStrictEqual(previous, current) && !wasContactCreatedIn(tx, contactId)) {
      await enqueueWebhookEvent(tx, row.brandId, 'contact.updated', {
        contactId,
        departmentId: null,
      });
    }
  }
  return result;
};
