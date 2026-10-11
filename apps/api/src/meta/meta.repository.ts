import {
  type Db,
  type DbTransaction,
  departments,
  type MetaAccount as MetaAccountRow,
  type MetaConversation as MetaConversationRow,
  type MetaDelivery as MetaDeliveryRow,
  metaAccounts,
  metaConversations,
  metaDeliveries,
  type NewMetaAccount,
  type NewMetaDelivery,
  ticketStatuses,
  tickets,
  users,
} from '@helpdock/db';
import {
  META_ERROR_MAX_LENGTH,
  type MetaDeliveryStatus,
  type MetaPlatform,
} from '@helpdock/schemas';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { withAllBrands } from '../tenant/all-brands.js';

/**
 * `meta_accounts`, `meta_conversations` and `meta_deliveries` (M10, ADR 0025).
 *
 * Every method but two takes the caller's transaction, so row-level security
 * decides what it sees. {@link locate} and {@link listAll} answer questions
 * asked before a brand is known — which brand a webhook's account belongs to,
 * which accounts a booting worker schedules health checks for — as install-scope
 * reads of this one table, the shape `TelegramRepository.locate` has.
 *
 * The delivery methods are M10-06's, the account methods M10-07's and the
 * conversation methods M10-03 to M10-05's; they are written once here so the
 * three can be built side by side without agreeing on a query by message.
 */

export interface AccountWithNames {
  readonly account: MetaAccountRow;
  readonly departmentName: string;
  readonly tokenUpdatedByName: string | null;
}

/** Enough to route a webhook entry or schedule a check, without a tenant context. */
export interface AccountLocator {
  readonly id: string;
  readonly brandId: string;
  readonly platform: MetaPlatform;
  readonly externalId: string;
}

/** The customer's message that opens or moves a conversation's reply window. */
export interface InboundAnchor {
  /** When Meta says the customer sent it, or when it arrived. */
  readonly at: Date;
  /** The platform's id for it (`wamid.…` or `mid`). */
  readonly messageId: string;
}

export interface ConversationUpsert {
  readonly brandId: string;
  readonly accountId: string;
  readonly customerId: string;
  readonly contactId: string;
  /** WhatsApp: the customer's number in digits. Null leaves what is stored. */
  readonly waId: string | null;
  /** Null leaves what is stored: Meta sends a name with some events and not others. */
  readonly profileName: string | null;
  /** Instagram `@username` without the `@`. Null leaves what is stored. */
  readonly username: string | null;
  /**
   * Present only for a customer's message. Only a customer's message opens a
   * window (ADR 0025, 8), so a write that is not one (a profile refresh, a
   * system line) passes null and leaves the anchor alone.
   */
  readonly inbound: InboundAnchor | null;
}

/** The two reports a platform makes about a message of ours, in the order they happen. */
export type DeliveryProgress = Extract<MetaDeliveryStatus, 'delivered' | 'read'>;

/** The statuses that are still behind `status`: what a report may move forward. */
const BEHIND: Readonly<Record<DeliveryProgress, readonly MetaDeliveryStatus[]>> = {
  delivered: ['queued', 'sent'],
  read: ['queued', 'sent', 'delivered'],
};

/** When a delivery reached each stage, `coalesce`d so a late report never moves one back. */
const progressColumns = (status: DeliveryProgress, at: Date) => {
  const stamp = at.toISOString();
  return {
    status,
    deliveredAt: sql`coalesce(${metaDeliveries.deliveredAt}, ${stamp}::timestamptz)`,
    ...(status === 'read' ? { readAt: sql`${stamp}::timestamptz` } : {}),
  };
};

export class MetaRepository {
  // --------------------------------------------------------------- accounts

  async list(tx: DbTransaction): Promise<AccountWithNames[]> {
    return this.#withNames(tx).orderBy(asc(metaAccounts.displayName), asc(metaAccounts.id));
  }

