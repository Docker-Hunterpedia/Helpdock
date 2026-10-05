import type { DbTransaction, Ticket as TicketRow } from '@helpdock/db';
import type { EmailSenderKey } from '@helpdock/schemas';
import { Injectable } from '@nestjs/common';

/**
 * M2-05's seam in the reply path: a staff member's public reply was written,
 * and whatever channel the ticket is on may have to carry it to the customer.
 *
 * The same shape as `lifecycle/hooks.ts` and `merge/participants.hook.ts`: the
 * default does nothing, and `TicketsModule` replaces it in one line with the
 * email hook (`email/email-reply.hook.ts`). It runs **inside the reply's
 * transaction**, after the message and its activity row, so an email is
 * queued with the reply or not at all; it must not open a transaction or add a
 * job directly (DOMAIN-RULES §6).
 */

export interface StaffPublicReplyEvent {
  readonly brandId: string;
  /** The ticket the reply landed on. */
  readonly ticket: TicketRow;
  readonly messageId: string;
  /** The composer's From choice, as the request carried it. */
  readonly emailFrom?: EmailSenderKey | undefined;
}

@Injectable()
export class ReplyDeliveryHook {
  async onStaffPublicReply(_tx: DbTransaction, _event: StaffPublicReplyEvent): Promise<void> {
    await Promise.resolve();
  }
}

/**
 * Every channel's hook in turn (M2-05's email, M6-02's Telegram). Each decides
 * from the ticket's channel whether the reply is its to carry, so at most one
 * of them queues anything.
 */
export class ChannelReplyDeliveryHooks extends ReplyDeliveryHook {
  readonly #hooks: readonly ReplyDeliveryHook[];

  constructor(hooks: readonly ReplyDeliveryHook[]) {
    super();
    this.#hooks = hooks;
  }

  override async onStaffPublicReply(
    tx: DbTransaction,
    event: StaffPublicReplyEvent,
  ): Promise<void> {
    for (const hook of this.#hooks) {
      await hook.onStaffPublicReply(tx, event);
    }
  }
}
