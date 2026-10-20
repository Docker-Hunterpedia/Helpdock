import {
  auditLog,
  brands,
  contacts,
  type DbTransaction,
  type NewTicketStatus,
  type TicketMessage as TicketMessageRow,
  type Ticket as TicketRow,
  type TicketStatus as TicketStatusRow,
  ticketMessages,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';
import { type BrandSettings, parseBrandSettings } from '@helpdock/schemas';
import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm';

/**
 * Every statement the lifecycle and the status list make.
 *
 * It is a second repository beside `tickets.repository.ts` rather than more
 * methods in it, for one reason: the reads here answer *lifecycle* questions —
 * which row plays the part of "Awaiting customer", what this brand's reply
 * behaviour is, how many tickets a status would strand — and keeping them
 * together is what lets the service read as the transition table does.
 *
 * The same rule as the other repository holds throughout: **nothing filters by
 * brand or department**. The request's transaction carries the scope and the
 * policies apply it (DOMAIN-RULES §1.3). `brands` is the one exception, because
 * it is a global table with no policy, so its reads name the id.
 */
export class TicketLifecycleRepository {
  // ----------------------------------------------------------------- statuses

  /**
   * The status a new or reopened ticket lands in (§2.2). It is `is_default`,
   * never a name: a brand that renamed Open to New changed a label.
   */
  async defaultOpenStatus(tx: DbTransaction): Promise<TicketStatusRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.isDefault, true))
      .orderBy(asc(ticketStatuses.sortOrder))
      .limit(1);

    return rows[0];
  }

  /**
   * The status an agent reply moves a ticket to when the brand toggle is on
   * (§2.1, §2.2).
   *
   * Found by its **flag**, not by its name or its id: §2.1 defines Awaiting
   * customer as the status carrying `awaiting_customer`, and a brand may rename
   * it or add another. System rows sort first so the seeded one wins when a
   * brand has added a second awaiting-customer status of its own.
   */
  async awaitingCustomerStatus(tx: DbTransaction): Promise<TicketStatusRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.awaitingCustomer, true))
      .orderBy(desc(ticketStatuses.isSystem), asc(ticketStatuses.sortOrder))
      .limit(1);

    return rows[0];
  }

  /**
   * The status "Mark as spam" moves a ticket to (§2.2, M1-11). Found by
   * `is_spam`, which a unique index keeps to one row per brand; never by name.
   */
  async spamStatus(tx: DbTransaction): Promise<TicketStatusRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.isSpam, true))
      .limit(1);

    return rows[0];
  }

  async listStatuses(tx: DbTransaction): Promise<TicketStatusRow[]> {
    return tx
      .select()
      .from(ticketStatuses)
      .orderBy(asc(ticketStatuses.sortOrder), asc(ticketStatuses.name));
  }

  async findStatus(tx: DbTransaction, statusId: string): Promise<TicketStatusRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.id, statusId))
      .limit(1);

    return rows[0];
  }

  /** Case-insensitively, because the picker is the only place anybody reads one. */
  async statusNameTaken(tx: DbTransaction, name: string, exceptId?: string): Promise<boolean> {
    const sameName = sql`lower(${ticketStatuses.name}) = lower(${name})`;
    const rows = await tx
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(exceptId === undefined ? sameName : and(sameName, ne(ticketStatuses.id, exceptId)))
      .limit(1);

    return rows.length > 0;
  }

  async countStatuses(tx: DbTransaction): Promise<number> {
    const rows = await tx.select({ total: count() }).from(ticketStatuses);

    return rows[0]?.total ?? 0;
  }

  async nextStatusSortOrder(tx: DbTransaction): Promise<number> {
    const rows = await tx
      .select({ highest: sql<number>`coalesce(max(${ticketStatuses.sortOrder}), -1)` })
      .from(ticketStatuses);

    return (rows[0]?.highest ?? -1) + 1;
  }

  async insertStatus(tx: DbTransaction, values: NewTicketStatus): Promise<TicketStatusRow> {
    const rows = await tx.insert(ticketStatuses).values(values).returning();

    const row = rows[0];
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The status insert returned no row');
    }

    return row;
  }

  async updateStatus(
    tx: DbTransaction,
    statusId: string,
    values: Partial<NewTicketStatus>,
  ): Promise<TicketStatusRow | undefined> {
    const rows = await tx
      .update(ticketStatuses)
      .set(values)
      .where(eq(ticketStatuses.id, statusId))
      .returning();

    return rows[0];
  }

  async deleteStatus(tx: DbTransaction, statusId: string): Promise<void> {
    await tx.delete(ticketStatuses).where(eq(ticketStatuses.id, statusId));
  }

  /** Clears `is_default` everywhere but `statusId`; the caller then sets it there. */
  async clearDefaultStatus(tx: DbTransaction, exceptId: string): Promise<void> {
    await tx
      .update(ticketStatuses)
      .set({ isDefault: false })
      .where(and(eq(ticketStatuses.isDefault, true), ne(ticketStatuses.id, exceptId)));
  }

  async setStatusOrder(tx: DbTransaction, statusId: string, sortOrder: number): Promise<void> {
    await tx.update(ticketStatuses).set({ sortOrder }).where(eq(ticketStatuses.id, statusId));
  }

  // ------------------------------------------------------------------ tickets

  /**
   * How many tickets a status would strand. Soft-deleted ones are counted:
   * they still point at the row, so deleting it would leave a foreign key with
   * nothing behind it however invisible the ticket is.
   */
  async countTicketsWithStatus(tx: DbTransaction, statusId: string): Promise<number> {
    const rows = await tx
      .select({ total: count() })
      .from(tickets)
      .where(eq(tickets.statusId, statusId));

    return rows[0]?.total ?? 0;
  }

  /**
   * Moves every ticket off a status that is being deleted, and returns their
   * ids so the caller can write an activity row on each and tell the queues.
   *
   * `closed_at` is left alone. The fallback is the brand's default *open*
   * status, so a closed ticket moved onto it is a reopen — but a status being
   * deleted is a configuration change, not a customer coming back, and §3.5's
   * clocks are not restarted for it. The activity row says what happened.
   */
  async moveTicketsToStatus(
    tx: DbTransaction,
    fromStatusId: string,
    toStatusId: string,
  ): Promise<{ id: string; departmentId: string }[]> {
    return tx
      .update(tickets)
      .set({ statusId: toStatusId, updatedAt: new Date() })
      .where(eq(tickets.statusId, fromStatusId))
      .returning({ id: tickets.id, departmentId: tickets.departmentId });
  }

  /**
   * A message already stored under this `client_id` on a ticket that continues
   * `parentTicketId`.
   *
   * It is the second half of the retry rule in DOMAIN-RULES §7. The first half
   * — the same `client_id` on the ticket that was written to — is
   * `TicketRepository.findMessageByClientId`. This one exists because a reply
   * to a closed ticket may have landed on a *new* ticket (§2.3), and without it
   * a retried send would create a second continuation.
   */
  async findContinuationMessage(
    tx: DbTransaction,
    parentTicketId: string,
    clientId: string,
  ): Promise<TicketMessageRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketMessages)
      .innerJoin(tickets, eq(tickets.id, ticketMessages.ticketId))
      .where(and(eq(tickets.parentId, parentTicketId), eq(ticketMessages.clientId, clientId)))
      .limit(1);

    return rows[0]?.ticket_messages;
  }

  /** The tickets that continue this one, newest first. The thread links to them. */
  async continuationOf(tx: DbTransaction, parentTicketId: string): Promise<TicketRow | undefined> {
    const rows = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.parentId, parentTicketId))
      .orderBy(desc(tickets.createdAt))
      .limit(1);

    return rows[0];
  }

  // ------------------------------------------------------------------- brands

  /**
   * The brand's reply behaviour. `brands` is global and has no policy, so the
   * id is named; the caller only ever passes the brand the permission guard
   * resolved.
   */
  async brandSettings(tx: DbTransaction, brandId: string): Promise<BrandSettings | undefined> {
    const rows = await tx
      .select({ settings: brands.settings })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    const row = rows[0];
    return row === undefined ? undefined : parseBrandSettings(row.settings);
  }

  async updateBrandSettings(
    tx: DbTransaction,
    brandId: string,
    settings: BrandSettings,
  ): Promise<void> {
    await tx.update(brands).set({ settings }).where(eq(brands.id, brandId));
  }

  /**
   * Which language to write a system message in: the contact's if they have
   * told us, otherwise the brand's default (`packages/db/src/schema/contacts.ts`
   * says why a null is not the same fact as "English").
   */
  async localeForContact(
    tx: DbTransaction,
    brandId: string,
    contactId: string | null,
  ): Promise<Locale> {
    if (contactId !== null) {
      const rows = await tx
        .select({ locale: contacts.locale })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);

      const locale = rows[0]?.locale;
      if (locale != null) {
        return locale;
      }
    }

    const brand = await tx
      .select({ defaultLocale: brands.defaultLocale })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    return brand[0]?.defaultLocale ?? 'en';
  }

  // -------------------------------------------------------------------- audit

  /**
   * The audited half of an escalation, and of the settings writes.
   *
   * `audit_log` is brand-scoped and not department-scoped, so this row is
   * written under the request's own scope even when the ticket has just moved
   * somewhere the actor cannot read — which is the point: the actor can no
   * longer see the ticket, and the trail is how anybody finds out where it
   * went.
   */
  async writeAudit(
    tx: DbTransaction,
    entry: {
      readonly brandId: string;
      readonly actorType: 'staff' | 'apikey' | 'system' | 'visitor';
      readonly actorId: string;
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string;
      readonly meta?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId: entry.brandId,
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      meta: entry.meta ?? {},
    });
  }
}