  async find(tx: DbTransaction, id: string): Promise<AccountWithNames | undefined> {
    const rows = await this.#withNames(tx).where(eq(metaAccounts.id, id)).limit(1);
    return rows[0];
  }

  async account(tx: DbTransaction, id: string): Promise<MetaAccountRow | undefined> {
    const rows = await tx.select().from(metaAccounts).where(eq(metaAccounts.id, id)).limit(1);
    return rows[0];
  }

  async departmentExists(tx: DbTransaction, departmentId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);
    return rows.length > 0;
  }

  /** Undefined when that account is already connected, here or in another brand. */
  async insert(tx: DbTransaction, values: NewMetaAccount): Promise<MetaAccountRow | undefined> {
    const rows = await tx
      .insert(metaAccounts)
      .values(values)
      .onConflictDoNothing({ target: [metaAccounts.platform, metaAccounts.externalId] })
      .returning();
    return rows[0];
  }

  async update(
    tx: DbTransaction,
    id: string,
    values: Partial<NewMetaAccount>,
  ): Promise<MetaAccountRow | undefined> {
    const rows = await tx
      .update(metaAccounts)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(metaAccounts.id, id))
      .returning();
    return rows[0];
  }

  async delete(tx: DbTransaction, id: string): Promise<MetaAccountRow | undefined> {
    const rows = await tx.delete(metaAccounts).where(eq(metaAccounts.id, id)).returning();
    return rows[0];
  }

  /** A webhook for this account was filed. `last_error` stays: health compares the two times. */
  async markEvent(tx: DbTransaction, id: string, at: Date): Promise<void> {
    await tx.update(metaAccounts).set({ lastEventAt: at }).where(eq(metaAccounts.id, id));
  }

  /** The pipeline or Graph failed for this account. Never carries a token. */
  async markError(tx: DbTransaction, id: string, error: string, at: Date): Promise<void> {
    await tx
      .update(metaAccounts)
      .set({ lastError: error.slice(0, META_ERROR_MAX_LENGTH), lastErrorAt: at })
      .where(eq(metaAccounts.id, id));
  }

  // --------------------------------------------------------- install scope

  /**
   * The account a webhook names, across every brand: `(platform, external_id)`
   * is unique across the install (ADR 0025, 5). Not audited: a stranger posting
   * to the route would otherwise fill the log (the reason
   * `TelegramRepository.locate` gives).
   */
  async locate(
    db: Db,
    platform: MetaPlatform,
    externalId: string,
  ): Promise<AccountLocator | undefined> {
    const rows = await withAllBrands(db, 'meta.webhook.route', (tx) =>
      tx
        .select({
          id: metaAccounts.id,
          brandId: metaAccounts.brandId,
          platform: metaAccounts.platform,
          externalId: metaAccounts.externalId,
        })
        .from(metaAccounts)
        .where(and(eq(metaAccounts.platform, platform), eq(metaAccounts.externalId, externalId)))
        .limit(1),
    );
    return rows[0];
  }

  /** Every account of every brand: the worker's health schedule on boot, and the System page. */
  async listAll(db: Db, principalId: string): Promise<MetaAccountRow[]> {
    return withAllBrands(db, principalId, (tx) =>
      tx.select().from(metaAccounts).orderBy(asc(metaAccounts.id)),
    );
  }

  /**
   * Whether another account is connected on the same WhatsApp business account,
   * in any brand. Meta subscribes an app per business account, so the app stays
   * subscribed while any of its numbers is connected (M10-07).
   */
  async sharesBusinessAccount(db: Db, wabaId: string, exceptId: string): Promise<boolean> {
    const rows = await withAllBrands(db, 'meta.waba.shared', (tx) =>
      tx
        .select({ id: metaAccounts.id })
        .from(metaAccounts)
        .where(and(eq(metaAccounts.wabaId, wabaId), ne(metaAccounts.id, exceptId)))
        .limit(1),
    );
    return rows.length > 0;
  }

  // ---------------------------------------------------------- conversations

  async conversation(
    tx: DbTransaction,
    accountId: string,
    customerId: string,
  ): Promise<MetaConversationRow | undefined> {
    const rows = await tx
      .select()
      .from(metaConversations)
      .where(
        and(
          eq(metaConversations.accountId, accountId),
          eq(metaConversations.customerId, customerId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * The conversation row for this account and customer, created or pointed at
   * `contactId`, locked for the rest of the transaction so two webhooks from
   * one customer file one after the other rather than opening two tickets.
   *
   * The window's anchor only moves **forward**: Meta delivers out of order, and
   * a message that arrives late must not shorten the window a newer one opened.
   */
  async upsertConversation(
    tx: DbTransaction,
    input: ConversationUpsert,
  ): Promise<MetaConversationRow> {
    const { inbound } = input;
    await tx
      .insert(metaConversations)
      .values({
        brandId: input.brandId,
        accountId: input.accountId,
        customerId: input.customerId,
        contactId: input.contactId,
        waId: input.waId,
        profileName: input.profileName,
        username: input.username,
        lastInboundAt: inbound?.at ?? null,
        lastInboundMessageId: inbound?.messageId ?? null,
      })
      .onConflictDoUpdate({
        target: [metaConversations.accountId, metaConversations.customerId],
        set: {
          contactId: input.contactId,
          waId: sql`coalesce(excluded.wa_id, ${metaConversations.waId})`,
          profileName: sql`coalesce(excluded.profile_name, ${metaConversations.profileName})`,
          username: sql`coalesce(excluded.username, ${metaConversations.username})`,
          ...(inbound === null
            ? {}
            : {
                // Both read the row as it was, so the id follows the instant.
                lastInboundMessageId: sql`case when excluded.last_inbound_at > coalesce(${metaConversations.lastInboundAt}, '-infinity'::timestamptz) then excluded.last_inbound_message_id else ${metaConversations.lastInboundMessageId} end`,
                lastInboundAt: sql`greatest(excluded.last_inbound_at, ${metaConversations.lastInboundAt})`,
              }),
        },
      });
    const rows = await tx
      .select()
      .from(metaConversations)
      .where(
        and(
          eq(metaConversations.accountId, input.accountId),
          eq(metaConversations.customerId, input.customerId),
        ),
      )
      .for('update');
    const row = rows[0];
    /* c8 ignore next 3 -- written a statement ago in this transaction. */
    if (row === undefined) {
      throw new Error('The conversation upsert left no row');
    }
    return row;
  }

  async setConversationTicket(
    tx: DbTransaction,
    conversationId: string,
    ticketId: string,
  ): Promise<void> {
    await tx
      .update(metaConversations)
      .set({ ticketId })
      .where(eq(metaConversations.id, conversationId));
  }

  /**
   * Where a reply on this ticket goes: the conversation whose ticket it is, or
   * else the one its contact wrote in last (a ticket filed by hand for a Meta
   * contact, or one the conversation has moved on from).
   */
  async conversationForTicket(
    tx: DbTransaction,
    ticket: { readonly id: string; readonly contactId: string | null },
  ): Promise<MetaConversationRow | undefined> {
    const current = await tx
      .select()
      .from(metaConversations)
      .where(eq(metaConversations.ticketId, ticket.id))
      .orderBy(desc(metaConversations.lastInboundAt))
      .limit(1);
    if (current[0] !== undefined || ticket.contactId === null) {
      return current[0];
    }

    const latest = await tx
      .select()
      .from(metaConversations)
      .where(
        and(
          eq(metaConversations.contactId, ticket.contactId),
          isNotNull(metaConversations.lastInboundAt),
        ),
      )
      .orderBy(desc(metaConversations.lastInboundAt))
      .limit(1);
    return latest[0];
  }

  // ------------------------------------------------------------- deliveries

  /** Undefined when the reply already has one: a retried request queues nothing twice. */
  async insertDelivery(
    tx: DbTransaction,
    values: NewMetaDelivery,
  ): Promise<MetaDeliveryRow | undefined> {
    const rows = await tx
      .insert(metaDeliveries)
      .values(values)
      .onConflictDoNothing({ target: metaDeliveries.ticketMessageId })
      .returning();
    return rows[0];
  }

  async delivery(tx: DbTransaction, id: string): Promise<MetaDeliveryRow | undefined> {
    const rows = await tx.select().from(metaDeliveries).where(eq(metaDeliveries.id, id)).limit(1);
    return rows[0];
  }

  async deliveriesForTicket(tx: DbTransaction, ticketId: string): Promise<MetaDeliveryRow[]> {
    return tx
      .select()
      .from(metaDeliveries)
      .where(eq(metaDeliveries.ticketId, ticketId))
      .orderBy(asc(metaDeliveries.createdAt));
  }

  /** One part done; `platformMessageId` is null for an attachment that was left out. */
  async recordPart(tx: DbTransaction, id: string, platformMessageId: string | null): Promise<void> {
    await tx
      .update(metaDeliveries)
      .set({
        partsSent: sql`${metaDeliveries.partsSent} + 1`,
        ...(platformMessageId === null
          ? {}
          : {
              platformMessageIds: sql`array_append(${metaDeliveries.platformMessageIds}, ${platformMessageId})`,
            }),
      })
      .where(eq(metaDeliveries.id, id));
  }

  /**
   * Every part is accepted. A report can beat this: Meta may say `delivered`
   * for the first part while the job is still sending the last, so the status
   * only leaves `queued`, and never goes back from `delivered` or `read`.
   */
  async markSent(tx: DbTransaction, id: string, at: Date): Promise<void> {
    await tx
      .update(metaDeliveries)
      .set({
        status: sql`case when ${metaDeliveries.status} = 'queued' then 'sent'::meta_delivery_status else ${metaDeliveries.status} end`,
        sentAt: at,
        lastError: null,
        errorCode: null,
        failedAt: null,
      })
      .where(
        and(
          eq(metaDeliveries.id, id),
          inArray(metaDeliveries.status, ['queued', 'sent', 'delivered', 'read']),
        ),
      );
  }

  /** The reply window was closed when the job ran: no retry fixes it (ADR 0025, 8). */
  async markRefused(
    tx: DbTransaction,
    id: string,
    refusal: { readonly errorCode: string | null; readonly error: string; readonly at: Date },
  ): Promise<void> {
    await tx
      .update(metaDeliveries)
      .set({
        status: 'refused',
        errorCode: refusal.errorCode,
        lastError: refusal.error.slice(0, META_ERROR_MAX_LENGTH),
        failedAt: refusal.at,
      })
      .where(and(eq(metaDeliveries.id, id), eq(metaDeliveries.status, 'queued')));
  }

  async recordFailure(
    tx: DbTransaction,
    id: string,
    failure: {
      readonly attempts: number;
      readonly error: string;
      readonly errorCode: string | null;
      readonly dead: boolean;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx
      .update(metaDeliveries)
      .set({
        attempts: failure.attempts,
        lastError: failure.error.slice(0, META_ERROR_MAX_LENGTH),
        errorCode: failure.errorCode,
        ...(failure.dead ? { status: 'failed' as const, failedAt: failure.at } : {}),
      })
      .where(and(eq(metaDeliveries.id, id), inArray(metaDeliveries.status, ['queued', 'failed'])));
  }

  /** Puts failed deliveries back to `queued` for a new round, and returns them. */
  async requeue(tx: DbTransaction, ids: readonly string[]): Promise<MetaDeliveryRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return tx
      .update(metaDeliveries)
      .set({ status: 'queued', attempts: 0, lastError: null, errorCode: null, failedAt: null })
      .where(and(inArray(metaDeliveries.id, [...ids]), eq(metaDeliveries.status, 'failed')))
      .returning();
  }

  /**
   * A platform's report on one message of ours, by the id it gave the send.
   * Moves the delivery forward and never back; a report on a message
   * Helpdock did not send, or on one already past it, matches nothing.
   *
   * A reply of several parts has several ids and any one's report moves the
   * delivery, so the row shows the furthest the customer has got.
   */
  async advanceStatus(
    tx: DbTransaction,
    platformMessageId: string,
    status: DeliveryProgress,
    at: Date,
  ): Promise<MetaDeliveryRow | undefined> {
    const rows = await tx
      .update(metaDeliveries)
      .set(progressColumns(status, at))
      .where(
        and(
          sql`${platformMessageId} = any(${metaDeliveries.platformMessageIds})`,
          inArray(metaDeliveries.status, [...BEHIND[status]]),
        ),
      )
      .returning();
    return rows[0];
  }

  /**
   * Messenger's `delivery` and `read` watermarks: every delivery of this
   * conversation sent at or before `watermark` has got there (DOMAIN-RULES
   * §4.8). `sent_at` is when Helpdock recorded Meta's acceptance, which trails
   * the message's own time by the length of the call; a report that names its
   * `mids` is exact and goes through {@link advanceStatus} instead.
   */
  async advanceByWatermark(
    tx: DbTransaction,
    conversationId: string,
    status: DeliveryProgress,
    watermark: Date,
  ): Promise<MetaDeliveryRow[]> {
    return tx
      .update(metaDeliveries)
      .set(progressColumns(status, watermark))
      .where(
        and(
          eq(metaDeliveries.conversationId, conversationId),
          isNotNull(metaDeliveries.sentAt),
          lte(metaDeliveries.sentAt, watermark),
          inArray(metaDeliveries.status, [...BEHIND[status]]),
        ),
      )
      .returning();
  }

  /** The Activity card of one account: its last reply, recent failures and open tickets. */
  async activity(tx: DbTransaction, accountId: string, since: Date) {
    const stamp = since.toISOString();
    const [replies] = await tx
      .select({
        lastReplyAt: sql<Date | null>`max(${metaDeliveries.sentAt})`.mapWith(
          (value: string | Date | null) => (value === null ? null : new Date(value)),
        ),
        failed:
          sql<number>`count(*) filter (where ${metaDeliveries.status} = 'failed' and ${metaDeliveries.failedAt} >= ${stamp}::timestamptz)`.mapWith(
            Number,
          ),
        refused:
          sql<number>`count(*) filter (where ${metaDeliveries.status} = 'refused' and ${metaDeliveries.failedAt} >= ${stamp}::timestamptz)`.mapWith(
            Number,
          ),
      })
      .from(metaDeliveries)
      .where(eq(metaDeliveries.accountId, accountId));
    const [open] = await tx
      .select({ count: sql<number>`count(distinct ${tickets.id})`.mapWith(Number) })
      .from(metaConversations)
      .innerJoin(tickets, eq(tickets.id, metaConversations.ticketId))
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(
        and(
          eq(metaConversations.accountId, accountId),
          isNull(tickets.deletedAt),
          ne(ticketStatuses.systemState, 'closed'),
        ),
      );
    return {
      lastReplyAt: replies?.lastReplyAt ?? null,
      failedSends: replies?.failed ?? 0,
      refusedSends: replies?.refused ?? 0,
      openTickets: open?.count ?? 0,
    };
  }

  // ------------------------------------------------------------------

  #withNames(tx: DbTransaction) {
    return tx
      .select({
        account: metaAccounts,
        departmentName: departments.name,
        tokenUpdatedByName: users.name,
      })
      .from(metaAccounts)
      .innerJoin(departments, eq(departments.id, metaAccounts.departmentId))
      .leftJoin(users, eq(users.id, metaAccounts.tokenUpdatedBy))
      .$dynamic();
  }
}
