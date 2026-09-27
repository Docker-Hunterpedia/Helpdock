import type { DbTransaction } from '@helpdock/db';
import { repliesByEmail } from '@helpdock/schemas';
import { ReplyDeliveryHook, type StaffPublicReplyEvent } from '../tickets/reply-delivery.hook.js';
import type { OutboundEmailService } from './outbound-email.service.js';

/**
 * M2-05's half of the reply seam: a public reply on a ticket that answers by
 * email is queued to its contact and CCs, in the reply's own transaction.
 */
export class EmailReplyHook extends ReplyDeliveryHook {
  readonly #outbound: OutboundEmailService;

  constructor(outbound: OutboundEmailService) {
    super();
    this.#outbound = outbound;
  }

  override async onStaffPublicReply(
    tx: DbTransaction,
    event: StaffPublicReplyEvent,
  ): Promise<void> {
    if (!repliesByEmail(event.ticket.channel)) {
      return;
    }

    await this.#outbound.queueReply(tx, {
      brandId: event.brandId,
      ticketId: event.ticket.id,
      messageId: event.messageId,
      senderKey: event.emailFrom,
    });
  }
}
