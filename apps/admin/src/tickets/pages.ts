import type { Ticket, TicketList } from '@helpdock/schemas';

/**
 * What a keyset-paged list adds up to.
 *
 * Paging is keyset, not offset, so a page is "the rows after this one" and the
 * cursor stays correct while people are working (`docs/guides/tickets.md`). One
 * thing it does *not* promise: a ticket replied to between two `load more`
 * clicks rises to the front of an `updated_at` ordering and can therefore
 * appear on a later page as well as an earlier one. Nothing on the server can
 * prevent that and nothing should — it is the list being current — so the
 * browser keeps the first sighting and drops the second, because a row drawn
 * twice is the one thing a person would call a bug.
 */
export const mergePages = (pages: readonly TicketList[]): readonly Ticket[] => {
  const seen = new Set<string>();
  const merged: Ticket[] = [];

  for (const page of pages) {
    for (const ticket of page.tickets) {
      if (!seen.has(ticket.id)) {
        seen.add(ticket.id);
        merged.push(ticket);
      }
    }
  }

  return merged;
};

/**
 * Where the selection goes when `j` or `k` is pressed.
 *
 * Nothing selected means the first row, whichever direction was asked for: the
 * keys are for moving through a list somebody is looking at, and the first
 * press is what starts that. The ends do not wrap, because a list that jumped
 * from the last row to the first would lose somebody's place silently.
 */
export const moveSelection = (
  tickets: readonly Ticket[],
  selectedId: string | null,
  delta: 1 | -1,
): string | null => {
  const first = tickets[0];
  if (first === undefined) {
    return null;
  }

  const index = tickets.findIndex((ticket) => ticket.id === selectedId);
  if (index === -1) {
    return first.id;
  }

  return tickets[Math.min(Math.max(index + delta, 0), tickets.length - 1)]?.id ?? selectedId;
};
