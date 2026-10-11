import { type MetaEvent, toMessengerInboundMessage } from '@helpdock/channels';
import type {
  DbTransaction,
  MetaAccount as MetaAccountRow,
  MetaConversation as MetaConversationRow,
} from '@helpdock/db';
import { ContactFailure } from '../contacts/contact-failure.js';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { enqueueMetaProfile } from './messenger-profile.js';
import type { MetaRepository } from './meta.repository.js';
import type {
  MetaEventContext,
  MetaEventOutcome,
  MetaInboundLog,
  PlatformInboundService,
} from './meta-inbound.service.js';
import { metaMessageSeen } from './meta-inbound-gate.js';
import type {
  MetaAttachmentSink,
  MetaConversationRouter,
  MetaRouteContext,
} from './meta-router.js';
import { type MetaSystemLine, metaInboundLabels, metaSystemLine } from './meta-text.js';

/**
 * A Messenger Page's events into one brand (M10-04, ADR 0025, DOMAIN-RULES
 * §4.7 and §4.8): the `PlatformInboundService` for `object: page`, called by
 * the webhook once per event of a Page, in a transaction of its brand. The
 * dedupe on the `mid` and the block list are the webhook's, asked before
 * `handle` for a customer's message, so neither is repeated here.
 *
 * | The event is | What happens |
 * |---|---|
 * | `message` | the router files it under `<page id>:<psid>`; the customer's name is asked for once, as a `meta.profile` outbox row; its files are `pending` attachments and `meta.media` outbox rows |
 * | `echo` | a message the Page sent: Helpdock's own (by `app_id`, or `metadata` naming one of this account's deliveries) is dropped silently, any other is dropped and counted |
 * | `delivery`, `read` | every delivery of the conversation sent at or before the watermark moves to `delivered` / `read`; the `mids` a `delivery` names move individually |
 * | `reaction`, `edit` | a system line on the ticket of the message they are about |
 * | `unsupported` | a system line on the conversation's open ticket; the message still opens the reply window |
 * | `policy_enforcement` | counted and dropped, and recorded as the account's `last_error` |
 * | `postback`, `referral`, `standby` and the rest | counted and dropped |
 *
 * Everything runs in the route's transaction, as the system principal. What an
 * event causes outside the database — the media fetch, the customer's name —
 * is an outbox row, never a call made here: the webhook never calls Graph
 * (ADR 0025).
 */

type Event<Kind extends MetaEvent['kind']> = Extract<MetaEvent, { kind: Kind }>;

const handled: MetaEventOutcome = { outcome: 'handled' };

const ignored = (reason: string): MetaEventOutcome => ({ outcome: 'ignored', reason });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a message came to, in the shape the router takes. */
const routeContextOf = ({ tx, account, now }: MetaEventContext): MetaRouteContext => ({
  tx,
  brandId: account.brandId,
  account: {
    id: account.id,
    departmentId: account.departmentId,
    platform: 'messenger',
    externalId: account.externalId,
  },
  now,
});

/**
 * Whether a customer's name has been looked for. `profile_checked_at` is the
 * profile job's mark (M10-05, migration 0051): it is set whether Graph answered
 * or refused, so a lookup is made once per conversation. The column is not on
 * this branch's schema yet, so it is read as an optional property: until it
 * exists a nameless conversation asks again with every message.
 */
const profileAsked = (
  conversation: MetaConversationRow & { readonly profileCheckedAt?: Date | null },
): boolean => conversation.profileName !== null || (conversation.profileCheckedAt ?? null) !== null;

/** How a line in the thread came out. */
type NoteResult = 'written' | 'duplicate' | 'no-open-ticket';

const outcomeOf = (result: NoteResult): MetaEventOutcome => {
  switch (result) {
    case 'written':
      return handled;
    case 'duplicate':
      return { outcome: 'duplicate' };
    case 'no-open-ticket':
      return ignored('no-open-ticket');
  }
};

/** What a line in the thread is, and the key that keeps a redelivery to one of it. */
interface Note {
  readonly line: MetaSystemLine;
  readonly key: string | null;
}

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
    | 'upsertConversation'
  >;
  readonly lifecycleReads: Pick<TicketLifecycleRepository, 'localeForContact'>;
  /** The install's Meta app id (`meta.appId`), empty when none is set. */
  readonly appId: () => Promise<string>;
  readonly log: MetaInboundLog;
}

export class MessengerInboundService implements PlatformInboundService {
  readonly #options: MessengerInboundServiceOptions;

  constructor(options: MessengerInboundServiceOptions) {
    this.#options = options;
  }

