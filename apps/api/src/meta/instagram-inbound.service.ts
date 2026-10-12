import {
  type MetaEvent,
  type MetaMessageEvent,
  toInstagramInboundMessage,
} from '@helpdock/channels';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { MetaRepository } from './meta.repository.js';
import {
  askForProfile,
  dropEcho,
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
 * Instagram's events into one brand (M10-05, DOMAIN-RULES §4.7 and §4.8): the
 * platform half of the seam `MetaInboundService` fills, beside WhatsApp's. By
 * the time `handle` is called the dedupe on the `mid` and the block list have
 * been checked for what a customer caused, so neither is repeated here.
 *
 * | The event is | What happens |
 * |---|---|
 * | `message` | the router files it: a text, a story reply or mention, a shared post or reel as a line with its URL, files as `pending` attachments for `meta.media_fetch`, an earlier message it answers quoted; a new customer's name is asked for with a `meta.profile` event beside it |
 * | `echo` | dropped: Helpdock's own (by `app_id` or the delivery id in `metadata`) silently, any other counted |
 * | `deleted` | the message and its body stay; a line "unsent by the customer" marks it |
 * | `unsupported` | a line on the open ticket saying so; the customer did write, so the reply window moves |
 * | `seen` | the reply's delivery becomes `read` |
 * | `reaction` | a line on the ticket of the message reacted to |
 * | `postback`, `referral` and anything else | counted and dropped; never a message, never a window anchor |
 *
 * Nothing here calls Meta or sends anything to the customer: what an event
 * needs from outside the database is an outbox row, written in the same
 * transaction (DOMAIN-RULES §6).
 */

export interface InstagramInboundServiceOptions {
  readonly router: MetaConversationRouter;
  readonly sink: MetaAttachmentSink;
  readonly repository: Pick<
    MetaRepository,
    | 'advanceStatus'
    | 'conversation'
    | 'delivery'
    | 'messageByPlatformId'
    | 'systemLineSeen'
    | 'upsertConversation'
  >;
  readonly lifecycleReads: Pick<TicketLifecycleRepository, 'localeForContact'>;
  /** The install's `meta.appId`, to recognise Helpdock's own echoes; empty when none is set. */
  readonly appId: () => Promise<string>;
  readonly log: MetaInboundLog;
}

export class InstagramInboundService implements PlatformInboundService {
  readonly #options: InstagramInboundServiceOptions;
  readonly #notes: MetaThreadNotes;

  constructor(options: InstagramInboundServiceOptions) {
    this.#options = options;
    this.#notes = new MetaThreadNotes(options);
  }

  async handle(context: MetaEventContext, event: MetaEvent): Promise<MetaEventOutcome> {
    switch (event.kind) {
      case 'message':
        return this.#file(context, event);
      case 'echo':
        return dropEcho(context, event, this.#options);
      case 'deleted':
        return this.#unsent(context, event);
      case 'unsupported':
        return this.#unsupported(context, event);
      case 'seen':
        return this.#seen(context, event);
      case 'reaction':
        return this.#reaction(context, event);
      default:
        // Postbacks and referrals, and what Instagram does not send (a Messenger
        // watermark, a WhatsApp status): counted by the webhook, filed by nobody.
        return otherEvent(this.#options.log, context, event);
    }
  }

  // ------------------------------------------------------------- messages

  async #file(context: MetaEventContext, event: MetaMessageEvent): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    const { repository, lifecycleReads } = this.#options;
    const before = await repository.conversation(tx, account.id, event.customerId);
    const locale = await lifecycleReads.localeForContact(
      tx,
      account.brandId,
      before?.contactId ?? null,
    );

    const routed = await routeOrDrop(
      this.#options,
      context,
      toInstagramInboundMessage(
        { event, accountExternalId: account.externalId, labels: metaInboundLabels(locale) },
        instantOf(event.timestamp, now),
      ),
    );
    if (routed === undefined) {
      return ignored('invalid-customer-id');
    }

    await askForProfile(tx, account, 'instagram', routed.conversationId, before);
    return handled;
  }

  // -------------------------------------------------- unsent, unsupported

  /**
   * DOMAIN-RULES §4.8: an unsent message is kept and marked, never deleted. A
   * ticket message has no column for the mark, so it is a line whose external
   * id is {@link noteKeys.unsent}: that is how the thread finds the message it
   * belongs to, and how a redelivered event is told from a new one.
   */
  async #unsent(
    context: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'deleted' }>,
  ): Promise<MetaEventOutcome> {
    const { tx, account } = context;
    const key = noteKeys.unsent(event.messageId);
    if (await this.#options.repository.systemLineSeen(tx, account.brandId, key)) {
      return duplicate;
    }
    const target = await this.#options.repository.messageByPlatformId(
      tx,
      account.brandId,
      'instagram',
      event.messageId,
    );
    if (target === undefined) {
      return ignored('unknown-message');
    }

    return noteOutcome(
      await this.#notes.write(context, target.ticketId, { line: { kind: 'unsent' }, key }),
    );
  }

  /**
   * Something Instagram says it sent that Helpdock cannot show. The customer
   * did write, so a conversation that exists has its reply window moved and the
   * thread gets a line; a first message that is unsupported has no ticket to
   * write on and is counted.
   */
  async #unsupported(
    context: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'unsupported' }>,
  ): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    const { repository } = this.#options;
    if (event.customerId === null || event.messageId === null) {
      return ignored('no-customer');
    }
    const key = noteKeys.unsupported(event.messageId);
    if (await repository.systemLineSeen(tx, account.brandId, key)) {
      return duplicate;
    }
    const conversation = await repository.conversation(tx, account.id, event.customerId);
    this.#options.log.info(
      { accountId: account.id, platform: 'instagram', kind: 'unsupported', detail: event.detail },
      'instagram message that cannot be shown',
    );
    if (conversation === undefined) {
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

  // --------------------------------------------------- receipts, reactions

  /** `messaging_seen`: the customer has read one of the replies. */
  async #seen(
    { tx, now }: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'seen' }>,
  ): Promise<MetaEventOutcome> {
    const delivery = await this.#options.repository.advanceStatus(
      tx,
      event.messageId,
      'read',
      instantOf(event.timestamp, now),
    );

    return delivery === undefined ? ignored('no-delivery-to-advance') : handled;
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
      'instagram',
      event.messageId,
    );
    if (target === undefined) {
      return ignored('unknown-message');
    }

    return noteOutcome(await this.#notes.write(context, target.ticketId, reactionNote(event)));
  }
}
