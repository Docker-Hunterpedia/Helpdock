import type { DbTransaction } from '@helpdock/db';
import type { ContactStats, ContactTimelineItem } from '@helpdock/schemas';

/**
 * The two things the contact screens need from tickets, and nothing else.
 *
 * M1-04 ships before M1-02, so there is no `tickets` table to read. That is not
 * a reason to ship a contact screen with a hole in it, and it is not a reason
 * to let the contacts service learn the ticket schema later: the screens are
 * built against these shapes now, the null implementations below answer "none
 * yet", and the ticket milestone replaces the providers in
 * `ContactsModule.forRoot` without touching a controller, a view or a test.
 *
 * Both take the request's own transaction, so a real implementation reads
 * tickets through the same row-level security the rest of the request runs
 * under — which is what makes `hiddenCount` correct rather than optimistic.
 */

/** Zeroes and nulls: a contact nobody has a ticket for looks exactly like this. */
export const EMPTY_CONTACT_STATS: ContactStats = Object.freeze({
  openTickets: 0,
  totalTickets: 0,
  csat: null,
  averageFirstReplySeconds: null,
  lastTicketAt: null,
});

export interface TicketStatsProvider {
  /**
   * Stats per contact, keyed by contact id. A contact with no tickets may be
   * absent from the map; the caller falls back to {@link EMPTY_CONTACT_STATS}.
   *
   * It takes the whole page at once rather than one contact at a time, because
   * a list of fifty rows must not be fifty queries.
   */
  forContacts(
    tx: DbTransaction,
    brandId: string,
    contactIds: readonly string[],
  ): Promise<ReadonlyMap<string, ContactStats>>;

  /**
   * The contacts of `candidates` that have at least one open ticket the caller
   * may see, for the "Has open tickets" filter. `null` means the provider
   * cannot answer yet, and the filter is then a no-op rather than a lie that
   * hides everybody.
   */
  withOpenTickets(
    tx: DbTransaction,
    brandId: string,
    candidates: readonly string[],
  ): Promise<readonly string[] | null>;
}

export interface ContactTimelineResult {
  readonly items: readonly ContactTimelineItem[];
  /**
   * How many tickets of this contact the viewer's departments exclude
   * (DOMAIN-RULES §1.2). It is a count and never an identifier: the agent
   * learns that history exists, and nothing about what is in it.
   */
  readonly hiddenCount: number;
}

export interface ContactTimelineProvider {
  forContact(tx: DbTransaction, brandId: string, contactId: string): Promise<ContactTimelineResult>;
}

/** Until M1-02: every contact has no tickets, and none are hidden. */
export class NoTicketStatsProvider implements TicketStatsProvider {
  forContacts(): Promise<ReadonlyMap<string, ContactStats>> {
    return Promise.resolve(new Map());
  }

  withOpenTickets(): Promise<readonly string[] | null> {
    return Promise.resolve(null);
  }
}

export class NoContactTimelineProvider implements ContactTimelineProvider {
  forContact(): Promise<ContactTimelineResult> {
    return Promise.resolve({ items: [], hiddenCount: 0 });
  }
}

/**
 * What an erasure removes outside the contact's own rows (DOMAIN-RULES §11,
 * M1-14): "deletes attachments they sent, rewrites message author fields". It
 * is a seam for the same reason as the two above — those rows are the ticket
 * schema's, and the contacts service does not learn it.
 *
 * It runs in the erasure's own transaction, so the traces go with the hashes
 * or not at all.
 */
export interface ContactErasureResult {
  /** Attachment rows deleted; their objects are queued for deletion with them. */
  readonly attachments: number;
  /** Messages the contact wrote whose channel-level author trace was cleared. */
  readonly messages: number;
}

export interface ContactErasureProvider {
  eraseTraces(tx: DbTransaction, brandId: string, contactId: string): Promise<ContactErasureResult>;
}

/** Nothing outside the contact's own rows: a brand with no tickets has no traces. */
export class NoContactErasureProvider implements ContactErasureProvider {
  eraseTraces(): Promise<ContactErasureResult> {
    return Promise.resolve({ attachments: 0, messages: 0 });
  }
}

export const TICKET_STATS_PROVIDER = Symbol('helpdock.ticket-stats-provider');
export const CONTACT_ERASURE_PROVIDER = Symbol('helpdock.contact-erasure-provider');
export const CONTACT_TIMELINE_PROVIDER = Symbol('helpdock.contact-timeline-provider');