  async handle(context: MetaEventContext, event: MetaEvent): Promise<MetaEventOutcome> {
    switch (event.kind) {
      case 'message':
        return this.#message(context, event);
      case 'echo':
        return this.#echo(context, event);
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
      case 'ignored':
        return ignored(event.reason);
      case 'postback':
      case 'referral':
        return ignored(event.kind);
      // A Page's webhook carries none of WhatsApp's or Instagram's kinds.
      default:
        this.#options.log.warn(
          { kind: event.kind, platform: event.platform },
          'messenger received an event of another platform; dropped',
        );
        return ignored(`unexpected-${event.kind}`);
    }
  }

  // --------------------------------------------------------------- messages

  async #message(context: MetaEventContext, event: Event<'message'>): Promise<MetaEventOutcome> {
    const { tx, account } = context;
    const known = await this.#options.repository.conversation(tx, account.id, event.customerId);
    const routed = await this.#route(context, event, known);
    if (routed === undefined) {
      return ignored('invalid-customer-id');
    }

    if (known === undefined || !profileAsked(known)) {
      await this.#askForProfile(tx, account, routed.conversationId);
    }
    if (event.unsupportedAttachments.length > 0) {
      // An attachment of a type Helpdock cannot show rides on a message that was
      // filed for the rest of it; the agent is told something is missing.
      await this.#note(context, routed.ticketId, {
        line: { kind: 'unsupported' },
        key: `unsupported:${event.messageId}`,
      });
    }
    return handled;
  }

  /** The router's filing of the message, or undefined for an id that cannot be an identifier. */
  async #route(
    context: MetaEventContext,
    event: Event<'message'>,
    known: MetaConversationRow | undefined,
  ) {
    const { tx, account, now } = context;
    const locale = await this.#options.lifecycleReads.localeForContact(
      tx,
      account.brandId,
      known?.contactId ?? null,
    );
    try {
      return await this.#options.router.route(
        routeContextOf(context),
        toMessengerInboundMessage(
          {
            event: { ...event, profileName: known?.profileName ?? null },
            accountExternalId: account.externalId,
            labels: metaInboundLabels(locale),
          },
          // The customer's time, which anchors the reply window, and never the future's.
          event.timestamp !== null && event.timestamp < now ? event.timestamp : now,
        ),
        this.#options.sink,
      );
    } catch (error) {
      if (!(error instanceof ContactFailure)) {
        throw error;
      }
      // Meta would redeliver a message with such an id for ever to no purpose.
      this.#options.log.warn(
        { accountId: account.id, reason: error.reason },
        'a messenger customer id was refused as an identifier; the message is dropped',
      );
      return undefined;
    }
  }

  /**
   * The customer's name is not in a Messenger webhook, and reading it is a Graph
   * call the request must not make, so the first message of a conversation
   * leaves a `meta.profile` outbox row for the profile job. Until the job has
   * filled it (or been refused, as a Page without the reviewed feature is) the
   * contact is named by its id and the thread says "Messenger user".
   */
  async #askForProfile(
    tx: DbTransaction,
    account: MetaAccountRow,
    conversationId: string,
  ): Promise<void> {
    await enqueueMetaProfile(tx, account.brandId, {
      conversationId,
      accountId: account.id,
      platform: 'messenger',
    });
  }

  // ----------------------------------------------------------------- echoes

  /**
   * A message the Page sent. Helpdock's own are in the thread already as the
   * reply an agent wrote; one typed in Meta Business Suite is not imported (an
   * accepted gap), but is counted so an operator can see it happens.
   */
  async #echo({ tx, account }: MetaEventContext, event: Event<'echo'>): Promise<MetaEventOutcome> {
    if (await this.#isOurs(tx, account, event)) {
      return ignored('echo');
    }
    this.#options.log.info(
      { accountId: account.id },
      'messenger echo of a message Helpdock did not send; dropped',
    );
    return ignored('echo-not-ours');
  }

  async #isOurs(
    tx: DbTransaction,
    account: MetaAccountRow,
    event: Event<'echo'>,
  ): Promise<boolean> {
    const appId = await this.#options.appId();
    if (appId !== '' && event.appId === appId) {
      return true;
    }
    if (event.metadata !== null && UUID.test(event.metadata)) {
      const delivery = await this.#options.repository.delivery(tx, event.metadata);
      return delivery?.accountId === account.id;
    }
    return false;
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
      await repository.advanceStatus(tx, mid, status, event.watermark ?? event.timestamp ?? now);
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
    const line: MetaSystemLine =
      event.action === 'unreact'
        ? { kind: 'reaction', emoji: null }
        : event.emoji === null
          ? { kind: 'reactionPlain' }
          : { kind: 'reaction', emoji: event.emoji };

    return outcomeOf(
      await this.#note(context, target.ticketId, {
        line,
        // A reaction has no id of its own: who, to what, which way and when.
        key:
          event.timestamp === null
            ? null
            : `reaction:${event.messageId}:${event.customerId}:${event.action}:${String(event.timestamp.getTime())}`,
      }),
    );
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

    return outcomeOf(
      await this.#note(context, target.ticketId, {
        line: { kind: 'edited', text: event.text },
        key: version === null ? null : `edit:${event.messageId}:${String(version)}`,
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
        inbound: {
          at: event.timestamp !== null && event.timestamp < now ? event.timestamp : now,
          messageId: event.messageId,
        },
      });
    }
    return outcomeOf(
      await this.#note(context, conversation.ticketId, {
        line: { kind: 'unsupported' },
        key: event.messageId === null ? null : `unsupported:${event.messageId}`,
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

  /**
   * A line in the open ticket `ticketId` leads to, worded for its contact, once
   * however often the event arrives. `no-open-ticket` when there is none: no
   * ticket, or one that is closed or spam.
   */
  async #note(
    { tx, account }: MetaEventContext,
    ticketId: string | null,
    note: Note,
  ): Promise<NoteResult> {
    const { router, lifecycleReads } = this.#options;
    const ticket = ticketId === null ? undefined : await router.openTicket(tx, ticketId);
    if (ticket === undefined) {
      return 'no-open-ticket';
    }
    if (note.key !== null && (await metaMessageSeen(tx, account.brandId, 'messenger', note.key))) {
      return 'duplicate';
    }

    const locale = await lifecycleReads.localeForContact(tx, account.brandId, ticket.contactId);
    await router.writeSystemLine(tx, {
      ticket,
      accountId: account.id,
      text: metaSystemLine(locale, note.line),
      ...(note.key === null ? {} : { externalMessageId: note.key }),
    });
    return 'written';
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
