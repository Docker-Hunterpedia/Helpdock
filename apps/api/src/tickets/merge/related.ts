import type { Ticket as TicketRow } from '@helpdock/db';
import type { RelatedTicket, TicketRelation } from '@helpdock/schemas';
import { toTicketStatus } from '../ticket-view.js';
import type { TicketWithStatus } from '../tickets.repository.js';

/**
 * The details panel's Linked tickets (M1-15 part 2), from the ticket being read
 * and the linked rows the caller's transaction could see.
 *
 * **Why a hidden entry never leaks.** A link the read ticket names itself —
 * its `parentId`, `mergedIntoId` or `splitFromId` — is already on the wire as
 * an id, so saying "there is a ticket here you cannot open" tells the reader
 * nothing new. What it must not say is *which* ticket, or whether it is in
 * another department or deleted: those are the §1.2 "indistinguishable from
 * nonexistent" facts, and a hidden entry carries its relation alone. A link
 * only the *other* ticket names (merged into this one, split from it) is found
 * by a query under the caller's scope, so one they cannot see is not found and
 * not mentioned.
 */

/** The panel's order: where this ticket came from, then where its work went. */
const ORDER: readonly TicketRelation[] = [
  'parent',
  'mergedInto',
  'mergedFrom',
  'splitFrom',
  'splitTo',
];

const visible = (
  relation: TicketRelation,
  { ticket, status }: TicketWithStatus,
): RelatedTicket => ({
  visible: true,
  relation,
  id: ticket.id,
  number: ticket.number,
  prefix: ticket.prefix,
  subject: ticket.subject,
  status: toTicketStatus(status),
});

export const relatedTicketsOf = (
  ticket: TicketRow,
  rows: readonly TicketWithStatus[],
): RelatedTicket[] => {
  const byId = new Map(rows.map((row) => [row.ticket.id, row]));

  const named = (relation: TicketRelation, id: string | null): RelatedTicket[] => {
    if (id === null) {
      return [];
    }
    const row = byId.get(id);

    return [row === undefined ? { visible: false, relation } : visible(relation, row)];
  };

  const naming = (relation: TicketRelation, matches: (row: TicketRow) => boolean) =>
    rows.filter((row) => matches(row.ticket)).map((row) => visible(relation, row));

  const byRelation: Record<TicketRelation, RelatedTicket[]> = {
    parent: named('parent', ticket.parentId),
    mergedInto: named('mergedInto', ticket.mergedIntoId),
    mergedFrom: naming('mergedFrom', (row) => row.mergedIntoId === ticket.id),
    splitFrom: named('splitFrom', ticket.splitFromId),
    splitTo: naming('splitTo', (row) => row.splitFromId === ticket.id),
  };

  return ORDER.flatMap((relation) => byRelation[relation]);
};
