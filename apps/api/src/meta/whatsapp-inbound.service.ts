import {
  classifyGraphCode,
  type MetaEvent,
  type MetaEventError,
  toWhatsAppInboundMessage,
} from '@helpdock/channels';
import type { DbTransaction } from '@helpdock/db';
import { ContactFailure } from '../contacts/contact-failure.js';
import { attachVerifiedIdentity, findByIdentity, removeIdentity } from '../contacts/identity.js';
import { isSenderBlocked } from '../ticketing/sender-gate.js';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { MetaRepository } from './meta.repository.js';
import {
  duplicate,
  handled,
  ignored,
  instantOf,
  otherEvent,
  routeOrDrop,
} from './meta-event-support.js';
import type {
  MetaEventContext,
  MetaEventOutcome,
  MetaInboundLog,
  PlatformInboundService,
} from './meta-inbound.service.js';
import type { MetaAttachmentSink, MetaConversationRouter } from './meta-router.js';
import { metaInboundLabels } from './meta-text.js';
import { MetaThreadNotes, noteKeys, noteOutcome, reactionNote } from './meta-thread-notes.js';

/**
 * What a WhatsApp event becomes (M10-03, DOMAIN-RULES §4.7 and §4.8): the
 * `PlatformInboundService` for `object: whatsapp_business_account`, called by
 * the webhook once per event of a number, in a transaction of its brand. The
 * dedupe on the `wamid` and the block list are the webhook's, asked before
 * `handle` for what a customer caused, so neither is repeated here.
 *
 * | The event is | What happens |
 * |---|---|
 * | `message` (text, media, location, shared contacts, with `context`) | the router files it: the contact by the business-scoped user id, the `wa_id` as a verified phone, a ticket or a reply on the conversation's; each file `pending` with a `meta.media` outbox row |
 * | `status` `delivered` or `read` | the reply's delivery moves forward, never back; `pricing.category` is recorded |
 * | `status` `failed` | the delivery ends `failed` (`refused` when the code says the window had closed) with Meta's code |
 * | `system` `user_changed_number` | the new number is the contact's verified phone, the old one is taken off, and a line says so on the open ticket |
 * | `unsupported` | a line on the open ticket saying so; the message still opens the window |
 * | `reaction` | a line on the ticket of the message reacted to; never a message, never a window |
 * | `errors` about the account | logged and noted on the account |
 * | anything else | counted and dropped |
 *
 * Nothing here calls Meta, and nothing is fetched: a file is a reference until
 * `meta.media_fetch` has it (ADR 0025, 6).
 */

export interface WhatsAppInboundServiceOptions {
  readonly router: MetaConversationRouter;
  readonly sink: MetaAttachmentSink;
  readonly repository: Pick<
    MetaRepository,
    | 'advanceStatus'
    | 'conversation'
    | 'failByReport'
    | 'markError'
    | 'messageByPlatformId'
    | 'recordPricing'
    | 'systemLineSeen'
    | 'upsertConversation'
  >;
  readonly lifecycleReads: Pick<TicketLifecycleRepository, 'localeForContact'>;
  readonly log: MetaInboundLog;
}

type WhatsAppMessage = Extract<MetaEvent, { kind: 'message' }>;

/** `131026: Message undeliverable`, in Meta's words and nobody else's. */
const describeError = (error: MetaEventError | undefined): string => {
  if (error === undefined) {
    return 'Meta reported the message as failed';
  }
  const words = error.message ?? error.title ?? 'no reason given';

  return error.code === null ? words : `${String(error.code)}: ${words}`;
};

export class WhatsAppInboundService implements PlatformInboundService {
  readonly #options: WhatsAppInboundServiceOptions;
  readonly #notes: MetaThreadNotes;

  constructor(options: WhatsAppInboundServiceOptions) {
    this.#options = options;
    this.#notes = new MetaThreadNotes(options);
  }

