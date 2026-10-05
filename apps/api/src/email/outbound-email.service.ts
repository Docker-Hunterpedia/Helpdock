import { outboundMessageId } from '@helpdock/channels';
import { type DbTransaction, type EmailDelivery, uuidv7 } from '@helpdock/db';
import type { EmailSenderKey } from '@helpdock/schemas';
import type { EmailRepository } from './email.repository.js';
import { enqueueEmailSend } from './email-events.js';
import { resolveSender } from './outgoing-settings.js';
import type { InstallSmtp } from './transport.js';

/**
 * Asks for an email, in the caller's transaction: one `email_deliveries` row
 * and one `email.send` outbox row, committed with the change that caused them
 * or not at all (DOMAIN-RULES §6). Nothing here talks to SMTP.
 *
 * The row freezes who the message is from and to and its `Message-ID`, so the
 * job — and every retry of it — sends the same message.
 */

export interface QueueReplyInput {
  readonly brandId: string;
  readonly ticketId: string;
  readonly messageId: string;
  /** The composer's From choice; the ticket's department's sender when absent. */
  readonly senderKey?: EmailSenderKey | undefined;
}

export interface QueueAutoReplyInput {
  readonly brandId: string;
  readonly ticketId: string;
  readonly kind: 'acknowledgment' | 'out_of_hours';
  readonly to: { readonly address: string; readonly name?: string | undefined };
}

export class OutboundEmailService {
  readonly #repository: EmailRepository;
  readonly #installSmtp: InstallSmtp;

  constructor(repository: EmailRepository, installSmtp: InstallSmtp) {
    this.#repository = repository;
    this.#installSmtp = installSmtp;
  }

