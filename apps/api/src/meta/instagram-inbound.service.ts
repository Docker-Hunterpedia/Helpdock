import {
  type MetaEvent,
  type MetaMessageEvent,
  toInstagramInboundMessage,
} from '@helpdock/channels';
import { type DbTransaction, ticketMessages } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { instantOf, REACTION_EMOJI_MAX_LENGTH, unsentExternalId } from './instagram-rules.js';
import type { MetaRepository } from './meta.repository.js';
import { enqueueMetaProfile } from './meta-events.js';
import type {
  MetaEventContext,
  MetaEventOutcome,
  MetaInboundLog,
  PlatformInboundService,
} from './meta-inbound.service.js';
import { metaSenderBlocked } from './meta-inbound-gate.js';
import { wantsProfile } from './meta-profile.js';
import type {
  MetaAttachmentSink,
  MetaConversationRouter,
  MetaRouteContext,
} from './meta-router.js';
import { type MetaSystemLine, metaInboundLabels, metaSystemLine } from './meta-text.js';

/**
 * Instagram's events into one brand (M10-05, DOMAIN-RULES §4.7 and §4.8): the
 * platform half of the seam `MetaInboundService` fills, beside WhatsApp's. By
 * the time `handle` is called the dedupe on the `mid` and the block list have
 * been checked for a customer's message, so neither is repeated here.
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
    'advanceStatus' | 'conversation' | 'delivery' | 'messageByPlatformId' | 'upsertConversation'
  >;
  readonly lifecycleReads: Pick<TicketLifecycleRepository, 'localeForContact'>;
  /** The install's `meta.appId`, to recognise Helpdock's own echoes; empty when none is set. */
  readonly appId: () => Promise<string>;
  readonly log: MetaInboundLog;
}

const ignored = (reason: string): MetaEventOutcome => ({ outcome: 'ignored', reason });
const handled: MetaEventOutcome = { outcome: 'handled' };

/** Where a message came to, in the shape the router takes. */
const routeContextOf = ({ tx, account, now }: MetaEventContext): MetaRouteContext => ({
  tx,
  brandId: account.brandId,
  account: {
    id: account.id,
    departmentId: account.departmentId,
    platform: 'instagram',
    externalId: account.externalId,
  },
  now,
});

export class InstagramInboundService implements PlatformInboundService {
  readonly #options: InstagramInboundServiceOptions;

  constructor(options: InstagramInboundServiceOptions) {
    this.#options = options;
  }

  async handle(context: MetaEventContext, event: MetaEvent): Promise<MetaEventOutcome> {
    switch (event.kind) {
      case 'message':
        return this.#file(context, event);
      case 'echo':
        return this.#echo(context, event);
      case 'deleted':
        return this.#unsent(context, event);
      case 'unsupported':
        return this.#unsupported(context, event);
      case 'seen':
        return this.#seen(context, event);
      case 'reaction':
        return this.#reaction(context, event);
      case 'ignored':
        return ignored(event.reason);
      default:
        // Postbacks and referrals, and what Instagram does not send (a Messenger
        // watermark, a WhatsApp status): counted by the webhook, filed by nobody.
        return ignored(event.kind);
    }
  }

  // ------------------------------------------------------------- messages

  async #file(context: MetaEventContext, event: MetaMessageEvent): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    const { repository, lifecycleReads, router, sink } = this.#options;
    const before = await repository.conversation(tx, account.id, event.customerId);
    const locale = await lifecycleReads.localeForContact(
      tx,
      account.brandId,
      before?.contactId ?? null,
    );

    const message = toInstagramInboundMessage(
      { event, accountExternalId: account.externalId, labels: metaInboundLabels(locale) },
      instantOf(event.timestamp, now),
    );
    const routed = await router.route(routeContextOf(context), message, sink);

    // Meta's message carries no name. A customer nobody has named, and Graph has
    // not been asked about, gets one lookup, raised here and run by a job.
    if (account.status === 'connected' && wantsProfile(before)) {
      await enqueueMetaProfile(tx, account.brandId, {
        conversationId: routed.conversationId,
        accountId: account.id,
        platform: 'instagram',
      });
    }

