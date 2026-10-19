import type { Locale } from '@helpdock/i18n';
import type { ContactTimeline, ContactTimelineItem } from '@helpdock/schemas';
import { formatDay, formatDayMonth } from '../../ui/format.js';

/** How many previous tickets the contact card lists; the contact page has the rest. */
export const PREVIOUS_TICKETS_SHOWN = 3;

/** What the DetailsPanel's Previous tickets section draws (`Admin/Ticket-ContactHistory`). */
export interface PreviousTickets {
  /** The newest of the others, at most {@link PREVIOUS_TICKETS_SHOWN}. */
  readonly shown: readonly ContactTimelineItem[];
  /** Every ticket of the contact this reader may see, except the open one. */
  readonly count: number;
  /** The contact's tickets in departments the reader is not in (DOMAIN-RULES §1.2). */
  readonly hiddenCount: number;
}

/**
 * A contact's other tickets, as seen from one of them.
 *
 * `items` is a page and `visibleCount` is the whole, so the count does not stop
 * where the page does. When the page is the whole, the count is the page less
 * this ticket; when it is not, this ticket is still one of the visible ones —
 * the reader has it open — so it is the whole less one.
 */
export const previousTickets = (
  timeline: Pick<ContactTimeline, 'items' | 'visibleCount' | 'hiddenCount'>,
  ticketId: string,
): PreviousTickets => {
  const others = timeline.items
    .filter((item) => item.id !== ticketId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const complete = timeline.items.length >= timeline.visibleCount;

  return {
    shown: others.slice(0, PREVIOUS_TICKETS_SHOWN),
    count: complete ? others.length : Math.max(0, timeline.visibleCount - 1),
    hiddenCount: timeline.hiddenCount,
  };
};

/** `12 Oct` this year, `12 Oct 2025` before it, so an old ticket does not pass for a recent one. */
export const previousTicketDate = (iso: string, locale: Locale, now: number): string =>
  new Date(iso).getFullYear() === new Date(now).getFullYear()
    ? formatDayMonth(iso, locale)
    : formatDay(iso, locale);
