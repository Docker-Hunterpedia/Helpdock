import type { TelegramInboundMessage } from '@helpdock/channels';
import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { requestAutoAssign } from '../assignment/assignment-events.js';
import { routesAutomatically } from '../assignment/ticket-assignment.js';
import type { AttachmentSink } from '../channels/inbound/conversation-router.js';
import { findOrCreateContactByIdentity } from '../contacts/identity.js';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type {
  LifecycleContext,
  TicketLifecycleService,
} from '../tickets/lifecycle/lifecycle.service.js';
import { type ActivityActor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import type { TicketRepository } from '../tickets/tickets.repository.js';
import { subjectFrom } from '../widget/plain-text.js';
import type { TelegramRepository } from './telegram.repository.js';

/**
 * M6-02: where a Telegram message lands (ARCHITECTURE §8: "`chat_id` =
 * identity; open ticket per chat").
 *
 * ```
 * find the contact by chat id            (§4.4: verified, it comes from the Bot API)
 * the chat's ticket, if it has one
 *   └ follow a merge to its primary      (§2.4)
 *   yes → a customer reply on it         (§2.2 rows 1 and 5, §2.3's reopen policy —
 *                                         the same call email and the widget make)
 *   no  → a new ticket in the bot's department
 * ```
 *
 * There is no thread hint to weigh, unlike email's §4.3: a chat is one person,
 * Telegram vouches for who, and nobody else can write into it. The ticket the
 * message lands on becomes the chat's, so a continuation ticket that the
 * reopen policy opened is where the next message goes too.
 *
 * Everything runs in the caller's transaction, for one brand, as the system
 * principal (DOMAIN-RULES §1.4), and writes the same `ticket_activity` and
 * `outbox` rows a person's change leaves.
 */

export interface TelegramRouteContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly bot: { readonly id: string; readonly departmentId: string };
  readonly now: Date;
}

export type TelegramRouteOutcome = {
  readonly kind: 'created' | 'replied';
  readonly ticketId: string;
  readonly messageId: string;
  readonly contactId: string;
};

export interface TelegramRouterDependencies {
  readonly telegram: TelegramRepository;
  readonly tickets: TicketRepository;
  readonly lifecycle: TicketLifecycleService;
  readonly lifecycleReads: TicketLifecycleRepository;
  readonly assignment: AssignmentRepository;
}

/** A chain of merges ends within a few hops; the bound only stops a cycle. */
const MAX_MERGE_HOPS = 5;

export class TelegramConversationRouter {
  readonly #deps: TelegramRouterDependencies;

  constructor(deps: TelegramRouterDependencies) {
    this.#deps = deps;
  }

  /** The contact behind a chat, found or created (DOMAIN-RULES §4.4). */
  async contactFor(
    tx: DbTransaction,
    brandId: string,
    sender: { readonly chatId: string; readonly name: string | null },
  ) {
    const { contact } = await findOrCreateContactByIdentity(
      tx,
      brandId,
      { kind: 'telegram', value: sender.chatId, source: 'telegram.bot' },
      sender.name === null ? {} : { name: sender.name },
    );
    return contact;
  }

  async route(
    context: TelegramRouteContext,
    message: TelegramInboundMessage,
    sink: AttachmentSink,
  ): Promise<TelegramRouteOutcome> {
    const { tx, brandId } = context;
    const contact = await this.contactFor(tx, brandId, {
      chatId: message.telegram.chatId,
      name: message.from.name,
    });
    const chat = await this.#deps.telegram.upsertChat(tx, {
      brandId,
      botId: context.bot.id,
      chatId: message.telegram.chatId,
      contactId: contact.id,
      at: context.now,
      username: message.telegram.username,
    });

    const current = chat.ticketId === null ? undefined : await this.#follow(tx, chat.ticketId);
    const outcome =
      current === undefined
        ? await this.#create(context, message, contact.id, actorFor(context), sink)
        : await this.#reply(context, current, message, contact.id, actorFor(context), sink);

    await this.#deps.telegram.setChatTicket(tx, chat.id, outcome.ticketId);
    return { ...outcome, contactId: contact.id };
  }

  async #follow(
    tx: DbTransaction,
    ticketId: string,
  ): Promise<{ ticket: TicketRow; status: TicketStatusRow } | undefined> {
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

  async #create(
    context: TelegramRouteContext,
    message: TelegramInboundMessage,
    contactId: string,
    actor: ActivityActor,
    sink: AttachmentSink,
  ): Promise<Omit<TelegramRouteOutcome, 'contactId'>> {
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
      departmentId: context.bot.departmentId,
      number: await repository.nextNumber(tx, brandId),
      prefix,
      subject: subjectFrom(message.bodyText, locale),
      statusId: status.id,
      priority: 'medium',
      channel: 'telegram',
      contactId,
    });
    const messageId = await this.#writeMessage(context, ticket, 1, message, contactId, sink);

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
    context: TelegramRouteContext,
    current: { ticket: TicketRow; status: TicketStatusRow },
    message: TelegramInboundMessage,
    contactId: string,
    actor: ActivityActor,
    sink: AttachmentSink,
  ): Promise<Omit<TelegramRouteOutcome, 'contactId'>> {
    const { tx, brandId } = context;
    const repository = this.#deps.tickets;
    // Locks the ticket row first, so two messages from one chat take turns.
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

    const messageId = await this.#writeMessage(context, target, seq, message, contactId, sink);
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
    context: TelegramRouteContext,
    ticket: TicketRow,
    seq: number,
    message: TelegramInboundMessage,
    contactId: string,
    sink: AttachmentSink,
  ): Promise<string> {
    const row = await this.#deps.tickets.insertMessage(context.tx, {
      brandId: context.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      seq,
      kind: 'public',
      authorType: 'contact',
      authorId: contactId,
      bodyHtml: message.bodyHtml,
      bodyText: message.bodyText,
      channel: 'telegram',
      externalMessageId: message.externalId,
    });

    if (message.files.length > 0) {
      await sink.store(context.tx, {
        brandId: context.brandId,
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
        messageId: row.id,
        contactId,
        files: message.files,
        ids: message.files.map(() => uuidv7()),
      });
    }

    return row.id;
  }
}

const actorFor = (context: TelegramRouteContext): ActivityActor => ({
  actorType: 'system',
  actorId: `telegram:${context.bot.id}`,
  via: 'system',
});

const lifecycleContext = (
  context: TelegramRouteContext,
  actor: ActivityActor,
): LifecycleContext => ({ tx: context.tx, brandId: context.brandId, actor, now: context.now });
