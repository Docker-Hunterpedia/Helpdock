import { bareMessageId, type EmailInboundMessage } from '@helpdock/channels';
import {
  contactIdentities,
  type DbTransaction,
  emailDeliveries,
  type Ticket as TicketRow,
  type TicketStatus as TicketStatusRow,
  ticketMessages,
  ticketParticipants,
  tickets,
  users,
  uuidv7,
} from '@helpdock/db';
import { createI18n, type Locale } from '@helpdock/i18n';
import type { EmailMessageMeta } from '@helpdock/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AssignmentRepository } from '../../assignment/assignment.repository.js';
import { requestAutoAssign } from '../../assignment/assignment-events.js';
import { routesAutomatically } from '../../assignment/ticket-assignment.js';
import { findOrCreateByAddress, findOrCreateContactByIdentity } from '../../contacts/identity.js';
import type { TicketParticipantsService } from '../../participants/ticket-participants.service.js';
import type { TicketLifecycleRepository } from '../../tickets/lifecycle/lifecycle.repository.js';
import type {
  LifecycleContext,
  TicketLifecycleService,
} from '../../tickets/lifecycle/lifecycle.service.js';
import { type ActivityActor, writeTicketActivity } from '../../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../../tickets/ticket-events.js';
import type { TicketRepository } from '../../tickets/tickets.repository.js';

/**
 * M2-01's `ConversationRouter` (ARCHITECTURE §8) with M2-04's threading rule
 * (DOMAIN-RULES §4.3): an inbound message becomes a reply on an existing
 * ticket or a new ticket, and the rule that decides which is one function.
 *
 * ```
 * find the contact by identity          (§4.4: an inbound From is verified)
 * find a ticket by thread hint           In-Reply-To / References, or [PREFIX-N]
 *   └ follow a merge to its primary      (§2.4: messages are not moved)
 * sender is a participant of it?         (§2.5: contact, CCs, staff)
 *   yes → a customer reply on it         (§2.2 rows 1 and 5, §2.3's reopen policy)
 *   no  → a new ticket in its department, with "Referenced HD-1042 but sender
 *         is not a participant"
 * no hint → a new ticket in the mailbox's department
 * ```
 *
 * The second branch is the security property: knowing a ticket number, or
 * quoting a `Message-ID` from a forwarded email, never lets a stranger read or
 * write someone else's thread.
 *
 * Everything runs in the caller's transaction, for one brand, as the system
 * principal (DOMAIN-RULES §1.4); every write it makes is the same pair of rows
 * a person's change leaves — `ticket_activity` and `outbox` — so the queue,
 * the sockets, assignment and M3's rules see an emailed ticket exactly as they
 * see one typed into the admin.
 */

/** Where the message came in, and who files it. */
export interface RouteContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  /** The mailbox: its department takes a new ticket, its policy the remote images. */
  readonly mailbox: {
    readonly id: string;
    readonly departmentId: string;
    readonly remoteImages: 'block' | 'proxy';
    readonly authFailureIsSpam: boolean;
  };
  /** Every address a mailbox of this brand receives for: never copied in as a CC. */
  readonly ownAddresses: ReadonlySet<string>;
  readonly now: Date;
}

/** Files that will be written as the message's attachments; see `AttachmentSink`. */
export interface PlannedAttachment {
  readonly id: string;
  readonly index: number;
}

export interface AttachmentSink {
  /**
   * Stores the message's files against `messageId` in `tx`, with the ids it
   * was handed so the body's `cid:` images can be named before the rows exist.
   */
  store(
    tx: DbTransaction,
    input: {
      readonly brandId: string;
      readonly ticketId: string;
      readonly departmentId: string;
      readonly messageId: string;
      readonly contactId: string;
      readonly files: EmailInboundMessage['files'];
      readonly ids: readonly string[];
    },
  ): Promise<void>;
}

