import type { DbTransaction } from '@helpdock/db';
import { ReplyDeliveryHook, type StaffPublicReplyEvent } from '../tickets/reply-delivery.hook.js';
import type { OutboundTelegramService } from './outbound-telegram.service.js';

/**
 * M6-02's half of the reply seam: a public reply on a Telegram ticket is
 * queued to its chat, in the reply's own transaction.
 */
export class TelegramReplyHook extends ReplyDeliveryHook {
  readonly #outbound: OutboundTelegramService;

  constructor(outbound: OutboundTelegramService) {
    super();
    this.#outbound = outbound;
  }

  override async onStaffPublicReply(
    tx: DbTransaction,
    event: StaffPublicReplyEvent,
  ): Promise<void> {
    if (event.ticket.channel !== 'telegram') {
      return;
    }

    await this.#outbound.queueReply(tx, {
      brandId: event.brandId,
      ticket: event.ticket,
      messageId: event.messageId,
    });
  }
}
