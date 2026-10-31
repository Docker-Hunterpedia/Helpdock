import { z } from 'zod';

/**
 * M14-26. The brand's mailboxes as the ticket filters name them: what the
 * Filter popover and the view editor offer for "Mailbox". Mailboxes are brand
 * configuration, readable by anyone who reads tickets, like departments; the
 * connection settings behind them stay behind `brand:manage`.
 */
export const ticketMailboxSchema = z.object({
  id: z.uuid(),
  address: z.string(),
  displayName: z.string(),
  departmentId: z.uuid(),
});
export type TicketMailbox = z.infer<typeof ticketMailboxSchema>;

export const ticketMailboxListSchema = z.object({ mailboxes: z.array(ticketMailboxSchema) });
export type TicketMailboxList = z.infer<typeof ticketMailboxListSchema>;
