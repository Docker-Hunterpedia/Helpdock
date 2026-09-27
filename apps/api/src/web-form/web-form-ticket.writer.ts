import { escapeHtml } from '@helpdock/channels';
import {
  contacts,
  type DbTransaction,
  type Ticket as TicketRow,
  ticketMessages,
  tickets,
  uuidv7,
} from '@helpdock/db';
import { createI18n, type Locale } from '@helpdock/i18n';
import { and, eq, isNull } from 'drizzle-orm';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { requestAutoAssign } from '../assignment/assignment-events.js';
import { routesAutomatically } from '../assignment/ticket-assignment.js';
import type { AttachmentSink } from '../channels/inbound/conversation-router.js';
import { findOrCreateContactByIdentity } from '../contacts/identity.js';
import { enqueueEmailReceived } from '../email/email-events.js';
import { recordHandoff } from '../help-center/feedback/handoff.js';
import type { TicketLifecycleService } from '../tickets/lifecycle/lifecycle.service.js';
import { type ActivityActor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import type { TicketRepository } from '../tickets/tickets.repository.js';
import type { WebFormSubmission } from './submission.js';

/**
 * A submission of the hosted form as a `form`-channel ticket (M4-09).
 *
 * The same rows, in the same order, that M2's `ConversationRouter` writes for
 * a new email — ticket, first message, attachments, `ticket.created` activity,
 * SLA clocks, the `ticket.created` event, auto-assignment — so rules, SLAs and
 * notifications see a form ticket exactly as they see any other. And
 * `email.received`, M2-06's seam, so the auto-responder acknowledges it by
 * email when the brand has a sender: the auto-reply follows the ticket, not
 * the channel that opened it.
 *
 * The typed address is a claim, never proof (DOMAIN-RULES §4.4, "Email typed
 * in a form: never verified"): it goes through the identity seam as
 * `web.form`, which makes a new contact and a duplicate suggestion rather than
 * filing the ticket under whoever already holds that address.
 */

export const FORM_ACTOR_PREFIX = 'webform';

/** `ticket_messages.external_message_id` for a submission: the dedupe key of a double submit. */
export const submissionExternalId = (submissionId: string): string =>
  `${FORM_ACTOR_PREFIX}:${submissionId}`;

export interface WebFormTicketInput {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly departmentId: string;
  /** The page's language, remembered on a new contact for the acknowledgment. */
  readonly locale: Locale;
  readonly submissionId: string;
  readonly submission: WebFormSubmission;
  readonly sink: AttachmentSink;
  /** M5-08: the help center article the customer came from, as the page posted it. */
  readonly articleId?: string | null;
}

export interface FiledTicket {
  readonly ticketId: string;
  readonly reference: string;
}

export interface WebFormTicketWriterDependencies {
  readonly tickets: TicketRepository;
  readonly lifecycle: TicketLifecycleService;
  readonly assignment: AssignmentRepository;
}

const SUBJECT_FROM_MESSAGE_MAX = 80;

/** The form's subject, or the message's first line when the form asks for none. */
export const subjectFor = (submission: WebFormSubmission, locale: Locale): string => {
  if (submission.subject !== null) {
    return submission.subject;
  }
  const line =
    submission.message
      .split(/\r?\n/)
      .find((part) => part.trim() !== '')
      ?.trim() ?? '';
  if (line === '') {
    return createI18n({ lng: locale }).getFixedT(locale, 'ticket')('system.noSubject');
  }
  return line.length > SUBJECT_FROM_MESSAGE_MAX
    ? `${line.slice(0, SUBJECT_FROM_MESSAGE_MAX - 1).trimEnd()}…`
    : line;
};

/** Plain text as the thread's HTML: escaped, a blank line a paragraph, a newline a `<br>`. */
export const messageHtml = (text: string): string =>
  text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${paragraph.split(/\r?\n/).map(escapeHtml).join('<br>')}</p>`)
    .join('');

export class WebFormTicketWriter {
  readonly #deps: WebFormTicketWriterDependencies;

  constructor(deps: WebFormTicketWriterDependencies) {
    this.#deps = deps;
  }

  /** The ticket an earlier post of this same submission filed, if any. */
  async alreadyFiled(
    tx: DbTransaction,
    brandId: string,
    submissionId: string,
  ): Promise<FiledTicket | undefined> {
    const rows = await tx
      .select({ id: tickets.id, prefix: tickets.prefix, number: tickets.number })
      .from(ticketMessages)
      .innerJoin(tickets, eq(tickets.id, ticketMessages.ticketId))
      .where(
        and(
          eq(ticketMessages.brandId, brandId),
          eq(ticketMessages.channel, 'form'),
          eq(ticketMessages.externalMessageId, submissionExternalId(submissionId)),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? undefined
      : { ticketId: row.id, reference: `${row.prefix}-${String(row.number)}` };
  }

  async file(input: WebFormTicketInput): Promise<FiledTicket> {
    const { tx, brandId, submission } = input;
    const { tickets: repository } = this.#deps;
    const actor: ActivityActor = {
      actorType: 'system',
      actorId: `${FORM_ACTOR_PREFIX}:${brandId}`,
      via: 'system',
    };

    const { contact, created } = await findOrCreateContactByIdentity(
      tx,
      brandId,
      { kind: 'email', value: submission.email, source: 'web.form' },
      submission.name === null ? {} : { name: submission.name },
    );
    if (created) {
      await tx
        .update(contacts)
        .set({ locale: input.locale })
        .where(and(eq(contacts.id, contact.id), isNull(contacts.locale)));
    }

    const status = await repository.findDefaultStatus(tx);
    const prefix = await repository.brandPrefix(tx, brandId);
    /* c8 ignore next 3 -- every brand is seeded with its statuses and has a prefix. */
    if (status === undefined || prefix === undefined) {
      throw new Error('This brand has no default status or no ticket prefix');
    }

    const ticket = await repository.insertTicket(tx, {
      brandId,
      departmentId: input.departmentId,
      number: await repository.nextNumber(tx, brandId),
      prefix,
      subject: subjectFor(submission, input.locale),
      statusId: status.id,
      priority: 'medium',
      channel: 'form',
      contactId: contact.id,
      custom: submission.custom,
    });

    const messageId = await this.#writeMessage(input, ticket, contact.id);

    await writeTicketActivity(tx, {
      brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      actor,
      action: 'ticket.created',
      to: { subject: ticket.subject, statusId: status.id, priority: ticket.priority },
    });
    await recordHandoff(tx, {
      brandId,
      ticket,
      actor,
      articleId: input.articleId ?? undefined,
      locale: input.locale,
    });
    await this.#deps.lifecycle.onCreated(
      { tx, brandId, actor, now: ticket.createdAt },
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
    await enqueueEmailReceived(tx, brandId, {
      ticketId: ticket.id,
      ticketMessageId: messageId,
      createdTicket: true,
      from: submission.email,
      ...(submission.name === null ? {} : { fromName: submission.name.slice(0, 200) }),
      autoGenerated: false,
    });

    return { ticketId: ticket.id, reference: `${ticket.prefix}-${String(ticket.number)}` };
  }

  async #writeMessage(
    input: WebFormTicketInput,
    ticket: TicketRow,
    contactId: string,
  ): Promise<string> {
    const { tx, brandId, submission } = input;
    const row = await this.#deps.tickets.insertMessage(tx, {
      brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      seq: 1,
      kind: 'public',
      authorType: 'contact',
      authorId: contactId,
      bodyHtml: messageHtml(submission.message),
      bodyText: submission.message,
      channel: 'form',
      externalMessageId: submissionExternalId(input.submissionId),
    });

    if (submission.files.length > 0) {
      await input.sink.store(tx, {
        brandId,
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
        messageId: row.id,
        contactId,
        files: submission.files,
        ids: submission.files.map(() => uuidv7()),
      });
    }

    return row.id;
  }
}
