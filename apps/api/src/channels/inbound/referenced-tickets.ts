import { bareMessageId } from '@helpdock/channels';

type ReceivedReference = {
  ticketId: string;
  externalId: string | null;
  importSourceAccountKey: string | null;
};
type SentReference = { ticketId: string; messageId: string };

/** Authoritative deliveries win; ambiguous historical headers cannot select a ticket by row order. */
export function referencedTickets(
  sent: readonly SentReference[],
  received: readonly ReceivedReference[],
) {
  const candidates = new Map<string, { priority: number; tickets: Set<string> }>();
  const add = (header: string | null, ticketId: string, priority: number) => {
    if (header === null) return;
    const id = bareMessageId(header);
    if (id === '') return;
    const current = candidates.get(id);
    if (!current || priority < current.priority)
      candidates.set(id, { priority, tickets: new Set([ticketId]) });
    else if (priority === current.priority) current.tickets.add(ticketId);
  };
  for (const row of sent) add(row.messageId, row.ticketId, 0);
  for (const row of received)
    add(row.externalId, row.ticketId, row.importSourceAccountKey === null ? 1 : 2);
  const resolved = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [id, candidate] of candidates) {
    if (candidate.tickets.size === 1) {
      candidate.tickets.forEach((ticketId) => {
        resolved.set(id, ticketId);
      });
    } else ambiguous.add(id);
  }
  return { tickets: resolved, ambiguous };
}
