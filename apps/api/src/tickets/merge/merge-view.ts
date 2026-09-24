import type { DbTransaction, Ticket as TicketRow } from '@helpdock/db';
import {
  MERGED_MESSAGES_MAX,
  type MergedInto,
  type MergedTicket,
  type TicketLink,
} from '@helpdock/schemas';
import type { MediaRepository } from '../../media/media.repository.js';
import { toTicketMessage } from '../ticket-view.js';
import { TicketRepository } from '../tickets.repository.js';
import { MergeRepository } from './merge.repository.js';
import { unmergeableUntil } from './merge-rules.js';

/**
 * What a ticket read adds for M1-09: the tickets merged into this one with
 * their messages inline, the ticket this one was merged into, and the tickets
 * a split joined to it.
 *
 * A plain function over the caller's transaction, like `ticketing/ticket-tags.ts`,
 * so `TicketsService.find` can call it without the ticket service taking the
 * merge service as a dependency. Both repositories are stateless — every
 * method takes the transaction — so constructing them here costs nothing.
 *
 * **Why the secondary's messages are readable at all.** A merge moves the
 * secondary into the primary's department (`merge.service.ts`), and the
 * `tickets_merged_follow_primary` trigger keeps it there. So whoever may read
 * the primary may read its secondaries' messages and open their attachments
 * under the ordinary department policy: "access follows the primary" (§2.4)
 * is the policy doing what it always does, not a second path that widens it.
 */

export interface MergeView {
  readonly merged: MergedTicket[];
  readonly mergedInto: MergedInto | null;
  readonly related: TicketLink[];
}

const merges = new MergeRepository();
const threads = new TicketRepository();

const linkOf = (ticket: TicketRow): TicketLink => ({
  id: ticket.id,
  number: ticket.number,
  prefix: ticket.prefix,
  subject: ticket.subject,
});

const mergeFacts = (ticket: TicketRow, now: Date) => {
  /* c8 ignore next 3 -- every caller passes a merged ticket, which has `merged_at`. */
  if (ticket.mergedAt === null) {
    throw new Error(`ticket ${ticket.id} is merged but has no merged_at`);
  }

  return {
    mergedAt: ticket.mergedAt.toISOString(),
    mergedById: ticket.mergedById,
    unmergeableUntil: unmergeableUntil(ticket.mergedAt, now)?.toISOString() ?? null,
  };
};

export const readMergeView = async (
  tx: DbTransaction,
  ticket: TicketRow,
  now: Date,
  attachments: MediaRepository,
): Promise<MergeView> => {
  const secondaries = await merges.mergedInto(tx, ticket.id);

  const merged = await Promise.all(
    secondaries.map(async (secondary): Promise<MergedTicket> => {
      const rows = await threads.messagesAfter(tx, secondary.id, 0, MERGED_MESSAGES_MAX);
      const page = rows.slice(0, MERGED_MESSAGES_MAX);
      const files = await attachments.ofMessages(
        tx,
        page.map((message) => message.id),
      );

      return {
        ...linkOf(secondary),
        ...mergeFacts(secondary, now),
        // `merged_into_id` is set on every row `mergedInto` returns.
        mergedIntoId: secondary.mergedIntoId ?? ticket.id,
        systemMessageId: secondary.mergedIntoId === ticket.id ? secondary.mergeMessageId : null,
        messages: page.map((message) => toTicketMessage(message, files.get(message.id))),
        hasMoreMessages: rows.length > MERGED_MESSAGES_MAX,
      };
    }),
  );

  const primary =
    ticket.mergedIntoId === null ? undefined : await merges.link(tx, ticket.mergedIntoId);

  return {
    merged,
    mergedInto: primary === undefined ? null : { ...primary, ...mergeFacts(ticket, now) },
    related: await merges.splitRelated(tx, ticket),
  };
};
