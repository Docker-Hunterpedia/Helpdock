import { type DbTransaction, tickets } from '@helpdock/db';
import type { TelegramDeliveryList, TelegramTicketContextResponse } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { OutboundTelegramService } from './outbound-telegram.service.js';
import type { TelegramRepository } from './telegram.repository.js';
import { toTelegramDelivery } from './telegram-view.js';

/**
 * The ticket view's Telegram half (M6-02): whether each agent reply reached
 * the chat, and "Retry" for one that did not. Both run in the request's
 * transaction, so a ticket outside the reader's departments is not found.
 */
export class TelegramDeliveriesService {
  readonly #repository: TelegramRepository;
  readonly #outbound: OutboundTelegramService;

  constructor(repository: TelegramRepository, outbound: OutboundTelegramService) {
    this.#repository = repository;
    this.#outbound = outbound;
  }

  async list(tx: DbTransaction, ticketId: string): Promise<TelegramDeliveryList> {
    await requireTicket(tx, ticketId);
    const rows = await this.#repository.deliveriesForTicket(tx, ticketId);
    return { items: rows.map(toTelegramDelivery) };
  }

  /**
   * The chat the thread is with and whether each reply reached it, in one
   * read for the ticket view. A ticket no chat belongs to answers a null
   * context, so the view draws nothing Telegram for it.
   */
  async ticketContext(tx: DbTransaction, ticketId: string): Promise<TelegramTicketContextResponse> {
    const ticket = await requireTicket(tx, ticketId);
    const found = await this.#repository.ticketContext(tx, ticket);
    const { items } = await this.list(tx, ticketId);
    return {
      context:
        found === undefined
          ? null
          : {
              bot: { id: found.chat.botId, username: found.botUsername },
              chatId: found.chat.chatId,
              username: found.chat.username,
              name: found.name,
              locale: found.locale,
              languageChosenAt: found.chat.languageChosenAt?.toISOString() ?? null,
            },
      deliveries: items,
    };
  }

  /** Puts a failed reply back in the queue; one that is queued or sent is left alone. */
  async retry(
    tx: DbTransaction,
    brandId: string,
    ticketId: string,
    deliveryId: string,
  ): Promise<void> {
    await requireTicket(tx, ticketId);
    const delivery = await this.#repository.delivery(tx, deliveryId);
    if (delivery?.ticketId !== ticketId) {
      throw new NotFoundException('No such delivery on this ticket');
    }
    await this.#outbound.retry(tx, brandId, [deliveryId]);
  }
}

const requireTicket = async (
  tx: DbTransaction,
  ticketId: string,
): Promise<{ id: string; contactId: string | null }> => {
  const rows = await tx
    .select({ id: tickets.id, contactId: tickets.contactId })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
    .limit(1);
  const ticket = rows[0];
  if (ticket === undefined) {
    throw new NotFoundException('No such ticket');
  }
  return ticket;
};