export type RouteOutcome =
  | { readonly kind: 'replied'; readonly ticketId: string; readonly messageId: string }
  | {
      readonly kind: 'created';
      readonly ticketId: string;
      readonly messageId: string;
      /** The ticket the sender referenced but may not thread into (§4.3). */
      readonly mismatchOf: string | null;
      /** Filed under Spam (M2-07): never auto-replied, since its sender may be forged. */
      readonly spam: boolean;
    };

/** How many copied-in addresses one message may add; a mailing blast is not a CC line. */
export const MAX_CC_PER_MESSAGE = 20;

interface ThreadCandidate {
  readonly ticket: TicketRow;
  readonly status: TicketStatusRow;
}

export interface ConversationRouterDependencies {
  readonly tickets: TicketRepository;
  readonly lifecycle: TicketLifecycleService;
  readonly lifecycleReads: TicketLifecycleRepository;
  readonly participants: TicketParticipantsService;
  readonly assignment: AssignmentRepository;
}

export class ConversationRouter {
  readonly #deps: ConversationRouterDependencies;

  constructor(deps: ConversationRouterDependencies) {
    this.#deps = deps;
  }

  async route(
    context: RouteContext,
    message: EmailInboundMessage,
    sink: AttachmentSink,
  ): Promise<RouteOutcome> {
    const { tx, brandId } = context;
    const actor = actorFor(context);
    const { contact } = await findOrCreateContactByIdentity(
      tx,
      brandId,
      { kind: 'email', value: message.from.value, source: 'email.inbound' },
      message.from.name === null ? {} : { name: message.from.name },
    );

    const candidate = await this.#threadCandidate(tx, brandId, message);
    const sender = message.from.value.toLowerCase();

    let outcome: RouteOutcome;
    let target: TicketRow;
    if (candidate !== undefined && (await isParticipant(tx, candidate.ticket, sender))) {
      const replied = await this.#reply(context, actor, candidate, message, contact.id, sink);
      outcome = { kind: 'replied', ticketId: replied.ticket.id, messageId: replied.messageId };
      target = replied.ticket;
    } else {
      const created = await this.#create(
        context,
        actor,
        message,
        contact.id,
        candidate?.ticket,
        sink,
      );
      outcome = {
        kind: 'created',
        ticketId: created.ticket.id,
        messageId: created.messageId,
        mismatchOf: candidate?.ticket.id ?? null,
        spam: created.spam,
      };
      target = created.ticket;
    }

    await this.#copyIn(context, target, message, contact.id);

