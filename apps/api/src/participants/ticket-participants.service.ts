import type { DbTransaction } from '@helpdock/db';
import { tickets } from '@helpdock/db';
import type {
  TicketCcRequest,
  TicketParticipantList,
  TicketParticipantSource,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Principal } from '../auth/principal.js';
import { findOrCreateByAddress } from '../contacts/identity.js';
import { activityActorFor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import type { ParticipantsRepository, ParticipantTicket } from './participants.repository.js';

/**
 * A ticket's participants (DOMAIN-RULES §2.5, M1-13): its contact, its CCs and
 * its staff. They decide who may thread into the ticket by email (§4.3) and who
 * receives public replies — both M2's to act on. This service keeps the list.
 *
 * Adding or removing a CC is working the ticket, so it leaves the two rows
 * every ticket change leaves: one in `ticket_activity`, one in `outbox`, in the
 * request's own transaction (DOMAIN-RULES §6). The activity row names contact
 * ids, never addresses, so erasing a contact (§11) has nothing to rewrite
 * there.
 */

export interface ParticipantContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly principal: Principal;
}

export class TicketParticipantsService {
  readonly #repository: ParticipantsRepository;

  constructor(repository: ParticipantsRepository) {
    this.#repository = repository;
  }

  async list(tx: DbTransaction, ticketId: string): Promise<TicketParticipantList> {
    const ticket = await this.#require(tx, ticketId);

    return this.#list(tx, ticket);
  }

  /** An agent types an address into the Participants card. */
  async addCc(
    context: ParticipantContext,
    ticketId: string,
    request: TicketCcRequest,
  ): Promise<TicketParticipantList> {
    const { tx, brandId } = context;
    const ticket = await this.#require(tx, ticketId);
    const { contact, address } = await findOrCreateByAddress(
      tx,
      brandId,
      request.email,
      'email.cc',
    );

    await this.#add(context, ticket, { contactId: contact.id, address, source: 'agent' });

    return this.#list(tx, ticket);
  }

  /**
   * Copies a contact in by id, for the paths that already know who it is:
   * M1-09's ticket merge ("the secondary's contact is added as a CC
   * participant", DOMAIN-RULES §2.4) and M2's `Cc:` line. The address recorded
   * is the contact's own email, verified first; a contact with none is still a
   * participant by name, and threads in through its identity mapping instead
   * (§2.5).
   *
   * Returns false when nothing changed: the contact is the ticket's own, or is
   * already a CC.
   */
  async addCcParticipant(
    context: ParticipantContext,
    ticketId: string,
    contactId: string,
    { source = 'merge' }: { readonly source?: TicketParticipantSource } = {},
  ): Promise<boolean> {
    const ticket = await this.#require(context.tx, ticketId);
    const address = await this.#repository.emailOf(context.tx, contactId);

    return this.#add(context, ticket, { contactId, address, source });
  }

  async removeCc(
    context: ParticipantContext,
    ticketId: string,
    participantId: string,
  ): Promise<TicketParticipantList> {
    const { tx, brandId, principal } = context;
    const ticket = await this.#require(tx, ticketId);
    const removed = await this.#repository.delete(tx, ticketId, participantId);
    if (removed === undefined) {
      throw new NotFoundException('No such participant on this ticket');
    }

    await this.#changed(tx, brandId, principal, ticket, {
      from: { ccContactId: removed.contactId },
    });

    return this.#list(tx, ticket);
  }

  // ------------------------------------------------------------------

  async #add(
    { tx, brandId, principal }: ParticipantContext,
    ticket: ParticipantTicket,
    {
      contactId,
      address,
      source,
    }: {
      readonly contactId: string;
      readonly address: string | null;
      readonly source: TicketParticipantSource;
    },
  ): Promise<boolean> {
    // The contact is a participant already; copying them in as well would
    // send them every reply twice.
    if (contactId === ticket.contactId) {
      return false;
    }

    const inserted = await this.#repository.insert(tx, {
      brandId,
      ticket,
      contactId,
      address,
      source,
      addedBy: principal.type === 'staff' ? principal.id : null,
    });
    if (inserted === undefined) {
      return false;
    }

    await this.#changed(tx, brandId, principal, ticket, { to: { ccContactId: contactId } });

    return true;
  }

  async #changed(
    tx: DbTransaction,
    brandId: string,
    principal: Principal,
    ticket: ParticipantTicket,
    change: { readonly from?: Record<string, unknown>; readonly to?: Record<string, unknown> },
  ): Promise<void> {
    await writeTicketActivity(tx, {
      brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      actor: activityActorFor(principal),
      action: 'ticket.participants.changed',
      ...change,
    });
    // The list orders by `updated_at`, and a new CC is something happening on
    // the ticket, as a tag is.
    await tx.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, ticket.id));
    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.updated, {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
    });
  }

  async #list(tx: DbTransaction, ticket: ParticipantTicket): Promise<TicketParticipantList> {
    const contact =
      ticket.contactId === null
        ? undefined
        : await this.#repository.contactName(tx, ticket.contactId);

    return {
      contact: contact ?? null,
      // A CC who has since become the ticket's own contact — through a contact
      // merge — is listed once, as the contact.
      ccs: (await this.#repository.ccs(tx, ticket.id)).filter((cc) => cc.contactId !== contact?.id),
      staff: await this.#repository.staff(tx, ticket),
    };
  }

  /** The ticket, or a 404 — which is also what "not in your departments" answers. */
  async #require(tx: DbTransaction, ticketId: string): Promise<ParticipantTicket> {
    const ticket = await this.#repository.ticket(tx, ticketId);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }

    return ticket;
  }
}
