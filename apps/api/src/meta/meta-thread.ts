import { escapeHtml } from '@helpdock/channels';
import {
  type DbTransaction,
  type MetaAccount as MetaAccountRow,
  metaDeliveries,
  ticketMessages,
} from '@helpdock/db';
import { and, eq, sql } from 'drizzle-orm';
import type { TicketRepository } from '../tickets/tickets.repository.js';

/**
 * Two things the Meta inbound services do to a thread that are not a customer's
 * message (M10-04): find which ticket a platform message is on, and write a
 * line into it as the system. Reactions, edits and "something Helpdock cannot
 * show" are lines of the second kind (DOMAIN-RULES §4.8).
 */

type Account = Pick<MetaAccountRow, 'id' | 'brandId' | 'platform'>;

/** A ticket, as much of it as a line needs. */
export interface ThreadRef {
  readonly ticketId: string;
  readonly departmentId: string;
}

/**
 * The ticket a message of this account's platform is on, by the id Meta gave
 * it: a customer's message (`ticket_messages.external_message_id`) or one of
 * Helpdock's own replies (`meta_deliveries.platform_message_ids`, which holds
 * the id of every part). Undefined for a message Helpdock never filed or sent.
 */
export const ticketOfMessage = async (
  tx: DbTransaction,
  account: Account,
  messageId: string,
): Promise<ThreadRef | undefined> => {
  const filed = await tx
    .select({ ticketId: ticketMessages.ticketId, departmentId: ticketMessages.departmentId })
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.brandId, account.brandId),
        eq(ticketMessages.channel, account.platform),
        eq(ticketMessages.externalMessageId, messageId),
      ),
    )
    .limit(1);
  if (filed[0] !== undefined) {
    return filed[0];
  }

  const sent = await tx
    .select({ ticketId: metaDeliveries.ticketId, departmentId: metaDeliveries.departmentId })
    .from(metaDeliveries)
    .where(
      and(
        eq(metaDeliveries.accountId, account.id),
        sql`${messageId} = any(${metaDeliveries.platformMessageIds})`,
      ),
    )
    .limit(1);
  return sent[0];
};

export interface SystemLine {
  /** Plain text. It is escaped for the HTML body here, so a customer's words are safe in it. */
  readonly text: string;
  /**
   * What makes this line idempotent: a redelivered event carries the same key and
   * `ticket_messages_external_key` keeps it to one line. It shares the column
   * with the platform's message ids, so it is prefixed with the kind of line.
   * Null when the event has nothing to key on.
   */
  readonly key: string | null;
}

export const writeSystemLine = async (
  tickets: Pick<TicketRepository, 'insertMessage' | 'nextSeq'>,
  tx: DbTransaction,
  account: Account,
  thread: ThreadRef,
  line: SystemLine,
): Promise<void> => {
  await tickets.insertMessage(tx, {
    brandId: account.brandId,
    ticketId: thread.ticketId,
    departmentId: thread.departmentId,
    seq: await tickets.nextSeq(tx, thread.ticketId),
    kind: 'system',
    authorType: 'system',
    authorId: `meta:${account.platform}:${account.id}`,
    bodyHtml: `<p>${escapeHtml(line.text)}</p>`,
    bodyText: line.text,
    channel: account.platform,
    ...(line.key === null ? {} : { externalMessageId: line.key }),
  });
};
