import { isDeepStrictEqual } from 'node:util';
import { contacts, type DbTransaction } from '@helpdock/db';
import { eq } from 'drizzle-orm';
import { readV1Contact } from '../api-v1/v1-contact-view.js';
import { enqueueWebhookEvent } from '../webhooks/enqueue-webhook-event.js';

/** Compare receiver-visible fields, excluding the timestamp maintained by writes. */
export const withContactProfileChange = async <T>(
  tx: DbTransaction,
  contactId: string,
  change: () => Promise<T>,
): Promise<T> => {
  const [row] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).for('update');
  const before = await readV1Contact(tx, contactId);
  const result = await change();
  const after = await readV1Contact(tx, contactId);
  if (row !== undefined && before !== undefined && after !== undefined) {
    const { updatedAt: _beforeTime, ...previous } = before;
    const { updatedAt: _afterTime, ...current } = after;
    if (!isDeepStrictEqual(previous, current)) {
      await enqueueWebhookEvent(tx, row.brandId, 'contact.updated', {
        contactId,
        departmentId: null,
      });
    }
  }
  return result;
};
