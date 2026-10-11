import { escapeHtml, type MetaInboundMessage, sanitizeMessageBody } from '@helpdock/channels';
import type {
  Contact as ContactRow,
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import type { AttachmentRejectReason, IdentitySource, MetaPlatform } from '@helpdock/schemas';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { requestAutoAssign } from '../assignment/assignment-events.js';
import { routesAutomatically } from '../assignment/ticket-assignment.js';
import { ContactFailure } from '../contacts/contact-failure.js';
import { attachVerifiedIdentity, findOrCreateContactByIdentity } from '../contacts/identity.js';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type {
  LifecycleContext,
  TicketLifecycleService,
} from '../tickets/lifecycle/lifecycle.service.js';
import { type ActivityActor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import type { TicketRepository } from '../tickets/tickets.repository.js';
import { subjectFrom } from '../widget/plain-text.js';
import type { MetaAttachmentSink } from './deferred-sink.js';
import type { MetaRepository } from './meta.repository.js';

/**
 * M10-03: where a message from WhatsApp, Messenger or Instagram lands
 * (ARCHITECTURE §8: "`customer id` = identity; one open ticket per
 * conversation"). The same shape as `TelegramConversationRouter`, for the same
 * reasons, and one router for all three platforms.
 *
 * ```
 * find the contact by the platform's id    (§4.4, §4.7: verified, a webhook Meta signed)
 *   WhatsApp: record the wa_id as a verified phone on that contact
 * the conversation's ticket, if it has one
 *   └ follow a merge to its primary          (§2.4)
 *   yes → a customer reply on it             (§2.2 rows 1 and 5, §2.3's reopen policy —
 *                                             the same call email, the widget and Telegram make)
 *   no  → a new ticket in the account's department, channel = the platform
 * ```
 *
 * A conversation is one customer talking to one account: a thread has no
 * subject or reply-to to weigh, Meta vouches for who, and nobody else can write
 * into it. The ticket the message lands on becomes the conversation's, so a
 * continuation that the reopen policy opened is where the next message goes.
 *
 * The message's **files** are not fetched here. They arrive as references
 * (`message.meta.fileRefs`) and the sink writes them `pending` with a
 * `meta.media` outbox row (`deferred-sink.ts`), so the webhook answers in
 * seconds whatever the customer attached.
 *
 * Everything runs in the caller's transaction, for one brand, as the system
 * principal (DOMAIN-RULES §1.4), and writes the same `ticket_activity` and
 * `outbox` rows a person's change leaves.
 */

export interface MetaRouteContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  /** The number, Page or account the message came to: its department takes a new ticket. */
  readonly account: {
    readonly id: string;
    readonly departmentId: string;
    readonly platform: MetaPlatform;
    readonly externalId: string;
  };
  readonly now: Date;
}

/** What else a caller knows about the message that the adapter's output does not carry. */
export interface MetaRouteOptions {
  /**
   * Meta attached an error to the message's files (it could not serve them):
   * they are recorded rejected with this reason and nothing is fetched.
   */
  readonly fileRefusal?: AttachmentRejectReason;
}

export type MetaRouteOutcome = {
  readonly kind: 'created' | 'replied';
  readonly ticketId: string;
  readonly messageId: string;
  readonly contactId: string;
  readonly conversationId: string;
};

export interface MetaRouterLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface MetaRouterDependencies {
  readonly meta: MetaRepository;
  readonly tickets: TicketRepository;
  readonly lifecycle: TicketLifecycleService;
  readonly lifecycleReads: TicketLifecycleRepository;
  readonly assignment: AssignmentRepository;
  readonly log: MetaRouterLog;
}

/** A chain of merges ends within a few hops; the bound only stops a cycle. */
const MAX_MERGE_HOPS = 5;

/** The source that makes each platform's id a verified identifier (DOMAIN-RULES §4.4). */
const IDENTITY_SOURCES: Readonly<Record<MetaPlatform, IdentitySource>> = {
  whatsapp: 'whatsapp.cloud',
  messenger: 'messenger.page',
  instagram: 'instagram.account',
};

/** How much of a quoted message the thread repeats above a reply. */
const QUOTE_MAX_CHARS = 200;

const quoteExcerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= QUOTE_MAX_CHARS ? flat : `${flat.slice(0, QUOTE_MAX_CHARS - 1).trimEnd()}…`;
};

