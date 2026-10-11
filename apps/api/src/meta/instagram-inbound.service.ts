import {
  escapeHtml,
  type MetaEvent,
  type MetaInboundLabels,
  type MetaMessageEvent,
  toInstagramInboundMessage,
} from '@helpdock/channels';
import { decryptSecret, type Keyring, SecretDecryptionError } from '@helpdock/config';
import {
  type DbTransaction,
  type MetaAccount as MetaAccountRow,
  type MetaConversation as MetaConversationRow,
  metaDeliveries,
  type Ticket as TicketRow,
  ticketMessages,
} from '@helpdock/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { TicketRepository } from '../tickets/tickets.repository.js';
import type { DeferredAttachmentSink } from './deferred-sink.js';
import type { GraphClientFactory } from './graph-client-factory.js';
import { type InstagramProfile, needsProfile, readInstagramProfile } from './instagram-profile.js';
import {
  instantOf,
  quoteLine,
  REACTION_EMOJI_MAX_LENGTH,
  unsentExternalId,
} from './instagram-rules.js';
import type { MetaRepository } from './meta.repository.js';
import type {
  MetaEventContext,
  MetaEventOutcome,
  MetaInboundLog,
  PlatformInboundService,
} from './meta-inbound.service.js';
import { metaMessageSeen } from './meta-inbound-gate.js';
import type { MetaConversationRouter } from './meta-router.js';
import { metaText } from './meta-text.js';

/**
 * Instagram's events into one brand (M10-05, DOMAIN-RULES §4.7 and §4.8): the
 * platform half of the seam `MetaInboundService` fills. By the time `handle` is
 * called the dedupe on the `mid` and the block list have been checked for a
 * customer's message, so neither is repeated here.
 *
 * | The event is | What happens |
 * |---|---|
 * | `message` | the customer's profile is read once, then the router files it: a text, a story reply or mention, a shared post or reel as a line with its URL, files as `pending` attachments for `meta.media_fetch` |
 * | `echo` | dropped: Helpdock's own (by `app_id` or the delivery id in `metadata`) silently, any other counted |
 * | `deleted` | the message and its body stay; a system line "Unsent by the customer" marks it |
 * | `unsupported` | a system line on the conversation's ticket, counted; the customer did write, so the reply window moves |
 * | `seen` | the reply's delivery becomes `read` |
 * | `reaction` | a system line on the ticket the message is on |
 * | `postback`, `referral` and anything else | counted and dropped; never a message, never a window anchor |
 *
 * Nothing here is sent to the customer. The one call to Meta is the profile
 * read in {@link InstagramInboundService.handle}'s `message` path, which is
 * short, optional and never fails the message (`instagram-profile.ts`).
 */

export interface InstagramInboundServiceOptions {
  readonly repository: MetaRepository;
  readonly router: MetaConversationRouter;
  readonly sink: DeferredAttachmentSink;
  readonly tickets: TicketRepository;
  readonly lifecycleReads: TicketLifecycleRepository;
  readonly graph: GraphClientFactory;
  readonly keyring: Keyring;
  /** The install's `meta.appId`, to recognise Helpdock's own echoes; empty when none is set. */
  readonly appId: () => Promise<string>;
  readonly log: MetaInboundLog;
}

/** A chain of merges ends within a few hops; the bound only stops a cycle. */
const MAX_MERGE_HOPS = 5;

const ignored = (reason: string): MetaEventOutcome => ({ outcome: 'ignored', reason });
const handled: MetaEventOutcome = { outcome: 'handled' };

/** A message of a conversation, wherever its ticket has gone. */
interface FoundMessage {
  readonly ticketId: string;
  readonly bodyText: string;
}

/** The words a message is filed with, in the contact's language. */
const labelsOf = (t: ReturnType<typeof metaText>): MetaInboundLabels => ({
  location: t('thread.location'),
  contact: t('thread.contact'),
  story: { reply: t('thread.story.reply'), mention: t('thread.story.mention') },
});

/** The three things the thread is told in a line of its own. */
type SystemLine =
  | { readonly kind: 'unsent' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'reaction'; readonly emoji: string };

