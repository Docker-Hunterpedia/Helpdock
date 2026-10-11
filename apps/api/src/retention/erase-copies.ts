import {
  aiCalls,
  type DbTransaction,
  metaConversations,
  telegramChats,
  telegramDeliveries,
  tickets,
  webhookDeliveries,
} from '@helpdock/db';
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { erasedIdentityValue } from '../contacts/anonymise.js';

/**
 * Where else a contact's identifiers were copied to, and what an erasure does
 * with each copy (ASVS 8.3.2, DOMAIN-RULES §11). All three run in the erasure's
 * own transaction, under the caller's row-level security.
 */

/**
 * Their Telegram chats. The row is the chat id and the `@username`, so it goes,
 * and a later message from that chat finds no contact and files a new one, as
 * an erased email address does. A reply already queued for the chat keeps its
 * row, with the chat id replaced by the same digest the identity now holds, so
 * the send fails instead of reaching the person.
 */
export const eraseTelegramChats = async (
  tx: DbTransaction,
  brandId: string,
  contactId: string,
): Promise<number> => {
  const chats = await tx
    .delete(telegramChats)
    .where(and(eq(telegramChats.brandId, brandId), eq(telegramChats.contactId, contactId)))
    .returning({ chatId: telegramChats.chatId });
  if (chats.length > 0) {
    await tx
      .update(telegramDeliveries)
      .set({ chatId: erasedIdentityValue(contactId, 'telegram') })
      .where(
        and(
          eq(telegramDeliveries.brandId, brandId),
          inArray(
            telegramDeliveries.chatId,
            chats.map((chat) => chat.chatId),
          ),
        ),
      );
  }
  return chats.length;
};

/**
 * Their WhatsApp, Messenger and Instagram conversations (M10-03). The row holds
 * the platform's id for them, their number, their profile name and their
 * `@username`, so it goes, and a later message from that id finds no contact
 * and files a new one, as an erased email address does.
 *
 * The replies delivered through the conversation go with it: `meta_deliveries`
 * freezes the platform id in `customer_id` and cascades from the conversation,
 * so there is no copy to rewrite as there is for a Telegram chat. A reply that
 * was still queued finds no delivery when its job runs and sends nothing,
 * which is the outcome `eraseTelegramChats` arranges by replacing the id. The
 * thread keeps the reply (§11 keeps ticket bodies) and loses only the platform's
 * report on it.
 */
export const eraseMetaConversations = async (
  tx: DbTransaction,
  brandId: string,
  contactId: string,
): Promise<number> => {
  const conversations = await tx
    .delete(metaConversations)
    .where(and(eq(metaConversations.brandId, brandId), eq(metaConversations.contactId, contactId)))
    .returning({ id: metaConversations.id });
  return conversations.length;
};

/** Which tickets are the contact's, in one place; each caller picks the column it compares. */
const theirTickets = (brandId: string, contactId: string) =>
  and(eq(tickets.brandId, brandId), eq(tickets.contactId, contactId));

/**
 * The redaction maps of the model calls on their tickets: each pairs a
 * placeholder with the email, phone, card or IBAN it replaced, which is the
 * one thing the redaction exists to keep out of the prompt.
 */
export const eraseAiRedactions = async (
  tx: DbTransaction,
  brandId: string,
  contactId: string,
): Promise<number> => {
  const cleared = await tx
    .update(aiCalls)
    .set({ redactions: null })
    .where(
      and(
        eq(aiCalls.brandId, brandId),
        isNotNull(aiCalls.redactions),
        inArray(
          aiCalls.ticketId,
          tx.select({ id: tickets.id }).from(tickets).where(theirTickets(brandId, contactId)),
        ),
      ),
    )
    .returning({ id: aiCalls.id });
  return cleared.length;
};

/**
 * The payloads webhooks were sent with, frozen into the delivery log: the
 * contact's own record, their tickets, and the survey on a ticket of theirs.
 * Deleted whole, pending ones too, because the payload cannot be emptied and a
 * delivery without one cannot be sent; the delivery job skips a row it cannot
 * find.
 */
export const eraseWebhookPayloads = async (
  tx: DbTransaction,
  brandId: string,
  contactId: string,
): Promise<number> => {
  const payloadText = (path: string) =>
    sql<string>`${webhookDeliveries.payload} #>> ${path}::text[]`;
  const deleted = await tx
    .delete(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.brandId, brandId),
        or(
          eq(payloadText('{data,contact,id}'), contactId),
          eq(payloadText('{data,ticket,contactId}'), contactId),
          inArray(
            payloadText('{data,survey,ticketId}'),
            tx
              .select({ id: sql<string>`${tickets.id}::text` })
              .from(tickets)
              .where(theirTickets(brandId, contactId)),
          ),
        ),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return deleted.length;
};
