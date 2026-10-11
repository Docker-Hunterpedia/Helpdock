import type { DbTransaction } from '@helpdock/db';
import { META_PLATFORMS } from '@helpdock/schemas';
import {
  type ReplyAssertion,
  ReplyDeliveryHook,
  type StaffPublicReplyEvent,
} from '../tickets/reply-delivery.hook.js';
import { MetaFailure } from './meta-failure.js';
import { closedWindowDetails } from './meta-window.js';
import type { OutboundMetaService } from './outbound-meta.service.js';

/**
 * M10-06's half of the reply seam, beside the email and Telegram hooks
 * (ADR 0025, 7 and 8).
 *
 * - **`assertCanDeliver`**, before a staff reply is written: a ticket on
 *   WhatsApp, Messenger or Instagram whose reply window is closed for the
 *   author is refused with `reply-window-closed` (409), carrying the platform,
 *   the customer's last message and when the window closed. Nothing is written.
 * - **`onStaffPublicReply`**, once it is: the reply is queued to its customer.
 *   This is also the only door the assistant's message comes through
 *   (`auto-reply.job.ts` never asks first), so a closed window ends there as a
 *   `refused` delivery with no job, and the message stands.
 */

const META_CHANNELS: ReadonlySet<string> = new Set(META_PLATFORMS);

export class MetaReplyHook extends ReplyDeliveryHook {
  readonly #outbound: OutboundMetaService;

  constructor(outbound: OutboundMetaService) {
    super();
    this.#outbound = outbound;
  }

  override async assertCanDeliver(tx: DbTransaction, event: ReplyAssertion): Promise<void> {
    if (!META_CHANNELS.has(event.ticket.channel)) {
      return;
    }

    const target = await this.#outbound.targetFor(tx, event.ticket, event.personAuthored);
    if (target?.window.state === 'closed') {
      throw new MetaFailure(
        'reply-window-closed',
        closedWindowDetails(target.account.platform, target.conversation, target.window),
      );
    }
  }

  override async onStaffPublicReply(
    tx: DbTransaction,
    event: StaffPublicReplyEvent,
  ): Promise<void> {
    if (!META_CHANNELS.has(event.ticket.channel)) {
      return;
    }

    await this.#outbound.queueReply(tx, {
      brandId: event.brandId,
      ticket: event.ticket,
      messageId: event.messageId,
      personAuthored: event.personAuthored === true,
    });
  }
}