    return outcome;
  }

  // ------------------------------------------------------------------ threading

  /**
   * The ticket a hint names, if any (§4.3 part 1). A `Message-ID` Helpdock
   * sent or received on a ticket wins over a subject token, because it cannot
   * be typed by accident; a token is read only for the brand's own prefix.
   * A merged ticket stands for its primary (§2.4), and a deleted one for
   * nothing.
   */
  async #threadCandidate(
    tx: DbTransaction,
    brandId: string,
    message: EmailInboundMessage,
  ): Promise<ThreadCandidate | undefined> {
    let ticketId: string | undefined;

    if (message.hints.messageIds.length > 0) {
      const byId = await this.#ticketsByMessageId(tx, brandId, message.hints.messageIds);
      ticketId = message.hints.messageIds.map((id) => byId.get(id)).find((id) => id !== undefined);
    }

    if (ticketId === undefined && message.hints.ticketNumbers.length > 0) {
      const prefix = await this.#deps.tickets.brandPrefix(tx, brandId);
      const token = message.hints.ticketNumbers.find((hint) => hint.prefix === prefix);
      if (token !== undefined) {
        const rows = await tx
          .select({ id: tickets.id })
          .from(tickets)
          .where(and(eq(tickets.brandId, brandId), eq(tickets.number, token.number)))
          .limit(1);
        ticketId = rows[0]?.id;
      }
    }

    // A chain of merges ends at a primary within a few hops; the bound only
    // stops a cycle nothing should ever have written from looping forever.
    for (let hop = 0; ticketId !== undefined && hop < 5; hop += 1) {
      const found = await this.#deps.tickets.findTicket(tx, ticketId);
      if (found === undefined) {
        return undefined;
      }
      if (found.ticket.mergedIntoId === null) {
        return found;
      }
      ticketId = found.ticket.mergedIntoId;
    }

    return undefined;
  }

  /**
   * The ticket behind each `Message-ID` Helpdock knows, bare (`id@host`).
   * Mail we received is in `ticket_messages.external_message_id`. Mail we
   * sent is in `email_deliveries.message_id`, the header the send job wrote
   * (`<hd.m.…@domain>` for a reply, `<hd.a.…>` / `<hd.o.…>` for an
   * auto-reply). Reading the delivery rather than parsing the `hd.*` form
   * means the id is only ever one we really sent, whatever domain it carried,
   * and a customer's answer to an acknowledgment threads as well as one to an
   * agent. The external id stays the inbound dedupe key, so our own ids are
   * never written there.
   */
  async #ticketsByMessageId(
    tx: DbTransaction,
    brandId: string,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const received = await tx
      .select({ ticketId: ticketMessages.ticketId, externalId: ticketMessages.externalMessageId })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.brandId, brandId),
          inArray(ticketMessages.externalMessageId, [...ids]),
        ),
      );
    const sent = await tx
      .select({ ticketId: emailDeliveries.ticketId, messageId: emailDeliveries.messageId })
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.brandId, brandId),
          inArray(
            emailDeliveries.messageId,
            ids.map((id) => `<${id}>`),
          ),
        ),
      );

    const byId = new Map<string, string>();
    for (const row of sent) {
      byId.set(bareMessageId(row.messageId), row.ticketId);
    }
    for (const row of received) {
      if (row.externalId !== null) {
        byId.set(row.externalId, row.ticketId);
      }
    }

    return byId;
  }

  // -------------------------------------------------------------------- writes

  async #create(
    context: RouteContext,
    actor: ActivityActor,
    message: EmailInboundMessage,
    contactId: string,
    referenced: TicketRow | undefined,
    sink: AttachmentSink,
  ): Promise<{ ticket: TicketRow; messageId: string; spam: boolean }> {
    const { tx, brandId } = context;
    const { tickets: repository, lifecycleReads } = this.#deps;
    const status = await repository.findDefaultStatus(tx);
    const prefix = await repository.brandPrefix(tx, brandId);
    /* c8 ignore next 3 -- every brand is seeded with its statuses and has a prefix. */
    if (status === undefined || prefix === undefined) {
      throw new Error('This brand has no default status or no ticket prefix');
    }
    const locale = await lifecycleReads.localeForContact(tx, brandId, contactId);

    // §4.3: a mismatch is filed "in the same department" as the ticket it
    // named, so the people who know that conversation see the stranger's mail.
    const departmentId = referenced?.departmentId ?? context.mailbox.departmentId;
    const ticket = await repository.insertTicket(tx, {
      brandId,
      departmentId,
      number: await repository.nextNumber(tx, brandId),
      prefix,
      subject: subjectOf(message.subject, locale),
      statusId: status.id,
      priority: 'medium',
      channel: 'email',
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

    if (referenced !== undefined) {
      await this.#writeMismatchNote(context, actor, ticket, referenced, locale);
    }

    // M3-02: the clocks start from the moment the ticket was filed (§3.1), as
    // they do for a ticket created through `TicketsService.create`.
    await this.#deps.lifecycle.onCreated(
      { ...lifecycleContext(context, actor), now: ticket.createdAt },
      ticket,
      status,
    );

    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.created, {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
    });

    // M2-07. Filed under Spam rather than dropped: a forwarded message fails
    // SPF honestly, and an agent can take it back out with "Not spam".
    const spam = context.mailbox.authFailureIsSpam && message.email.authFailed;
    if (spam) {
      await this.#deps.lifecycle.markSpam(lifecycleContext(context, actor), ticket, status);
    } else if (await routesAutomatically(this.#deps.assignment, tx, ticket.departmentId)) {
      await requestAutoAssign(tx, brandId, { ticketId: ticket.id, trigger: 'routed' });
    }

    return { ticket, messageId, spam };
  }

  /**
   * A customer's reply on the ticket it threads into: §2.2's rows 1 and 5
   * decide where it lands, as they do for a reply typed anywhere else. A spam
   * ticket is left where it is — mail from a sender an agent called spam does
   * not reopen anything.
   */
  async #reply(
    context: RouteContext,
    actor: ActivityActor,
    candidate: ThreadCandidate,
    message: EmailInboundMessage,
    contactId: string,
    sink: AttachmentSink,
  ): Promise<{ ticket: TicketRow; messageId: string }> {
    const { tx, brandId } = context;
    const repository = this.#deps.tickets;
    let seq = await repository.nextSeq(tx, candidate.ticket.id);

    const landing = candidate.status.isSpam
      ? { ticket: candidate.ticket }
      : await this.#deps.lifecycle.onCustomerReply(
          lifecycleContext(context, actor),
          candidate.ticket,
          candidate.status,
        );
    const target = landing.ticket;
    if (target.id !== candidate.ticket.id) {
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

    return { ticket: target, messageId };
  }

  async #writeMessage(
    context: RouteContext,
    ticket: TicketRow,
    seq: number,
    message: EmailInboundMessage,
    contactId: string,
    sink: AttachmentSink,
  ): Promise<string> {
    const { tx, brandId } = context;
    const { body } = message.email;
    const attachmentIds = message.files.map(() => uuidv7());
    const inlineAttachmentIds = body.inlineContentIds
      .map((contentId) => message.files.findIndex((file) => file.contentId === contentId))
      .filter((index) => index !== -1)
      .map((index) => attachmentIds[index] ?? '');

    const meta: EmailMessageMeta = {
      from: { address: message.from.value, name: message.from.name },
      to: [...message.email.to],
      cc: [...message.email.cc],
      date: message.email.date?.toISOString() ?? null,
      quotedHtml: body.quotedHtml,
      remoteImages: body.remoteImages.map((image) => ({ url: image.url, alt: image.alt })),
      remoteImagePolicy: context.mailbox.remoteImages,
      inlineAttachmentIds,
      authFailed: message.email.authFailed,
      mismatch: null,
    };

    const row = await this.#deps.tickets.insertMessage(tx, {
      brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      seq,
      kind: 'public',
      authorType: 'contact',
      authorId: contactId,
      bodyHtml: body.html,
      bodyText: body.text,
      channel: 'email',
      externalMessageId: message.externalId,
      email: meta,
    });

    if (message.files.length > 0) {
      await sink.store(tx, {
        brandId,
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
        messageId: row.id,
        contactId,
        files: message.files,
        ids: attachmentIds,
      });
    }

    return row.id;
  }

  /** "Referenced HD-1042 but sender is not a participant", in the contact's language (§4.3). */
  async #writeMismatchNote(
    context: RouteContext,
    actor: ActivityActor,
    ticket: TicketRow,
    referenced: TicketRow,
    locale: Locale,
  ): Promise<void> {
    const reference = `${referenced.prefix}-${String(referenced.number)}`;
    const t = createI18n({ lng: locale }).getFixedT(locale, 'ticket');
    const text = t('system.threadMismatch', { ticket: reference });

    await this.#deps.tickets.insertMessage(context.tx, {
      brandId: context.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      seq: await this.#deps.tickets.nextSeq(context.tx, ticket.id),
      kind: 'system',
      authorType: 'system',
      authorId: actor.actorId,
      // A ticket number and a fixed sentence; nothing from the sender.
      bodyHtml: `<p>${text}</p>`,
      bodyText: text,
      channel: 'email',
      email: {
        from: { address: '', name: null },
        to: [],
        cc: [],
        date: null,
        quotedHtml: null,
        remoteImages: [],
        remoteImagePolicy: context.mailbox.remoteImages,
        inlineAttachmentIds: [],
        authFailed: false,
        mismatch: { ticketId: referenced.id, reference },
      } satisfies EmailMessageMeta,
    });
  }

  /**
   * The `To` and `Cc` lines become CC participants (§2.5): everyone the
   * customer wrote to may write back into the thread, and receives public
   * replies. The brand's own mailboxes and the sender are left out.
   */
  async #copyIn(
    context: RouteContext,
    ticket: TicketRow,
    message: EmailInboundMessage,
    contactId: string,
  ): Promise<void> {
    const sender = message.from.value.toLowerCase();
    const addresses = [
      ...new Set(
        message.cc
          .map((cc) => cc.value.toLowerCase())
          .filter((address) => address !== sender && !context.ownAddresses.has(address)),
      ),
    ].slice(0, MAX_CC_PER_MESSAGE);

    const principal = {
      type: 'system',
      brandId: context.brandId,
      jobId: actorFor(context).actorId,
    } as const;
    for (const address of addresses) {
      let found: Awaited<ReturnType<typeof findOrCreateByAddress>>;
      try {
        found = await findOrCreateByAddress(context.tx, context.brandId, address, 'email.cc');
      } catch {
        // An address the contact layer refuses cannot be written back to either.
        continue;
      }
      if (found.contact.id !== contactId) {
        await this.#deps.participants.addCcParticipant(
          { tx: context.tx, brandId: context.brandId, principal },
          ticket.id,
          found.contact.id,
          { source: 'email' },
        );
      }
    }
  }
}

