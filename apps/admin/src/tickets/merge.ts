import type { RelatedTicket, Ticket, TicketLink, VisibleRelatedTicket } from '@helpdock/schemas';

/**
 * The decisions the merge and split screens make that are not drawing (M1-09,
 * DOMAIN-RULES §2.4), as pure functions so they are tested without a DOM.
 */

const HOUR = 60 * 60 * 1000;

/**
 * Whole hours left to undo a merge, rounded **up**: "23 h left" a minute after
 * the merge, and "1 h left" in its last hour rather than "0 h left" for a
 * button that still works. `null` once it cannot be undone, which is when the
 * button goes.
 */
export const unmergeHoursLeft = (unmergeableUntil: string | null, now: number): number | null => {
  if (unmergeableUntil === null) {
    return null;
  }

  const left = Date.parse(unmergeableUntil) - now;

  return left > 0 ? Math.ceil(left / HOUR) : null;
};

/**
 * What the merge dialog offers as a primary: any ticket the search found except
 * the one being merged, and except one already merged — its state belongs to
 * the ticket it went into, and the api refuses it (`merge-into-merged`).
 */
export const mergeCandidates = (tickets: readonly Ticket[], currentId: string): Ticket[] =>
  tickets.filter((ticket) => ticket.id !== currentId && ticket.mergedIntoId === null);

/**
 * The linked tickets this reader can open, which are the only ones a system
 * message's reference may link to. A hidden one carries no reference to match.
 */
export const visibleLinks = (related: readonly RelatedTicket[]): VisibleRelatedTicket[] =>
  related.filter((link): link is VisibleRelatedTicket => link.visible);

const referenceOf = (ticket: Pick<TicketLink, 'prefix' | 'number'>): string =>
  `${ticket.prefix}-${ticket.number}`;

export type TextSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly ticketId: string };

/**
 * A system message with the references it names turned into links, when the
 * ticket they name is one this reader can open. "Messages split to HD-1043"
 * is written by the api as a sentence in the contact's language; the read
 * carries the related tickets, and this is where the two meet.
 *
 * A reference is matched whole, so `HD-104` never links inside `HD-1043`.
 */
export const linkReferences = (text: string, links: readonly TicketLink[]): TextSegment[] => {
  const byReference = new Map(links.map((link) => [referenceOf(link), link.id]));
  if (byReference.size === 0) {
    return [{ kind: 'text', text }];
  }

  const pattern = new RegExp(
    `(?<![\\w-])(${[...byReference.keys()].map(escapeRegExp).join('|')})(?![\\w-])`,
    'g',
  );
  const segments: TextSegment[] = [];
  let from = 0;

  for (const match of text.matchAll(pattern)) {
    const found = match[1] ?? '';
    const ticketId = byReference.get(found);
    /* c8 ignore next 3 -- the pattern is built from the map's own keys. */
    if (ticketId === undefined) {
      continue;
    }
    if (match.index > from) {
      segments.push({ kind: 'text', text: text.slice(from, match.index) });
    }
    segments.push({ kind: 'link', text: found, ticketId });
    from = match.index + found.length;
  }

  if (from < text.length) {
    segments.push({ kind: 'text', text: text.slice(from) });
  }

  return segments;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