  /**
   * A public reply to its contact, CCs copied (DOMAIN-RULES §2.5: participants
   * "receive public replies"). Nothing is queued for a ticket whose contact has
   * no address or a brand with no sender at all; the reply itself stands.
   */
  async queueReply(tx: DbTransaction, input: QueueReplyInput): Promise<EmailDelivery | undefined> {
    const addressing = await this.#repository.replyAddressing(tx, input.ticketId);
    if (addressing?.contact == null) {
      return undefined;
    }
    const sender = await this.#sender(tx, input.brandId, addressing.departmentId, input.senderKey);
    if (sender === undefined) {
      return undefined;
    }

    return this.#insertAndEnqueue(tx, input.brandId, {
      ticketId: input.ticketId,
      departmentId: addressing.departmentId,
      ticketMessageId: input.messageId,
      kind: 'reply',
      fromName: sender.from.name,
      fromAddress: sender.from.address,
      replyTo: sender.replyTo,
      toName: addressing.contact.name === '' ? null : addressing.contact.name,
      toAddress: addressing.contact.address,
      ccAddresses: [...addressing.cc],
      locale: addressing.locale,
      messageId: outboundMessageId({
        kind: 'reply',
        id: input.messageId,
        fromAddress: sender.from.address,
      }),
    });
  }

  /** An auto-reply to the sender of the email that opened the ticket (M2-06). */
  async queueAutoReply(
    tx: DbTransaction,
    input: QueueAutoReplyInput,
  ): Promise<EmailDelivery | undefined> {
    const addressing = await this.#repository.replyAddressing(tx, input.ticketId);
    if (addressing === undefined) {
      return undefined;
    }
    const sender = await this.#sender(tx, input.brandId, addressing.departmentId, undefined);
    if (sender === undefined) {
      return undefined;
    }

    return this.#insertAndEnqueue(tx, input.brandId, {
      ticketId: input.ticketId,
      departmentId: addressing.departmentId,
      ticketMessageId: null,
      kind: input.kind,
      fromName: sender.from.name,
      fromAddress: sender.from.address,
      replyTo: sender.replyTo,
      toName: input.to.name ?? addressing.contact?.name ?? null,
      toAddress: input.to.address,
      ccAddresses: [],
      locale: addressing.locale,
      messageId: outboundMessageId({
        kind: input.kind,
        id: input.ticketId,
        fromAddress: sender.from.address,
      }),
    });
  }

  /**
   * M4-08. A widget conversation, to the address the visitor typed and to
   * nobody else (DOMAIN-RULES §4.1): no CCs, and the brand's sender for the
   * conversation's department. Keyed by its own delivery row, so asking twice
   * sends twice and a redelivered job still sends once.
   */
  async queueTranscript(
    tx: DbTransaction,
    input: {
      readonly brandId: string;
      readonly ticketId: string;
      readonly to: string;
      readonly locale: 'en' | 'ar';
    },
  ): Promise<EmailDelivery | undefined> {
    const addressing = await this.#repository.replyAddressing(tx, input.ticketId);
    if (addressing === undefined) {
      return undefined;
    }
    const sender = await this.#sender(tx, input.brandId, addressing.departmentId, undefined);
    if (sender === undefined) {
      return undefined;
    }

    const id = uuidv7();
    return this.#insertAndEnqueue(tx, input.brandId, {
      id,
      ticketId: input.ticketId,
      departmentId: addressing.departmentId,
      ticketMessageId: null,
      kind: 'transcript',
      fromName: sender.from.name,
      fromAddress: sender.from.address,
      replyTo: sender.replyTo,
      toName: null,
      toAddress: input.to,
      ccAddresses: [],
      locale: input.locale,
      messageId: outboundMessageId({ kind: 'transcript', id, fromAddress: sender.from.address }),
    });
  }

  /**
   * M8-06. The survey on close, to the ticket's contact and to nobody else: no
   * CCs, since a rating is the requester's to give. Keyed by the survey, so a
   * redelivered survey job queues one email. Nothing is queued for a contact
   * with no address or a brand with no sender; the agent still has the link.
   */
  async queueCsatSurvey(
    tx: DbTransaction,
    input: { readonly brandId: string; readonly ticketId: string; readonly surveyId: string },
  ): Promise<EmailDelivery | undefined> {
    const addressing = await this.#repository.replyAddressing(tx, input.ticketId);
    if (addressing?.contact == null) {
      return undefined;
    }
    const sender = await this.#sender(tx, input.brandId, addressing.departmentId, undefined);
    if (sender === undefined) {
      return undefined;
    }

    return this.#insertAndEnqueue(tx, input.brandId, {
      ticketId: input.ticketId,
      departmentId: addressing.departmentId,
      ticketMessageId: null,
      csatResponseId: input.surveyId,
      kind: 'csat',
      fromName: sender.from.name,
      fromAddress: sender.from.address,
      replyTo: sender.replyTo,
      toName: addressing.contact.name === '' ? null : addressing.contact.name,
      toAddress: addressing.contact.address,
      ccAddresses: [],
      locale: addressing.locale,
      messageId: outboundMessageId({
        kind: 'csat',
        id: input.surveyId,
        fromAddress: sender.from.address,
      }),
    });
  }

  /**
   * Puts failed or discarded sends back in the queue for a new round of
   * attempts, with the same `Message-ID`: a customer whose server did take an
   * earlier attempt after all sees one message, not two.
   */
  async retry(tx: DbTransaction, brandId: string, deliveryIds: readonly string[]): Promise<number> {
    const requeued = await this.#repository.requeue(tx, deliveryIds);
    for (const delivery of requeued) {
      await enqueueEmailSend(tx, brandId, delivery.id);
    }
    return requeued.length;
  }

  async #sender(
    tx: DbTransaction,
    brandId: string,
    departmentId: string,
    key: EmailSenderKey | undefined,
  ) {
    const row = await this.#repository.settings(tx, brandId);
    const install = await this.#installSmtp.read();
    return resolveSender(row, { departmentId, key }, install?.from);
  }

  async #insertAndEnqueue(
    tx: DbTransaction,
    brandId: string,
    values: Omit<Parameters<EmailRepository['insertDelivery']>[1], 'brandId'>,
  ): Promise<EmailDelivery | undefined> {
    const delivery = await this.#repository.insertDelivery(tx, { brandId, ...values });
    if (delivery !== undefined) {
      await enqueueEmailSend(tx, brandId, delivery.id);
    }
    return delivery;
  }
}
