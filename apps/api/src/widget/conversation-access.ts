import type { Ticket as TicketRow, WidgetVisitor } from '@helpdock/db';

/**
 * DOMAIN-RULES §4.1–4.2 as one function: what a visitor may do with a ticket.
 *
 * | The ticket is | The visitor may |
 * |---|---|
 * | one they opened (`visitor_id` is theirs) | read and write |
 * | a widget conversation of the contact a valid signed identity names | read and write |
 * | another channel's ticket of that contact, on a brand that allows it | read only |
 * | anything else — including every ticket of a contact whose address they typed | nothing |
 *
 * The last row is the security property: an email typed into a pre-chat form
 * is a hint, and a hint never opens history (§4.1). There is no path from an
 * address to a ticket here at all — only the server-issued visitor id and the
 * brand-signed contact.
 *
 * "Nothing" is answered as not found, so a guessed conversation id is
 * indistinguishable from one that does not exist.
 */
export type ConversationAccess = 'write' | 'read' | 'none';

export const conversationAccess = (
  ticket: Pick<TicketRow, 'visitorId' | 'contactId' | 'channel' | 'deletedAt'>,
  visitor: Pick<WidgetVisitor, 'id' | 'verifiedContactId'>,
  options: { readonly seesAllChannels: boolean },
): ConversationAccess => {
  if (ticket.deletedAt !== null) {
    return 'none';
  }
  if (ticket.visitorId !== null && ticket.visitorId === visitor.id) {
    return 'write';
  }

  const verified = visitor.verifiedContactId;
  if (verified === null || ticket.contactId !== verified) {
    return 'none';
  }
  if (ticket.channel === 'chat') {
    return 'write';
  }

  return options.seesAllChannels ? 'read' : 'none';
};
