import { type MetaEvent, toMessengerInboundMessage } from '@helpdock/channels';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { MetaRepository } from './meta.repository.js';
import {
  askForProfile,
  dropEcho,
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
 * A Messenger Page's events into one brand (M10-04, ADR 0025, DOMAIN-RULES
 * §4.7 and §4.8): the `PlatformInboundService` for `object: page`, called by
 * the webhook once per event of a Page, in a transaction of its brand. The
 * dedupe on the `mid` and the block list are the webhook's, asked before
 * `handle` for what a customer caused, so neither is repeated here.
 *
 * | The event is | What happens |
 * |---|---|
 * | `message` | the router files it under `<page id>:<psid>`; the customer's name is asked for once, as a `meta.profile` outbox row; its files are `pending` attachments and `meta.media` outbox rows |
 * | `echo` | a message the Page sent: Helpdock's own (by `app_id`, or `metadata` naming one of this account's deliveries) is dropped silently, any other is dropped and counted |
 * | `delivery`, `read` | every delivery of the conversation sent at or before the watermark moves to `delivered` / `read`; the `mids` a `delivery` names move individually |
 * | `reaction`, `edit` | a system line on the ticket of the message they are about |
 * | `unsupported` | a system line on the conversation's open ticket; the message still opens the reply window |
 * | `policy_enforcement` | counted and dropped, and recorded as the account's `last_error` |
 * | `postback`, `referral` and the rest | counted and dropped |
 *
 * Everything runs in the route's transaction, as the system principal. What an
 * event causes outside the database — the media fetch, the customer's name —
 * is an outbox row, never a call made here: the webhook never calls Graph
 * (ADR 0025).
 */

type Event<Kind extends MetaEvent['kind']> = Extract<MetaEvent, { kind: Kind }>;

export interface MessengerInboundServiceOptions {
  readonly router: MetaConversationRouter;
  readonly sink: MetaAttachmentSink;
  readonly repository: Pick<
    MetaRepository,
    | 'advanceByWatermark'
    | 'advanceStatus'
    | 'conversation'
    | 'delivery'
    | 'markError'
    | 'messageByPlatformId'
    | 'systemLineSeen'
    | 'upsertConversation'
  >;
  readonly lifecycleReads: Pick<TicketLifecycleRepository, 'localeForContact'>;
  /** The install's Meta app id (`meta.appId`), empty when none is set. */
  readonly appId: () => Promise<string>;
  readonly log: MetaInboundLog;
}

export class MessengerInboundService implements PlatformInboundService {
  readonly #options: MessengerInboundServiceOptions;
  readonly #notes: MetaThreadNotes;

  constructor(options: MessengerInboundServiceOptions) {
    this.#options = options;
    this.#notes = new MetaThreadNotes(options);
  }