// --------------------------------------------------------------------------

const actorFor = (context: RouteContext): ActivityActor => ({
  actorType: 'system',
  actorId: `email:${context.mailbox.id}`,
  via: 'system',
});

const lifecycleContext = (context: RouteContext, actor: ActivityActor): LifecycleContext => ({
  tx: context.tx,
  brandId: context.brandId,
  actor,
  now: context.now,
});

/** A subject, or the brand language's "(no subject)"; `tickets.subject` is required. */
const subjectOf = (subject: string, locale: Locale): string => {
  const trimmed = subject.trim().slice(0, 500);
  if (trimmed !== '') {
    return trimmed;
  }

  return createI18n({ lng: locale }).getFixedT(locale, 'ticket')('system.noSubject');
};

/**
 * DOMAIN-RULES §2.5: the ticket's contact (by any email identity it holds),
 * a CC recorded under that address, or a staff member who is the assignee or
 * wrote on the ticket. Compared lower-cased, which is how every one of those
 * addresses is stored.
 */
export const isParticipant = async (
  tx: DbTransaction,
  ticket: TicketRow,
  address: string,
): Promise<boolean> => {
  const rows = await tx.execute<{ found: boolean }>(sql`
    SELECT (
      EXISTS (
        SELECT 1 FROM ${contactIdentities}
        WHERE ${contactIdentities.contactId} = ${ticket.contactId}
          AND ${contactIdentities.kind} = 'email'
          AND ${contactIdentities.value} = ${address}
      )
      OR EXISTS (
        SELECT 1 FROM ${ticketParticipants}
        WHERE ${ticketParticipants.ticketId} = ${ticket.id}
          AND ${ticketParticipants.address} = ${address}
      )
      OR EXISTS (
        SELECT 1 FROM ${users}
        WHERE lower(${users.email}) = ${address}
          AND (
            ${users.id} = ${ticket.assigneeId}
            OR EXISTS (
              SELECT 1 FROM ${ticketMessages}
              WHERE ${ticketMessages.ticketId} = ${ticket.id}
                AND ${ticketMessages.authorType} = 'staff'
                AND ${ticketMessages.authorId} = ${users.id}::text
            )
          )
      )
    ) AS found
  `);

  return [...rows][0]?.found === true;
};
