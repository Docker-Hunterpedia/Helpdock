import type { DbTransaction, TelegramDelivery } from '@helpdock/db';
import type { TelegramRepository } from './telegram.repository.js';
import { enqueueTelegramReply } from './telegram-events.js';

/**
 * Asks for an agent's reply to reach a Telegram chat, in the reply's own
 * transaction (M6-02): one `telegram_deliveries` row and one `telegram.reply`
 * outbox row, committed with the reply or not at all (DOMAIN-RULES §6).
 * Nothing here talks to Telegram.
 */
export class OutboundTelegramService {
  readonly #repository: TelegramRepository;

  constructor(repository: TelegramRepository) {
    this.#repository = repository;
  }

  /**
   * Nothing is queued for a ticket no chat belongs to — one filed by hand for
   * a contact who never wrote to a bot. The reply itself stands.
   */
  async queueReply(
    tx: DbTransaction,
    input: {
      readonly brandId: string;
      readonly ticket: {
        readonly id: string;
        readonly contactId: string | null;
        readonly departmentId: string;
      };
      readonly messageId: string;
    },
  ): Promise<TelegramDelivery | undefined> {
    const chat = await this.#repository.chatForTicket(tx, input.ticket);
    if (chat === undefined) {
      return undefined;
    }

    const delivery = await this.#repository.insertDelivery(tx, {
      brandId: input.brandId,
      departmentId: input.ticket.departmentId,
      ticketId: input.ticket.id,
      ticketMessageId: input.messageId,
      botId: chat.botId,
      chatId: chat.chatId,
    });
    if (delivery !== undefined) {
      await enqueueTelegramReply(tx, input.brandId, delivery.id);
    }

    return delivery;
  }

  /** "Retry": failed deliveries back in the queue, with the parts already sent kept as sent. */
  async retry(tx: DbTransaction, brandId: string, deliveryIds: readonly string[]): Promise<number> {
    const requeued = await this.#repository.requeue(tx, deliveryIds);
    for (const delivery of requeued) {
      await enqueueTelegramReply(tx, brandId, delivery.id);
    }
    return requeued.length;
  }
}
