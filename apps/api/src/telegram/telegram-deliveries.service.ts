import { type DbTransaction, tickets } from '@helpdock/db';
import type { TelegramDeliveryList } from '@helpdock/schemas';
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

const requireTicket = async (tx: DbTransaction, ticketId: string): Promise<void> => {
  const rows = await tx
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundException('No such ticket');
  }
};
