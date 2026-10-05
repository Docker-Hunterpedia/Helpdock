import {
  contacts,
  type Db,
  type DbTransaction,
  departments,
  type NewTelegramBot,
  type NewTelegramDelivery,
  type TelegramBot as TelegramBotRow,
  type TelegramChat as TelegramChatRow,
  type TelegramDelivery as TelegramDeliveryRow,
  telegramBots,
  telegramChats,
  telegramDeliveries,
  ticketStatuses,
  tickets,
  users,
} from '@helpdock/db';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { withAllBrands } from '../tenant/all-brands.js';

/**
 * `telegram_bots`, `telegram_chats` and `telegram_deliveries` (M6).
 *
 * Every method but two takes the caller's transaction, so row-level security
 * decides what it sees. {@link locate} and {@link listAll} answer questions
 * asked before a brand is known — which brand a webhook's bot belongs to, which
 * bots a booting worker polls — as install-scope reads of this one table, the
 * shape `MailboxesRepository.findByAddresses` has.
 */

export interface BotWithNames {
  readonly bot: TelegramBotRow;
  readonly departmentName: string;
  readonly tokenUpdatedByName: string | null;
}

/** Enough to route an update or schedule a poll, without a tenant context. */
export interface BotLocator {
  readonly id: string;
  readonly brandId: string;
}

export class TelegramRepository {
  // ------------------------------------------------------------------- bots

  async list(tx: DbTransaction): Promise<BotWithNames[]> {
    return this.#withNames(tx).orderBy(asc(telegramBots.displayName), asc(telegramBots.id));
  }

  async find(tx: DbTransaction, id: string): Promise<BotWithNames | undefined> {
    const rows = await this.#withNames(tx).where(eq(telegramBots.id, id)).limit(1);
    return rows[0];
  }

  async bot(tx: DbTransaction, id: string): Promise<TelegramBotRow | undefined> {
    const rows = await tx.select().from(telegramBots).where(eq(telegramBots.id, id)).limit(1);
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

  /** Undefined when that bot is already connected, here or in another brand. */
  async insert(tx: DbTransaction, values: NewTelegramBot): Promise<TelegramBotRow | undefined> {
    const rows = await tx
      .insert(telegramBots)
      .values(values)
      .onConflictDoNothing({ target: telegramBots.telegramId })
      .returning();
    return rows[0];
  }

  async update(
    tx: DbTransaction,
    id: string,
    values: Partial<NewTelegramBot>,
  ): Promise<TelegramBotRow | undefined> {
    const rows = await tx
      .update(telegramBots)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(telegramBots.id, id))
      .returning();
    return rows[0];
  }

  async delete(tx: DbTransaction, id: string): Promise<TelegramBotRow | undefined> {
    const rows = await tx.delete(telegramBots).where(eq(telegramBots.id, id)).returning();
    return rows[0];
  }

  // --------------------------------------------------------- install scope

  /**
   * The bot a webhook names, across every brand. Not audited: a stranger
   * posting to the route would otherwise fill the log (the reason
   * `MailboxesRepository.findByAddresses` gives).
   */
  async locate(db: Db, botId: string): Promise<BotLocator | undefined> {
    const rows = await withAllBrands(db, 'telegram.webhook.route', (tx) =>
      tx
        .select({ id: telegramBots.id, brandId: telegramBots.brandId })
        .from(telegramBots)
        .where(eq(telegramBots.id, botId))
        .limit(1),
    );
    return rows[0];
  }

  /** Every bot of every brand: the worker's pollers on boot, and the System page. */
  async listAll(db: Db, principalId: string): Promise<TelegramBotRow[]> {
    return withAllBrands(db, principalId, (tx) =>
      tx.select().from(telegramBots).orderBy(asc(telegramBots.id)),
    );
  }

  // ------------------------------------------------------------------ chats

  async chat(tx: DbTransaction, botId: string, chatId: string) {
    const rows = await tx
      .select()
      .from(telegramChats)
      .where(and(eq(telegramChats.botId, botId), eq(telegramChats.chatId, chatId)))
      .limit(1);
    return rows[0];
  }