    return handled;
  }

  // ---------------------------------------------------------------- echoes

  /**
   * A business message echoed back. Helpdock's own sends carry its app id, or
   * the delivery id it set as `metadata`; both are dropped without a word. Any
   * other echo is one typed in the Instagram app or Meta Business Suite, which
   * M10 does not import (the milestone's accepted gaps): dropped and counted.
   */
  async #echo(
    { tx, account }: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'echo' }>,
  ): Promise<MetaEventOutcome> {
    const appId = await this.#options.appId();
    const own =
      (appId !== '' && event.appId === appId) ||
      (await this.#isOurDelivery(tx, account.id, event.metadata));
    if (own) {
      return ignored('own-echo');
    }
    this.#options.log.info(
      { accountId: account.id, platform: 'instagram', kind: 'echo' },
      'instagram echo of a message sent outside helpdock dropped',
    );
    return ignored('echo');
  }

  async #isOurDelivery(
    tx: DbTransaction,
    accountId: string,
    metadata: string | null,
  ): Promise<boolean> {
    const id = z.uuid().safeParse(metadata);
    if (!id.success) {
      return false;
    }
    const delivery = await this.#options.repository.delivery(tx, id.data);

    return delivery?.accountId === accountId;
  }

  // -------------------------------------------------- unsent, unsupported

  /**
   * DOMAIN-RULES §4.8: an unsent message is kept and marked, never deleted. A
   * ticket message has no column for the mark, so it is a line whose external
   * id is {@link unsentExternalId}: that is how the thread finds the message it
   * belongs to, and how a redelivered event is told from a new one.
   */
  async #unsent(
    context: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'deleted' }>,
  ): Promise<MetaEventOutcome> {
    const { tx, account } = context;
    const marker = unsentExternalId(event.messageId);
    if (await this.#lineExists(tx, account.brandId, marker)) {
      return { outcome: 'duplicate' };
    }
    const target = await this.#options.repository.messageByPlatformId(
      tx,
      account.brandId,
      'instagram',
      event.messageId,
    );
    if (target === undefined) {
      return ignored('message-unknown');
    }

    return (await this.#note(context, target.ticketId, { kind: 'unsent' }, marker))
      ? handled
      : ignored('no-open-ticket');
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
    if (await this.#lineExists(tx, account.brandId, event.messageId)) {
      return { outcome: 'duplicate' };
    }
    if (await metaSenderBlocked(tx, account, event.customerId, now)) {
      return ignored('blocked-sender');
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

    return (await this.#note(
      context,
      conversation.ticketId,
      { kind: 'unsupported' },
      event.messageId,
    ))
      ? handled
      : ignored('no-open-ticket');
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

    return delivery === undefined ? ignored('no-delivery') : handled;
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
    const { tx, account, now } = context;
    if (await metaSenderBlocked(tx, account, event.customerId, now)) {
      return ignored('blocked-sender');
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

    return (await this.#note(context, target.ticketId, reactionLine(event)))
      ? handled
      : ignored('no-open-ticket');
  }

  // ---------------------------------------------------------------- lines

  /**
   * A line in the open ticket `ticketId` leads to, worded for its contact.
   * False when there is none: no ticket, or one that is closed or spam.
   */
  async #note(
    { tx, account }: MetaEventContext,
    ticketId: string | null,
    line: MetaSystemLine,
    externalMessageId?: string,
  ): Promise<boolean> {
    const { router, lifecycleReads } = this.#options;
    const ticket = ticketId === null ? undefined : await router.openTicket(tx, ticketId);
    if (ticket === undefined) {
      return false;
    }

    const locale = await lifecycleReads.localeForContact(tx, account.brandId, ticket.contactId);
    await router.writeSystemLine(tx, {
      ticket,
      accountId: account.id,
      text: metaSystemLine(locale, line),
      ...(externalMessageId === undefined ? {} : { externalMessageId }),
    });
    return true;
  }

  /**
   * Whether a line with this external id is already in the brand's tickets,
   * whatever channel the ticket it landed on has: a line goes to the primary of
   * a merge, which can be an email ticket, and the unique key is per channel.
   */
  async #lineExists(tx: DbTransaction, brandId: string, externalId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.brandId, brandId),
          eq(ticketMessages.kind, 'system'),
          eq(ticketMessages.externalMessageId, externalId),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }
}

/** A reaction, or one taken back, as the line the thread shows. */
const reactionLine = (event: Extract<MetaEvent, { kind: 'reaction' }>): MetaSystemLine => {
  if (event.action === 'unreact') {
    return { kind: 'reaction', emoji: null };
  }
  const emoji = (event.emoji ?? '').slice(0, REACTION_EMOJI_MAX_LENGTH);

  return emoji === '' ? { kind: 'reactionPlain' } : { kind: 'reaction', emoji };
};