  async handle(context: MetaEventContext, event: MetaEvent): Promise<MetaEventOutcome> {
    switch (event.kind) {
      case 'message':
        return this.#message(context, event);
      case 'echo':
        return dropEcho(context, event, this.#options);
      case 'delivery':
        return this.#receipt(context, event, 'delivered');
      case 'read':
        return this.#receipt(context, event, 'read');
      case 'reaction':
        return this.#reaction(context, event);
      case 'edit':
        return this.#edit(context, event);
      case 'unsupported':
        return this.#unsupported(context, event);
      case 'policy_enforcement':
        return this.#policy(context, event);
      // A Page's webhook carries none of WhatsApp's or Instagram's kinds.
      default:
        return otherEvent(this.#options.log, context, event);
    }
  }

  // --------------------------------------------------------------- messages

  async #message(context: MetaEventContext, event: Event<'message'>): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    const known = await this.#options.repository.conversation(tx, account.id, event.customerId);
    const locale = await this.#options.lifecycleReads.localeForContact(
      tx,
      account.brandId,
      known?.contactId ?? null,
    );
    const routed = await routeOrDrop(
      this.#options,
      context,
      toMessengerInboundMessage(
        {
          event: { ...event, profileName: known?.profileName ?? null },
          accountExternalId: account.externalId,
          labels: metaInboundLabels(locale),
        },
        // The customer's time, which anchors the reply window, and never the future's.
        instantOf(event.timestamp, now),
      ),
    );
    if (routed === undefined) {
      return ignored('invalid-customer-id');
    }

    // The customer's name is not in a Messenger webhook, and reading it is a Graph
    // call the request must not make, so the first message of a conversation
    // leaves a `meta.profile` outbox row for the profile job. Until the job has
    // filled it (or been refused, as a Page without the reviewed feature is) the
    // contact is named by its id and the thread says "Messenger user".
    await askForProfile(tx, account, 'messenger', routed.conversationId, known);
    if (event.unsupportedAttachments.length > 0) {
      // An attachment of a type Helpdock cannot show rides on a message that was
      // filed for the rest of it; the agent is told something is missing.
      await this.#notes.write(context, routed.ticketId, {
        line: { kind: 'unsupported' },
        key: noteKeys.unsupported(event.messageId),
      });
    }
    return handled;
  }

  // --------------------------------------------------------------- receipts

  /**
   * `delivery` and `read` (DOMAIN-RULES §4.8): a watermark marks every delivery
   * of this conversation sent at or before it, and the `mids` a delivery names
   * are exact. Both only move a delivery forward.
   */
  async #receipt(
    { tx, account, now }: MetaEventContext,
    event: Event<'delivery'> | Event<'read'>,
    status: 'delivered' | 'read',
  ): Promise<MetaEventOutcome> {
    const { repository } = this.#options;
    const conversation = await repository.conversation(tx, account.id, event.customerId);
    if (conversation === undefined) {
      return ignored('no-conversation');
    }

    const mids = event.kind === 'delivery' ? event.mids : [];
    if (event.watermark === null && mids.length === 0) {
      return ignored('empty-receipt');
    }
    if (event.watermark !== null) {
      await repository.advanceByWatermark(tx, conversation.id, status, event.watermark);
    }
    for (const mid of mids) {
      await repository.advanceStatus(
        tx,
        mid,
        status,
        event.watermark ?? instantOf(event.timestamp, now),
      );
    }
    return handled;
  }

  // ------------------------------------------------------- lines in a thread

  /**
   * A reaction is a line, not a message: it has no words to answer and opens no
   * window. It goes to the ticket the reacted message is on, whether the
   * customer wrote it or an agent did, and is dropped when Helpdock has never
   * seen the message.
   */
  async #reaction(context: MetaEventContext, event: Event<'reaction'>): Promise<MetaEventOutcome> {
    const target = await this.#targetOf(context, event.messageId);
    if (target === undefined) {
      return ignored('unknown-message');
    }
    return noteOutcome(await this.#notes.write(context, target.ticketId, reactionNote(event)));
  }

  async #edit(context: MetaEventContext, event: Event<'edit'>): Promise<MetaEventOutcome> {
    const target = await this.#targetOf(context, event.messageId);
    if (target === undefined) {
      return ignored('unknown-message');
    }
    if (event.text.trim() === '') {
      return ignored('empty-edit');
    }
    const version = event.editNumber ?? event.timestamp?.getTime() ?? null;

    return noteOutcome(
      await this.#notes.write(context, target.ticketId, {
        line: { kind: 'edited', text: event.text },
        key: version === null ? null : noteKeys.edit(event.messageId, version),
      }),
    );
  }

  /**
   * Something Meta says it sent that Helpdock cannot show. The customer did
   * write, so the window opens and an agent can answer; the conversation's open
   * ticket says there was something. With no ticket there is nowhere to say it.
   */
  async #unsupported(
    context: MetaEventContext,
    event: Event<'unsupported'>,
  ): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    const { repository } = this.#options;
    if (event.customerId === null) {
      return ignored('no-customer');
    }
    const conversation = await repository.conversation(tx, account.id, event.customerId);
    if (conversation === undefined) {
      return ignored('no-conversation');
    }

    if (event.messageId !== null) {
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
    }
    return noteOutcome(
      await this.#notes.write(context, conversation.ticketId, {
        line: { kind: 'unsupported' },
        key: event.messageId === null ? null : noteKeys.unsupported(event.messageId),
      }),
    );
  }

  /** The ticket and message a platform id names: a customer's, or one of Helpdock's own replies. */
  #targetOf({ tx, account }: MetaEventContext, platformMessageId: string) {
    return this.#options.repository.messageByPlatformId(
      tx,
      account.brandId,
      'messenger',
      platformMessageId,
    );
  }

  // ----------------------------------------------------------------- policy

  /**
   * Meta warned, blocked or unblocked the Page. Nothing to file, but an operator
   * has to see it on Channels › Meta: it goes on the account as `last_error`.
   * An `unblock` is good news and is not an error.
   */
  async #policy(
    { tx, account, now }: MetaEventContext,
    event: Event<'policy_enforcement'>,
  ): Promise<MetaEventOutcome> {
    if (event.action?.toLowerCase() !== 'unblock') {
      const detail = [event.action, event.reason].filter((part) => part !== null).join(': ');
      await this.#options.repository.markError(
        tx,
        account.id,
        `messaging_policy_enforcement${detail === '' ? '' : ` ${detail}`}`,
        // The route stamps `last_event_at` with `now` after the handlers run, and health
        // reads an error as current only when it is later than the last event.
        new Date(now.getTime() + 1),
      );
    }
    return ignored('policy-enforcement');
  }
}