  /**
   * The chat row for this bot and chat, created or pointed at `contactId`,
   * locked for the rest of the transaction so two updates from one chat file
   * one after the other rather than opening two tickets.
   */
  async upsertChat(
    tx: DbTransaction,
    input: {
      readonly brandId: string;
      readonly botId: string;
      readonly chatId: string;
      readonly contactId: string;
      readonly at: Date;
      /** The customer's current `@username`; null when they have none. */
      readonly username: string | null;
    },
  ): Promise<TelegramChatRow> {
    const { at, ...values } = input;
    await tx
      .insert(telegramChats)
      .values({ ...values, lastMessageAt: at })
      .onConflictDoUpdate({
        target: [telegramChats.botId, telegramChats.chatId],
        set: { contactId: input.contactId, username: input.username, lastMessageAt: at },
      });
    const rows = await tx
      .select()
      .from(telegramChats)
      .where(and(eq(telegramChats.botId, input.botId), eq(telegramChats.chatId, input.chatId)))
      .for('update');
    const row = rows[0];
    /* c8 ignore next 3 -- written a statement ago in this transaction. */
    if (row === undefined) {
      throw new Error('The chat upsert left no row');
    }
    return row;
  }

  /** M6-04: the customer pressed a language button in this chat. */
  async markLanguageChosen(tx: DbTransaction, chatRowId: string, at: Date): Promise<void> {
    await tx
      .update(telegramChats)
      .set({ languageChosenAt: at })
      .where(eq(telegramChats.id, chatRowId));
  }

