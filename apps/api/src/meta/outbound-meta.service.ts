import type { DbTransaction, MetaAccount, MetaConversation, MetaDelivery } from '@helpdock/db';
import type { MetaRepository } from './meta.repository.js';
import { enqueueMetaReply } from './meta-events.js';
import { conversationWindow, type ReplyWindow, windowClosedCode } from './meta-window.js';

/**
 * Asks for an agent's reply to reach a WhatsApp, Messenger or Instagram
 * customer, in the reply's own transaction (M10-06): one `meta_deliveries` row
 * and one `meta.reply` outbox row, committed with the reply or not at all
 * (DOMAIN-RULES §6, ADR 0025, 7). Nothing here talks to Graph.
 */

/** What a delivery Helpdock refused itself says, in the words of `last_error`. */
export const WINDOW_CLOSED_NOTE = 'The reply window had closed, so the reply was not sent';

/** The ticket facts a reply is routed by. */
export interface MetaReplyTicket {
  readonly id: string;
  readonly contactId: string | null;
  readonly departmentId: string;
}

/** Where a ticket's reply goes, and whether it may go there now. */
export interface MetaReplyTarget {
  readonly conversation: MetaConversation;
  readonly account: MetaAccount;
  readonly window: ReplyWindow;
}

export class OutboundMetaService {
  readonly #repository: MetaRepository;
  readonly #now: () => Date;

  constructor(repository: MetaRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  /**
   * The conversation a reply on this ticket answers, its account and the window
   * for the author, or undefined for a ticket no conversation belongs to: one
   * filed by hand for a contact who never wrote to an account.
   */
  async targetFor(
    tx: DbTransaction,
    ticket: MetaReplyTicket,
    personAuthored: boolean,
  ): Promise<MetaReplyTarget | undefined> {
    const conversation = await this.#repository.conversationForTicket(tx, ticket);
    if (conversation === undefined) {
      return undefined;
    }
    const account = await this.#repository.account(tx, conversation.accountId);
    /* c8 ignore next 3 -- the conversation's account is a foreign key that cascades. */
    if (account === undefined) {
      return undefined;
    }

    return {
      conversation,
      account,
      window: conversationWindow({ conversation, account, personAuthored, now: this.#now() }),
    };
  }

  /**
   * The compose-time check has already refused a person's reply the window
   * forbids (`MetaReplyHook.assertCanDeliver`). What reaches here closed is a
   * message that had no such check: the assistant's, or a reply the clock moved
   * past the window between the check and this write. The message stands, the
   * delivery is written `refused` with no outbox row, and the thread says why.
   */
  async queueReply(
    tx: DbTransaction,
    input: {
      readonly brandId: string;
      readonly ticket: MetaReplyTicket;
      readonly messageId: string;
      readonly personAuthored: boolean;
    },
  ): Promise<MetaDelivery | undefined> {
    const target = await this.targetFor(tx, input.ticket, input.personAuthored);
    if (target === undefined) {
      return undefined;
    }
    const { conversation, account, window } = target;
    const row = {
      brandId: input.brandId,
      departmentId: input.ticket.departmentId,
      ticketId: input.ticket.id,
      ticketMessageId: input.messageId,
      accountId: account.id,
      conversationId: conversation.id,
      customerId: conversation.customerId,
    };

    if (window.state === 'closed') {
      return this.#repository.insertDelivery(tx, {
        ...row,
        status: 'refused',
        errorCode: windowClosedCode(account.platform),
        lastError: WINDOW_CLOSED_NOTE,
        failedAt: this.#now(),
      });
    }

    const delivery = await this.#repository.insertDelivery(tx, row);
    if (delivery !== undefined) {
      await enqueueMetaReply(tx, input.brandId, delivery.id);
    }

    return delivery;
  }

  /**
   * "Retry": failed deliveries back in the queue, with the parts already sent
   * kept as sent. A `refused` delivery is not a failed one and is not put
   * back (`MetaDeliveriesService.retry` says why to the person who asked).
   */
  async retry(tx: DbTransaction, brandId: string, deliveryIds: readonly string[]): Promise<number> {
    const requeued = await this.#repository.requeue(tx, deliveryIds);
    for (const delivery of requeued) {
      await enqueueMetaReply(tx, brandId, delivery.id);
    }

    return requeued.length;
  }
}