const lineText = (t: ReturnType<typeof metaText>, line: SystemLine): string => {
  switch (line.kind) {
    case 'unsent':
      return t('thread.unsent');
    case 'unsupported':
      return t('thread.unsupported');
    case 'reaction':
      return line.emoji === ''
        ? t('thread.reactionPlain')
        : t('thread.reaction', { emoji: line.emoji });
  }
};

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
    const { repository, lifecycleReads } = this.#options;
    const conversation = await repository.conversation(tx, account.id, event.customerId);
    const profile = needsProfile(conversation)
      ? await this.#profile(account, event.customerId)
      : null;
    const t = metaText(
      await lifecycleReads.localeForContact(tx, account.brandId, conversation?.contactId ?? null),
    );
    const quote = await this.#quote(tx, account, conversation, event.quotedId);

    const message = toInstagramInboundMessage(
      {
        event: {
          ...event,
          ...(profile === null ? {} : { profileName: profile.name, username: profile.username }),
          text: [quote, event.text].filter((part) => part !== '').join('\n\n'),
        },
        accountExternalId: account.externalId,
        labels: labelsOf(t),
      },
      instantOf(event.timestamp, now),
    );
    await this.#options.router.route(
      { tx, brandId: account.brandId, account, now },
      message,
      this.#options.sink,
    );

    return handled;
  }

  /**
   * `GET /{igsid}?fields=name,username` on the Instagram root, with the
   * account's token. Never throws: a customer's message is worth more than
   * their name (`instagram-profile.ts`).
   */
  async #profile(account: MetaAccountRow, igsid: string): Promise<InstagramProfile | null> {
    let token: string;
    try {
      token = decryptSecret(account.accessToken, this.#options.keyring);
    } catch (error) {
      if (!(error instanceof SecretDecryptionError)) {
        throw error;
      }
      // The master key changed under the stored token. The failure's class is
      // enough to find it; its message is not logged.
      this.#options.log.warn(
        { accountId: account.id, reason: error.name },
        'could not read an instagram customer profile',
      );
      return null;
    }

    const result = await readInstagramProfile({ graph: this.#options.graph(), token, igsid });
    if (result.ok) {
      return result.profile;
    }
    this.#options.log.warn(
      { accountId: account.id, reason: result.reason, code: result.code },
      'could not read an instagram customer profile',
    );
    return null;
  }

  /**
   * DOMAIN-RULES §4.8: a text that answers an earlier message leads with that
   * message's text when it is on the conversation's ticket. A line of its own
   * ("> …"), because a ticket message has no field to hold a reference.
   */
  async #quote(
    tx: DbTransaction,
    account: MetaAccountRow,
    conversation: MetaConversationRow | undefined,
    quotedId: string | null,
  ): Promise<string> {
    if (quotedId === null || conversation?.ticketId == null) {
      return '';
    }
    const found = await this.#messageOf(tx, account, quotedId);

    return found?.ticketId === conversation.ticketId ? quoteLine(found.bodyText) : '';
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
      (await this.#isOurDelivery(tx, account, event.metadata));
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
    account: MetaAccountRow,
    metadata: string | null,
  ): Promise<boolean> {
    const id = z.uuid().safeParse(metadata);
    if (!id.success) {
      return false;
    }
    const delivery = await this.#options.repository.delivery(tx, id.data);

    return delivery?.accountId === account.id;
  }

  // -------------------------------------------------- unsent, unsupported

  /**
   * DOMAIN-RULES §4.8: an unsent message is kept and marked, never deleted. A
   * ticket message has no column for the mark, so it is a system line whose
   * external id is {@link unsentExternalId}: that is how the thread finds the
   * message it belongs to, and how a redelivered event is told from a new one.
   */
  async #unsent(
    { tx, account }: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'deleted' }>,
  ): Promise<MetaEventOutcome> {
    const marker = unsentExternalId(event.messageId);
    if (await metaMessageSeen(tx, account.brandId, 'instagram', marker)) {
      return { outcome: 'duplicate' };
    }
    const found = await this.#customerMessage(tx, account, event.messageId);
    if (found === undefined) {
      return ignored('message-unknown');
    }

    return this.#line(tx, account, found.ticketId, { kind: 'unsent' }, marker);
  }

  /**
   * Something Instagram says it sent that Helpdock cannot show. The customer
   * did write, so a conversation that exists has its reply window moved; the
   * thread gets a line. A first message that is unsupported has no ticket to
   * write on and is counted.
   */
  async #unsupported(
    { tx, account, now }: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'unsupported' }>,
  ): Promise<MetaEventOutcome> {
    const { repository } = this.#options;
    const conversation =
      event.customerId === null
        ? undefined
        : await repository.conversation(tx, account.id, event.customerId);
    this.#options.log.info(
      { accountId: account.id, platform: 'instagram', kind: 'unsupported', detail: event.detail },
      'instagram message that cannot be shown',
    );
    if (event.customerId === null || conversation === undefined) {
      return ignored('no-ticket');
    }
    if (
      event.messageId !== null &&
      (await metaMessageSeen(tx, account.brandId, 'instagram', event.messageId))
    ) {
      return { outcome: 'duplicate' };
    }

    await repository.upsertConversation(tx, {
      brandId: account.brandId,
      accountId: account.id,
      customerId: event.customerId,
      contactId: conversation.contactId,
      waId: null,
      profileName: null,
      username: null,
      inbound:
        event.messageId === null
          ? null
          : { at: instantOf(event.timestamp, now), messageId: event.messageId },
    });
    if (conversation.ticketId === null) {
      return ignored('no-ticket');
    }

    return this.#line(
      tx,
      account,
      conversation.ticketId,
      { kind: 'unsupported' },
      event.messageId ?? undefined,
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

    return delivery === undefined ? ignored('no-delivery') : handled;
  }

  /** A reaction is a line on the ticket the message is on: never a message, never a window anchor. */
  async #reaction(
    { tx, account }: MetaEventContext,
    event: Extract<MetaEvent, { kind: 'reaction' }>,
  ): Promise<MetaEventOutcome> {
    if (event.action === 'unreact') {
      return ignored('unreact');
    }
    const found = await this.#messageOf(tx, account, event.messageId);
    if (found === undefined) {
      return ignored('message-unknown');
    }
    const emoji = event.emoji?.slice(0, REACTION_EMOJI_MAX_LENGTH) ?? '';

    return this.#line(tx, account, found.ticketId, { kind: 'reaction', emoji });
  }

  // ------------------------------------------------------------- lookups

  /** The customer's public message with this `mid`: the only kind that can be unsent. */
  async #customerMessage(
    tx: DbTransaction,
    account: MetaAccountRow,
    mid: string,
  ): Promise<FoundMessage | undefined> {
    const rows = await tx
      .select({ ticketId: ticketMessages.ticketId, bodyText: ticketMessages.bodyText })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.brandId, account.brandId),
          eq(ticketMessages.channel, 'instagram'),
          eq(ticketMessages.externalMessageId, mid),
          eq(ticketMessages.kind, 'public'),
          eq(ticketMessages.authorType, 'contact'),
        ),
      )
      .limit(1);

    return rows[0];
  }

  /**
   * A message of this account's conversations by the `mid` Meta gave it: the
   * customer's (its `external_message_id`), or a reply of ours (the ids its
   * delivery recorded).
   */
  async #messageOf(
    tx: DbTransaction,
    account: MetaAccountRow,
    mid: string,
  ): Promise<FoundMessage | undefined> {
    const theirs = await this.#customerMessage(tx, account, mid);
    if (theirs !== undefined) {
      return theirs;
    }
    const rows = await tx
      .select({ ticketId: ticketMessages.ticketId, bodyText: ticketMessages.bodyText })
      .from(metaDeliveries)
      .innerJoin(ticketMessages, eq(ticketMessages.id, metaDeliveries.ticketMessageId))
      .where(
        and(
          eq(metaDeliveries.accountId, account.id),
          sql`${mid} = any(${metaDeliveries.platformMessageIds})`,
        ),
      )
      .limit(1);

    return rows[0];
  }

  // ---------------------------------------------------------- system lines

  /**
   * One system line in the contact's language, on the primary of `ticketId`'s
   * merges (an agent works the primary; the secondary is closed). The words
   * are the catalog's and, for a reaction, the customer's emoji, capped; the
   * body is escaped because the catalog does not escape what it interpolates.
   */
  async #line(
    tx: DbTransaction,
    account: MetaAccountRow,
    ticketId: string,
    line: SystemLine,
    externalId?: string,
  ): Promise<MetaEventOutcome> {
    const ticket = await this.#follow(tx, ticketId);
    if (ticket === undefined) {
      return ignored('ticket-gone');
    }
    const locale = await this.#options.lifecycleReads.localeForContact(
      tx,
      account.brandId,
      ticket.contactId,
    );
    const text = lineText(metaText(locale), line);
    const { tickets } = this.#options;
    await tickets.insertMessage(tx, {
      brandId: account.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      seq: await tickets.nextSeq(tx, ticket.id),
      kind: 'system',
      authorType: 'system',
      authorId: `meta:${account.id}`,
      bodyHtml: `<p>${escapeHtml(text)}</p>`,
      bodyText: text,
      channel: 'instagram',
      ...(externalId === undefined ? {} : { externalMessageId: externalId }),
    });

    return handled;
  }

  async #follow(tx: DbTransaction, ticketId: string): Promise<TicketRow | undefined> {
    let next: string | null = ticketId;
    for (let hop = 0; next !== null && hop < MAX_MERGE_HOPS; hop += 1) {
      const found = await this.#options.tickets.findTicket(tx, next);
      if (found === undefined) {
        return undefined;
      }
      if (found.ticket.mergedIntoId === null) {
        return found.ticket;
      }
      next = found.ticket.mergedIntoId;
    }
    return undefined;
  }
}
