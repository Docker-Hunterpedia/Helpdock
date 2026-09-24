import type { DbTransaction, TicketParticipant as TicketParticipantRow } from '@helpdock/db';
import {
  contactIdentities,
  contacts,
  ticketMessages,
  ticketParticipants,
  tickets,
  users,
} from '@helpdock/db';
import type { TicketCc, TicketParticipantSource } from '@helpdock/schemas';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

/**
 * The reads and writes behind a ticket's participants (M1-13), through the
 * request's own transaction.
 *
 * `ticket_participants` is department-scoped, so a CC of a ticket in another
 * department is a row this transaction cannot see, and an insert against such
 * a ticket is refused by the `ticket_participants_department` trigger before
 * any policy is consulted.
 *
 * A CC's contact may since have been merged into another (M1-13). The row is
 * never rewritten for that — its `address` is what threading compares, and a
 * merge must not change who may write into a ticket — so the read follows
 * `merged_into_id` and shows the survivor instead.
 */

const survivor = alias(contacts, 'survivor');

export interface ParticipantTicket {
  readonly id: string;
  readonly departmentId: string;
  readonly contactId: string | null;
  readonly assigneeId: string | null;
}

export class ParticipantsRepository {
  async ticket(tx: DbTransaction, ticketId: string): Promise<ParticipantTicket | undefined> {
    const rows = await tx
      .select({
        id: tickets.id,
        departmentId: tickets.departmentId,
        contactId: tickets.contactId,
        assigneeId: tickets.assigneeId,
      })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);

    return rows[0];
  }

  /** A contact's name, following a merge to the survivor. */
  async contactName(
    tx: DbTransaction,
    contactId: string,
  ): Promise<{ id: string; name: string } | undefined> {
    const rows = await tx
      .select({
        id: sql<string>`coalesce(${survivor.id}, ${contacts.id})`,
        name: sql<string>`coalesce(${survivor.name}, ${contacts.name})`,
      })
      .from(contacts)
      .leftJoin(survivor, eq(survivor.id, contacts.mergedIntoId))
      .where(eq(contacts.id, contactId))
      .limit(1);

    return rows[0];
  }

  async ccs(tx: DbTransaction, ticketId: string): Promise<TicketCc[]> {
    return tx
      .select({
        id: ticketParticipants.id,
        contactId: sql<string>`coalesce(${survivor.id}, ${contacts.id})`,
        name: sql<string>`coalesce(${survivor.name}, ${contacts.name})`,
        address: ticketParticipants.address,
        source: ticketParticipants.source,
      })
      .from(ticketParticipants)
      .innerJoin(contacts, eq(contacts.id, ticketParticipants.contactId))
      .leftJoin(survivor, eq(survivor.id, contacts.mergedIntoId))
      .where(eq(ticketParticipants.ticketId, ticketId))
      .orderBy(asc(ticketParticipants.createdAt));
  }

  /** The assignee and every staff member who wrote on the ticket, once each. */
  async staff(
    tx: DbTransaction,
    ticket: ParticipantTicket,
  ): Promise<{ userId: string; name: string }[]> {
    const authors = await tx
      .selectDistinct({ userId: users.id, name: users.name })
      .from(ticketMessages)
      .innerJoin(users, sql`${users.id}::text = ${ticketMessages.authorId}`)
      .where(and(eq(ticketMessages.ticketId, ticket.id), eq(ticketMessages.authorType, 'staff')));

    const assignee =
      ticket.assigneeId === null
        ? []
        : await tx
            .select({ userId: users.id, name: users.name })
            .from(users)
            .where(eq(users.id, ticket.assigneeId));

    const byId = new Map([...assignee, ...authors].map((row) => [row.userId, row]));

    return [...byId.values()];
  }

  /** The address a contact would be copied in under: a verified email first. */
  async emailOf(tx: DbTransaction, contactId: string): Promise<string | null> {
    const rows = await tx
      .select({ value: contactIdentities.value })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.contactId, contactId), eq(contactIdentities.kind, 'email')))
      .orderBy(desc(contactIdentities.verified), asc(contactIdentities.createdAt))
      .limit(1);

    return rows[0]?.value ?? null;
  }

  /** Idempotent on the pair: a contact already copied in stays copied in once. */
  async insert(
    tx: DbTransaction,
    values: {
      readonly brandId: string;
      readonly ticket: ParticipantTicket;
      readonly contactId: string;
      readonly address: string | null;
      readonly source: TicketParticipantSource;
      readonly addedBy: string | null;
    },
  ): Promise<TicketParticipantRow | undefined> {
    const inserted = await tx
      .insert(ticketParticipants)
      .values({
        brandId: values.brandId,
        ticketId: values.ticket.id,
        // Overwritten by the trigger with the ticket's own.
        departmentId: values.ticket.departmentId,
        contactId: values.contactId,
        address: values.address,
        source: values.source,
        addedBy: values.addedBy,
      })
      .onConflictDoNothing({
        target: [ticketParticipants.ticketId, ticketParticipants.contactId],
      })
      .returning();

    return inserted[0];
  }

  /**
   * The CC a ticket merge added for this contact, if it is still there. A CC an
   * agent added by hand is `source = 'agent'` and never matches, so undoing a
   * merge cannot take off somebody a person chose to copy in.
   */
  async deleteMergeCc(
    tx: DbTransaction,
    ticketId: string,
    contactId: string,
  ): Promise<TicketParticipantRow | undefined> {
    const deleted = await tx
      .delete(ticketParticipants)
      .where(
        and(
          eq(ticketParticipants.ticketId, ticketId),
          eq(ticketParticipants.contactId, contactId),
          eq(ticketParticipants.source, 'merge'),
        ),
      )
      .returning();

    return deleted[0];
  }

  /**
   * Whether another ticket merged into `primaryId` still brings this contact —
   * in which case unmerging one of them leaves the CC where it is.
   */
  async stillMergedFrom(
    tx: DbTransaction,
    primaryId: string,
    contactId: string,
    exceptTicketId: string,
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.mergedIntoId, primaryId),
          eq(tickets.contactId, contactId),
          ne(tickets.id, exceptTicketId),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  async delete(
    tx: DbTransaction,
    ticketId: string,
    participantId: string,
  ): Promise<TicketParticipantRow | undefined> {
    const deleted = await tx
      .delete(ticketParticipants)
      .where(
        and(eq(ticketParticipants.id, participantId), eq(ticketParticipants.ticketId, ticketId)),
      )
      .returning();

    return deleted[0];
  }
}