  async handle(context: MetaEventContext, event: MetaEvent): Promise<MetaEventOutcome> {
    switch (event.kind) {
      case 'message':
        return this.#message(context, event);
      case 'status':
        return this.#status(context, event);
      case 'user_changed_number':
        return this.#numberChanged(context, event);
      case 'unsupported':
        return this.#unsupported(context, event);
      case 'reaction':
        return this.#reaction(context, event);
      case 'error':
        return this.#accountError(context, event);
      default:
        // Echoes and watermarks are Messenger's and Instagram's vocabulary.
        return otherEvent(this.#options.log, context, event);
    }
  }

  // ------------------------------------------------------------- messages

  async #message(context: MetaEventContext, event: WhatsAppMessage): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    if (await this.#phoneBlocked(tx, account.brandId, event.waId, now)) {
      return ignored('blocked-sender');
    }

    const locale = await this.#localeOf(tx, account.brandId, event.customerId);
    const message = toWhatsAppInboundMessage(
      {
        event,
        accountExternalId: account.externalId,
        labels: metaInboundLabels(locale),
      },
      instantOf(event.timestamp, now),
    );
    if (event.errors.length > 0) {
      // Meta could not serve what the customer sent (a media file it failed to
      // store). With a file, the attachment says so; without one, this is all
      // anyone will hear of it.
      this.#options.log.warn(
        { accountId: account.id, codes: event.errors.map((error) => error.code) },
        'whatsapp reported an error with a customer message',
      );
    }

    const routed = await routeOrDrop(
      this.#options,
      context,
      message,
      event.files.length > 0 && event.errors.length > 0 ? { fileRefusal: 'unreadable' } : {},
    );
    return routed === undefined ? ignored('invalid-customer-id') : handled;
  }

  /**
   * A number on the block list stops its WhatsApp messages too, though the
   * webhook's gate asks about the user id: an admin who blocked a phone number
   * by hand meant the person, not one of their identifiers.
   */
  async #phoneBlocked(
    tx: DbTransaction,
    brandId: string,
    waId: string | null,
    now: Date,
  ): Promise<boolean> {
    if (waId === null) {
      return false;
    }
    const gate = await isSenderBlocked(tx, brandId, { kind: 'phone', value: `+${waId}` }, { now });
    return gate.blocked;
  }

  // -------------------------------------------------------------- statuses

  async #status(
    context: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'status' }>,
  ): Promise<MetaEventOutcome> {
    const { tx, now } = context;
    const repository = this.#options.repository;
    const at = instantOf(event.timestamp, now);

    if (event.pricingCategory !== null) {
      await repository.recordPricing(tx, event.messageId, event.pricingCategory);
    }

    switch (event.status) {
      case 'sent':
        // The send job already recorded Meta's acceptance, with the same id.
        return ignored('status-sent');
      case 'delivered':
      case 'read': {
        const moved = await repository.advanceStatus(tx, event.messageId, event.status, at);
        return moved === undefined ? ignored('no-delivery-to-advance') : handled;
      }
      case 'failed': {
        const error = event.errors[0];
        const code = error?.code ?? null;
        const failed = await repository.failByReport(tx, event.messageId, {
          // 131047: the 24 hours had run out when Meta tried. No retry fixes it.
          status:
            code !== null && classifyGraphCode(code, null) === 'window_closed'
              ? 'refused'
              : 'failed',
          error: describeError(error),
          errorCode: code === null ? null : String(code),
          at,
        });
        return failed === undefined ? ignored('no-delivery-to-fail') : handled;
      }
    }
  }

  // ---------------------------------------------------------- changed number

  /**
   * DOMAIN-RULES §4.7: the new number is the contact's verified phone and the
   * old one is no longer theirs. The customer keeps their ticket and their
   * business-scoped user id; only what Meta says about the number moves.
   */
  async #numberChanged(
    context: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'user_changed_number' }>,
  ): Promise<MetaEventOutcome> {
    const { tx, account } = context;
    const conversation =
      event.customerId === null
        ? undefined
        : await this.#options.repository.conversation(tx, account.id, event.customerId);
    if (conversation === undefined || event.newWaId === null) {
      return ignored('unknown-conversation');
    }

    const previous = event.oldWaId ?? conversation.waId;
    try {
      await this.#relinkPhone(context, conversation.contactId, previous, event.newWaId);
    } catch (error) {
      if (!(error instanceof ContactFailure)) {
        throw error;
      }
      this.#options.log.warn(
        { accountId: account.id },
        'a whatsapp number change carried a number that is not a phone number; ignored',
      );
      return ignored('invalid-number');
    }
    await this.#options.repository.upsertConversation(tx, {
      brandId: account.brandId,
      accountId: account.id,
      customerId: conversation.customerId,
      contactId: conversation.contactId,
      waId: event.newWaId,
      profileName: null,
      username: null,
      // Not a customer message: the window stays where the last one put it.
      inbound: null,
    });
    // The number moved whether or not there is a ticket to say so; redelivered,
    // the same change is not told twice.
    const told = await this.#notes.write(context, conversation.ticketId, {
      line: {
        kind: 'numberChanged',
        from: previous === null ? '' : `+${previous}`,
        to: `+${event.newWaId}`,
      },
      key:
        event.timestamp === null ? null : noteKeys.numberChanged(conversation.id, event.timestamp),
    });
    return told === 'duplicate' ? duplicate : handled;
  }

  /** The new number proved, the old one taken off. Throws `ContactFailure` for a number that is not one. */
  async #relinkPhone(
    { tx, account }: MetaEventContext,
    contactId: string,
    previous: string | null,
    next: string,
  ): Promise<void> {
    await attachVerifiedIdentity(tx, account.brandId, contactId, {
      kind: 'phone',
      value: `+${next}`,
      source: 'whatsapp.cloud',
    });
    if (previous !== null && previous !== next) {
      await removeIdentity(tx, account.brandId, contactId, {
        kind: 'phone',
        value: `+${previous}`,
      });
    }
  }

  // -------------------------------------------------- unsupported, reactions

  /**
   * Something WhatsApp delivered that Helpdock cannot show (a poll, an order, an
   * edit). The customer did write, so the window opens and an agent can answer;
   * the thread says there was something. With no ticket there is nowhere to say
   * it, and the event is counted.
   */
  async #unsupported(
    context: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'unsupported' }>,
  ): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    if (event.customerId === null || event.messageId === null) {
      return ignored('no-customer');
    }
    const key = noteKeys.unsupported(event.messageId);
    const repository = this.#options.repository;
    if (await repository.systemLineSeen(tx, account.brandId, key)) {
      return duplicate;
    }
    const conversation = await repository.conversation(tx, account.id, event.customerId);
    if (conversation === undefined) {
      this.#options.log.info(
        { accountId: account.id, detail: event.detail },
        'whatsapp sent something unsupported with no conversation to note it on',
      );
      return ignored('no-conversation');
    }

    await repository.upsertConversation(tx, {
      brandId: account.brandId,
      accountId: account.id,
      customerId: conversation.customerId,
      contactId: conversation.contactId,
      waId: null,
      profileName: null,
      username: null,
      inbound: { at: instantOf(event.timestamp, now), messageId: event.messageId },
    });
    return noteOutcome(
      await this.#notes.write(context, conversation.ticketId, {
        line: { kind: 'unsupported' },
        key,
      }),
    );
  }

  /**
   * A reaction is a line, not a message: it has no words to answer and opens no
   * window. It goes to the ticket the reacted message is on, whether the
   * customer wrote it or an agent did, and is dropped when Helpdock has never
   * seen the message.
   */
  async #reaction(
    context: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'reaction' }>,
  ): Promise<MetaEventOutcome> {
    const { tx, account } = context;
    const target = await this.#options.repository.messageByPlatformId(
      tx,
      account.brandId,
      'whatsapp',
      event.messageId,
    );
    if (target === undefined) {
      return ignored('unknown-message');
    }
    return noteOutcome(await this.#notes.write(context, target.ticketId, reactionNote(event)));
  }

  // ------------------------------------------------------------- the account

  /** An error about the number itself (restricted, not registered), not about a message. */
  async #accountError(
    context: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'error' }>,
  ): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    this.#options.log.warn(
      { accountId: account.id, codes: event.errors.map((error) => error.code) },
      'whatsapp reported an error about the account',
    );
    await this.#options.repository.markError(tx, account.id, describeError(event.errors[0]), now);
    return handled;
  }

  // --------------------------------------------------------------------

  /** The language a message is worded in: the contact's, else the brand's. */
  async #localeOf(tx: DbTransaction, brandId: string, customerId: string) {
    const identity = await findByIdentity(tx, brandId, 'whatsapp', customerId);
    return this.#options.lifecycleReads.localeForContact(tx, brandId, identity?.contactId ?? null);
  }
}
