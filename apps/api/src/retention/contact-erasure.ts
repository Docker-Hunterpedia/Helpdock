import { attachments, type DbTransaction, ticketMessages } from '@helpdock/db';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { ContactErasureProvider, ContactErasureResult } from '../contacts/providers.js';
import { enqueueObjectPurge } from '../media/object-purge.js';

/**
 * The half of a contact's erasure that lives on tickets (DOMAIN-RULES §11,
 * M1-14). The contacts service hashes the person; this removes what they left
 * behind, inside the same transaction.
 *
 * **Attachments they sent** are the ones they uploaded, and any attachment on
 * a message they wrote — the second catches a file a channel adapter stored
 * under a system uploader on the contact's behalf. The rows are deleted here
 * and the objects are queued through the outbox (`media/object-purge.ts`), so
 * an erasure that rolls back deletes no bytes.
 *
 * **Message author fields.** A message's author is `(author_type, author_id)`,
 * and for a contact `author_id` is the contact's own uuid: it names nobody,
 * and it points at a row that now holds only hashes, so it stays — the thread
 * still reads "customer" where the customer spoke. What a channel stamped on
 * the message is different: `external_message_id` is an email `Message-ID`
 * (whose right-hand side is the sender's mail host) or a Telegram message id
 * in a chat with that person. Those are cleared. The body stays, as §11 says.
 *
 * Every read runs under the caller's row-level security; erasure is Admin only
 * and an Admin's scope is every department, so nothing of the contact's is out
 * of reach.
 */
export class DbContactErasureProvider implements ContactErasureProvider {
  async eraseTraces(
    tx: DbTransaction,
    brandId: string,
    contactId: string,
  ): Promise<ContactErasureResult> {
    const authoredByContact = and(
      eq(ticketMessages.brandId, brandId),
      eq(ticketMessages.authorType, 'contact'),
      eq(ticketMessages.authorId, contactId),
    );

    const sent = await tx
      .select({
        id: attachments.id,
        brandId: attachments.brandId,
        ticketId: attachments.ticketId,
        s3Key: attachments.s3Key,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.brandId, brandId),
          or(
            and(eq(attachments.uploaderType, 'contact'), eq(attachments.uploaderId, contactId)),
            inArray(
              attachments.messageId,
              tx.select({ id: ticketMessages.id }).from(ticketMessages).where(authoredByContact),
            ),
          ),
        ),
      );

    await enqueueObjectPurge(tx, brandId, sent);
    if (sent.length > 0) {
      await tx.delete(attachments).where(
        inArray(
          attachments.id,
          sent.map((row) => row.id),
        ),
      );
    }

    const rewritten = await tx
      .update(ticketMessages)
      .set({ externalMessageId: null })
      .where(and(authoredByContact, isNotNull(ticketMessages.externalMessageId)))
      .returning({ id: ticketMessages.id });

    return { attachments: sent.length, messages: rewritten.length };
  }
}