/** A ticket a message can still be added to, and the status that says so. */
export interface FollowedTicket {
  readonly ticket: TicketRow;
  readonly status: TicketStatusRow;
}

export class MetaConversationRouter {
  readonly #deps: MetaRouterDependencies;

  constructor(deps: MetaRouterDependencies) {
    this.#deps = deps;
  }

  /**
   * The contact behind a customer, found or created (DOMAIN-RULES §4.4), and
   * for WhatsApp the number Meta sent beside the user id recorded on it as a
   * verified phone. A number that does not normalise, or that two contacts
   * hold with proof, never costs the message: Meta would redeliver it for
   * days to no purpose.
   */
  async contactFor(
    tx: DbTransaction,
    brandId: string,
    message: Pick<MetaInboundMessage, 'from' | 'meta'>,
  ): Promise<ContactRow> {
    const { platform, waId } = message.meta;
    const { contact } = await findOrCreateContactByIdentity(
      tx,
      brandId,
      { kind: platform, value: message.from.value, source: IDENTITY_SOURCES[platform] },
      message.from.name === null ? {} : { name: message.from.name },
    );

    if (platform === 'whatsapp' && waId !== null) {
      await this.#recordPhone(tx, brandId, contact.id, waId);
    }
    return contact;
  }

  async route(
    context: MetaRouteContext,
    message: MetaInboundMessage,
    sink: MetaAttachmentSink,
    options: MetaRouteOptions = {},
  ): Promise<MetaRouteOutcome> {
    const { tx, brandId, account } = context;
    const { meta } = message;
    const contact = await this.contactFor(tx, brandId, message);
    const conversation = await this.#deps.meta.upsertConversation(tx, {
      brandId,
      accountId: account.id,
      customerId: meta.customerId,
      contactId: contact.id,
      waId: meta.waId,
      profileName: meta.profileName,
      username: meta.username,
      inbound: { at: message.receivedAt, messageId: meta.messageId },
    });

    const current =
      conversation.ticketId === null
        ? undefined
        : await this.followMerge(tx, conversation.ticketId);
    const actor = actorFor(account.id);
    const outcome =
      current === undefined
        ? await this.#create(context, message, contact.id, actor, sink, options)
        : await this.#reply(context, current, message, contact.id, actor, sink, options);

    await this.#deps.meta.setConversationTicket(tx, conversation.id, outcome.ticketId);
    return { ...outcome, contactId: contact.id, conversationId: conversation.id };
  }

  /** The ticket a merge ended in, with its status, or undefined when it is gone. */
  async followMerge(tx: DbTransaction, ticketId: string): Promise<FollowedTicket | undefined> {
    let next: string | null = ticketId;
    for (let hop = 0; next !== null && hop < MAX_MERGE_HOPS; hop += 1) {
      const found = await this.#deps.tickets.findTicket(tx, next);
      if (found === undefined) {
        return undefined;
      }
      if (found.ticket.mergedIntoId === null) {
        return found;
      }
      next = found.ticket.mergedIntoId;
    }
    return undefined;
  }

  /**
   * The ticket a system line may be added to: the merge's end, if it is neither
   * closed nor spam. A line on a closed thread would be the only thing in it
   * since the agent left, and nobody opens a closed ticket to read it.
   */
  async openTicket(tx: DbTransaction, ticketId: string): Promise<TicketRow | undefined> {
    const found = await this.followMerge(tx, ticketId);
    return found === undefined || found.status.isSpam || found.status.systemState === 'closed'
      ? undefined
      : found.ticket;
  }

  /**
   * A line in the thread that no person wrote: "the customer sent something
   * that cannot be shown here", a reaction, a changed number. `text` is
   * escaped here, because some of these carry what the customer sent (an
   * emoji). `externalMessageId` is the platform's id for the event that caused
   * the line, when it has one, so the dedupe key holds for it too.
   */
  async writeSystemLine(
    tx: DbTransaction,
    input: {
      readonly ticket: TicketRow;
      readonly accountId: string;
      readonly text: string;
      readonly externalMessageId?: string;
    },
  ): Promise<string> {
    const { ticket } = input;
    const row = await this.#deps.tickets.insertMessage(tx, {
      brandId: ticket.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      seq: await this.#deps.tickets.nextSeq(tx, ticket.id),
      kind: 'system',
      authorType: 'system',
      authorId: actorFor(input.accountId).actorId,
      bodyHtml: `<p>${escapeHtml(input.text)}</p>`,
      bodyText: input.text,
      channel: ticket.channel,
      ...(input.externalMessageId === undefined
        ? {}
        : { externalMessageId: input.externalMessageId }),
    });
    return row.id;
  }

  async #recordPhone(
    tx: DbTransaction,
    brandId: string,
    contactId: string,
    waId: string,
  ): Promise<void> {
    try {
      const attached = await attachVerifiedIdentity(tx, brandId, contactId, {
        kind: 'phone',
        value: `+${waId}`,
        source: 'whatsapp.cloud',
      });
      if (attached.plan === 'suggest') {
        // Two contacts each proved this number: an agent merges them, if they are one person.
        this.#deps.log.warn(
          { contactId, otherContactId: attached.otherContactId },
          'a verified WhatsApp number is already held by another contact; suggested as a duplicate',
        );
      }
    } catch (error) {
      if (!(error instanceof ContactFailure)) {
        throw error;
      }
      this.#deps.log.warn({ contactId }, 'a WhatsApp number is not a phone number; not recorded');
    }
  }

  async #create(
    context: MetaRouteContext,
    message: MetaInboundMessage,
    contactId: string,
    actor: ActivityActor,
    sink: MetaAttachmentSink,
    options: MetaRouteOptions,
  ): Promise<Omit<MetaRouteOutcome, 'contactId' | 'conversationId'>> {
    const { tx, brandId } = context;
    const { tickets: repository, lifecycleReads } = this.#deps;
    const status = await repository.findDefaultStatus(tx);
    const prefix = await repository.brandPrefix(tx, brandId);
    /* c8 ignore next 3 -- every brand is seeded with its statuses and has a prefix. */
    if (status === undefined || prefix === undefined) {
      throw new Error('This brand has no default status or no ticket prefix');
    }
    const locale = await lifecycleReads.localeForContact(tx, brandId, contactId);

    const ticket = await repository.insertTicket(tx, {
      brandId,
      departmentId: context.account.departmentId,
      number: await repository.nextNumber(tx, brandId),
      prefix,
      subject: subjectFrom(message.bodyText, locale),
      statusId: status.id,
      priority: 'medium',
      channel: context.account.platform,
      contactId,
    });
    const messageId = await this.#writeMessage(
      context,
      { ticket, seq: 1, mayQuote: false },
      message,
      contactId,
      sink,
      options,
    );

    await writeTicketActivity(tx, {
      brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      actor,
      action: 'ticket.created',
      to: { subject: ticket.subject, statusId: status.id, priority: ticket.priority },
    });
    // M3-02: the clocks start when the conversation opens, as for any ticket.
    await this.#deps.lifecycle.onCreated(
      { ...lifecycleContext(context, actor), now: ticket.createdAt },
      ticket,
      status,
    );
    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.created, {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
    });
    if (await routesAutomatically(this.#deps.assignment, tx, ticket.departmentId)) {
      await requestAutoAssign(tx, brandId, { ticketId: ticket.id, trigger: 'routed' });
    }

    return { kind: 'created', ticketId: ticket.id, messageId };
  }

  /** A spam ticket is left where it is, as email leaves it: nothing reopens it. */
  async #reply(
    context: MetaRouteContext,
    current: FollowedTicket,
    message: MetaInboundMessage,
    contactId: string,
    actor: ActivityActor,
    sink: MetaAttachmentSink,
    options: MetaRouteOptions,
  ): Promise<Omit<MetaRouteOutcome, 'contactId' | 'conversationId'>> {
    const { tx, brandId } = context;
    const repository = this.#deps.tickets;
    // Locks the ticket row first, so two messages from one customer take turns.
    let seq = await repository.nextSeq(tx, current.ticket.id);
    const target = current.status.isSpam
      ? current.ticket
      : (
          await this.#deps.lifecycle.onCustomerReply(
            lifecycleContext(context, actor),
            current.ticket,
            current.status,
          )
        ).ticket;
    if (target.id !== current.ticket.id) {
      seq = await repository.nextSeq(tx, target.id);
    }

    const messageId = await this.#writeMessage(
      context,
      { ticket: target, seq, mayQuote: true },
      message,
      contactId,
      sink,
      options,
    );
    await writeTicketActivity(tx, {
      brandId,
      ticketId: target.id,
      departmentId: target.departmentId,
      actor,
      action: 'ticket.replied',
      to: { messageId, seq },
    });
    await repository.updateTicket(tx, target.id, {});
    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.replied, {
      ticketId: target.id,
      departmentId: target.departmentId,
      messageId,
      seq,
      kind: 'public',
    });

    return { kind: 'replied', ticketId: target.id, messageId };
  }

  async #writeMessage(
    context: MetaRouteContext,
    { ticket, seq, mayQuote }: { ticket: TicketRow; seq: number; mayQuote: boolean },
    message: MetaInboundMessage,
    contactId: string,
    sink: MetaAttachmentSink,
    options: MetaRouteOptions,
  ): Promise<string> {
    const body = mayQuote
      ? await this.#withQuote(context, ticket, message)
      : { html: message.bodyHtml, text: message.bodyText };
    const row = await this.#deps.tickets.insertMessage(context.tx, {
      brandId: context.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      seq,
      kind: 'public',
      authorType: 'contact',
      authorId: contactId,
      bodyHtml: body.html,
      bodyText: body.text,
      channel: context.account.platform,
      externalMessageId: message.externalId,
    });

    if (message.meta.fileRefs.length > 0) {
      await sink.store(context.tx, {
        brandId: context.brandId,
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
        messageId: row.id,
        contactId,
        accountId: context.account.id,
        refs: message.meta.fileRefs,
        ids: message.meta.fileRefs.map(() => uuidv7()),
        ...(options.fileRefusal === undefined ? {} : { refusal: options.fileRefusal }),
      });
    }

    return row.id;
  }

  /**
   * DOMAIN-RULES §4.8: a message that quotes an earlier one carries the quoted
   * words above its own, **when the quoted message is on this ticket**. One on
   * another ticket would put a stranger's words from an older conversation in
   * front of whoever reads this one, and a message the desk never filed has
   * nothing to quote.
   */
  async #withQuote(
    context: MetaRouteContext,
    ticket: TicketRow,
    message: MetaInboundMessage,
  ): Promise<{ html: string; text: string }> {
    const { quotedId, platform } = message.meta;
    const quoted =
      quotedId === null
        ? undefined
        : await this.#deps.meta.messageByPlatformId(
            context.tx,
            context.brandId,
            platform,
            quotedId,
          );
    const excerpt = quoted?.ticketId === ticket.id ? quoteExcerpt(quoted.bodyText) : '';
    if (excerpt === '') {
      return { html: message.bodyHtml, text: message.bodyText };
    }

    const body = sanitizeMessageBody(
      `<blockquote><p>${escapeHtml(excerpt)}</p></blockquote>${message.bodyHtml}`,
    );
    return { html: body.html, text: body.text };
  }
}

const actorFor = (accountId: string): ActivityActor => ({
  actorType: 'system',
  actorId: `meta:${accountId}`,
  via: 'system',
});

const lifecycleContext = (context: MetaRouteContext, actor: ActivityActor): LifecycleContext => ({
  tx: context.tx,
  brandId: context.brandId,
  actor,
  now: context.now,
});