  /**
   * The chat a ticket's thread is with, its bot and its contact, for the
   * ticket view (M6-02). The same choice of chat as a reply makes.
   */
  async ticketContext(
    tx: DbTransaction,
    ticket: { readonly id: string; readonly contactId: string | null },
  ) {
    const chat = await this.chatForTicket(tx, ticket);
    if (chat === undefined) {
      return undefined;
    }
    const rows = await tx
      .select({
        botUsername: telegramBots.username,
        name: contacts.name,
        locale: contacts.locale,
      })
      .from(telegramBots)
      .innerJoin(contacts, eq(contacts.id, chat.contactId))
      .where(eq(telegramBots.id, chat.botId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : { chat, ...row };
  }

  /** The Activity card of one bot: its last reply, recent failures and open tickets. */
  async activity(tx: DbTransaction, botId: string, failedSince: Date) {
    const [replies] = await tx
      .select({
        lastReplyAt: sql<Date | null>`max(${telegramDeliveries.sentAt})`.mapWith(
          (value: string | Date | null) => (value === null ? null : new Date(value)),
        ),
        failed:
          sql<number>`count(*) filter (where ${telegramDeliveries.status} = 'failed' and ${telegramDeliveries.failedAt} >= ${failedSince.toISOString()}::timestamptz)`.mapWith(
            Number,
          ),
      })
      .from(telegramDeliveries)
      .where(eq(telegramDeliveries.botId, botId));
    const [open] = await tx
      .select({ count: sql<number>`count(distinct ${tickets.id})`.mapWith(Number) })
      .from(telegramChats)
      .innerJoin(tickets, eq(tickets.id, telegramChats.ticketId))
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(
        and(
          eq(telegramChats.botId, botId),
          isNull(tickets.deletedAt),
          ne(ticketStatuses.systemState, 'closed'),
        ),
      );
    return {
      lastReplyAt: replies?.lastReplyAt ?? null,
      failedSends: replies?.failed ?? 0,
      openTickets: open?.count ?? 0,
    };
  }

  async setChatTicket(tx: DbTransaction, chatRowId: string, ticketId: string): Promise<void> {
    await tx.update(telegramChats).set({ ticketId }).where(eq(telegramChats.id, chatRowId));
  }

  /**
   * Where a reply on this ticket goes: the chat whose conversation it is, or
   * else the chat its contact wrote from last (a ticket filed by hand for a
   * Telegram contact, or one this chat has moved on from).
   */
  async chatForTicket(
    tx: DbTransaction,
    ticket: { readonly id: string; readonly contactId: string | null },
  ): Promise<TelegramChatRow | undefined> {
    const current = await tx
      .select()
      .from(telegramChats)
      .where(eq(telegramChats.ticketId, ticket.id))
      .orderBy(desc(telegramChats.lastMessageAt))
      .limit(1);
    if (current[0] !== undefined || ticket.contactId === null) {
      return current[0];
    }

    const latest = await tx
      .select()
      .from(telegramChats)
      .where(
        and(eq(telegramChats.contactId, ticket.contactId), isNotNull(telegramChats.lastMessageAt)),
      )
      .orderBy(desc(telegramChats.lastMessageAt))
      .limit(1);
    return latest[0];
  }

  // ------------------------------------------------------------- deliveries

  /** Undefined when the reply already has one: a retried request queues nothing twice. */
  async insertDelivery(
    tx: DbTransaction,
    values: NewTelegramDelivery,
  ): Promise<TelegramDeliveryRow | undefined> {
    const rows = await tx
      .insert(telegramDeliveries)
      .values(values)
      .onConflictDoNothing({ target: telegramDeliveries.ticketMessageId })
      .returning();
    return rows[0];
  }

  async delivery(tx: DbTransaction, id: string): Promise<TelegramDeliveryRow | undefined> {
    const rows = await tx
      .select()
      .from(telegramDeliveries)
      .where(eq(telegramDeliveries.id, id))
      .limit(1);
    return rows[0];
  }

  async deliveriesForTicket(tx: DbTransaction, ticketId: string): Promise<TelegramDeliveryRow[]> {
    return tx
      .select()
      .from(telegramDeliveries)
      .where(eq(telegramDeliveries.ticketId, ticketId))
      .orderBy(asc(telegramDeliveries.createdAt));
  }

  /** One part done; `sentMessageId` is null for an attachment that was left out. */
  async recordPart(tx: DbTransaction, id: string, sentMessageId: string | null): Promise<void> {
    await tx
      .update(telegramDeliveries)
      .set({
        partsSent: sql`${telegramDeliveries.partsSent} + 1`,
        ...(sentMessageId === null
          ? {}
          : {
              sentMessageIds: sql`array_append(${telegramDeliveries.sentMessageIds}, ${sentMessageId})`,
            }),
      })
      .where(eq(telegramDeliveries.id, id));
  }

  async markSent(tx: DbTransaction, id: string, at: Date): Promise<void> {
    await tx
      .update(telegramDeliveries)
      .set({ status: 'sent', sentAt: at, lastError: null, failedAt: null })
      .where(eq(telegramDeliveries.id, id));
  }

  async recordFailure(
    tx: DbTransaction,
    id: string,
    failure: {
      readonly attempts: number;
      readonly error: string;
      readonly dead: boolean;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx
      .update(telegramDeliveries)
      .set({
        attempts: failure.attempts,
        lastError: failure.error,
        ...(failure.dead ? { status: 'failed' as const, failedAt: failure.at } : {}),
      })
      .where(and(eq(telegramDeliveries.id, id), ne(telegramDeliveries.status, 'sent')));
  }

  /** Puts failed deliveries back to `queued` for a new round, and returns them. */
  async requeue(tx: DbTransaction, ids: readonly string[]): Promise<TelegramDeliveryRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return tx
      .update(telegramDeliveries)
      .set({ status: 'queued', attempts: 0, lastError: null, failedAt: null })
      .where(and(inArray(telegramDeliveries.id, [...ids]), eq(telegramDeliveries.status, 'failed')))
      .returning();
  }

  // ------------------------------------------------------------------

  #withNames(tx: DbTransaction) {
    return tx
      .select({
        bot: telegramBots,
        departmentName: departments.name,
        tokenUpdatedByName: users.name,
      })
      .from(telegramBots)
      .innerJoin(departments, eq(departments.id, telegramBots.departmentId))
      .leftJoin(users, eq(users.id, telegramBots.tokenUpdatedBy))
      .$dynamic();
  }
}
