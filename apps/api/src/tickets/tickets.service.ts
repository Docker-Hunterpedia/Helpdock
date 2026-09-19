import { sanitizeMessageBody } from '@helpdock/channels';
import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import type {
  MessageCreateRequest,
  MessagePageQuery,
  Ticket,
  TicketActivityList,
  TicketCreateRequest,
  TicketDetail,
  TicketList,
  TicketListQuery,
  TicketMessage,
  TicketMessagePage,
  TicketStatusList,
  TicketUpdateRequest,
} from '@helpdock/schemas';
import { TICKET_PAGE_SIZE_DEFAULT } from '@helpdock/schemas';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import { getTx } from '../context/request-context.js';
import { InvalidCursorError } from './cursor.js';
import { applyStatusChange, UnknownStatusError } from './status-change.js';
import { activityActorFor, writeTicketActivity } from './ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from './ticket-events.js';
import { cursorAfter, sortValueOf } from './ticket-query.js';
import { toTicket, toTicketActivity, toTicketMessage, toTicketStatus } from './ticket-view.js';
import { TicketRepository } from './tickets.repository.js';

/**
 * M1-02 and M1-03: the ticket, its thread and its activity log.
 *
 * Three rules run through every method here.
 *
 * **Isolation is the database's.** No query filters by brand or department;
 * the request's transaction carries the scope and the policies apply it
 * (DOMAIN-RULES §1.3). A ticket in another department is `undefined` from a
 * read and a 404 from a handler, and "not found" and "not yours" are
 * deliberately the same answer — distinguishing them would confirm that
 * another department's ticket exists.
 *
 * **Every mutation leaves two rows behind.** One in `ticket_activity`, because
 * §4.1 asks for every state change with who and how; one in `outbox`, in the
 * same transaction, because §6 forbids a side effect that can drift from the
 * change that caused it. Neither is optional and neither is written outside a
 * transaction that also wrote the change.
 *
 * **Bodies are sanitised on the way in.** `body_html` is stored sanitised, so
 * a renderer that forgets is a renderer that cannot do damage
 * (REQUIREMENTS §5.1).
 */

/** How many activity rows a ticket read returns. The thread pages; this does not yet. */
const ACTIVITY_PAGE = 100;

@Injectable()
export class TicketsService {
  readonly #tickets: TicketRepository;

  constructor(@Inject(TicketRepository) tickets: TicketRepository) {
    this.#tickets = tickets;
  }

  // -------------------------------------------------------------------- reads

  async statuses(): Promise<TicketStatusList> {
    const rows = await this.#tickets.listStatuses(getTx());

    return { statuses: rows.map(toTicketStatus) };
  }

  async list(query: TicketListQuery): Promise<TicketList> {
    if (query.tagId !== undefined && query.tagId.length > 0) {
      // The parameter is declared so that M1-15's list does not have to change
      // shape when M1-06 lands, but a filter that is accepted and not applied
      // would quietly show rows the reader asked to exclude.
      throw new BadRequestException('Filtering by tag arrives with deliverable M1-06');
    }

    const rows = await this.#read(() => this.#tickets.listTickets(getTx(), query));
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      tickets: page.map(({ ticket, status }) => toTicket(ticket, status)),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? cursorAfter(
              { id: last.ticket.id, sortValue: sortValueOf(last.ticket, query.sort) },
              query.sort,
              query.direction,
            )
          : null,
    };
  }

  async find(ticketId: string): Promise<TicketDetail> {
    const tx = getTx();
    const found = await this.#require(tx, ticketId);

    return {
      ticket: toTicket(found.ticket, found.status),
      messages: await this.messages(ticketId, { after: 0, limit: TICKET_PAGE_SIZE_DEFAULT }),
      activity: (await this.#tickets.activityOf(tx, ticketId, ACTIVITY_PAGE)).map(toTicketActivity),
    };
  }

  /**
   * The catch-up read of DOMAIN-RULES §7. `nextAfter` is null on the last page,
   * which is how a client knows it has caught up rather than guessing from a
   * short page.
   */
  async messages(ticketId: string, query: MessagePageQuery): Promise<TicketMessagePage> {
    const tx = getTx();
    await this.#require(tx, ticketId);

    const rows = await this.#tickets.messagesAfter(tx, ticketId, query.after, query.limit);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      messages: page.map(toTicketMessage),
      nextAfter: rows.length > query.limit && last !== undefined ? last.seq : null,
    };
  }

  async activity(ticketId: string): Promise<TicketActivityList> {
    const tx = getTx();
    await this.#require(tx, ticketId);

    return {
      activity: (await this.#tickets.activityOf(tx, ticketId, ACTIVITY_PAGE)).map(toTicketActivity),
    };
  }

  // ------------------------------------------------------------------- writes

  /**
   * A ticket and its first message, in one transaction. A ticket with no
   * message is a row nobody can answer, so the two are never written apart.
   */
  async create(
    brandId: string,
    principal: Principal,
    input: TicketCreateRequest,
  ): Promise<TicketDetail> {
    const tx = getTx();
    const actor = activityActorFor(principal);

    await this.#requireDepartment(tx, input.departmentId);
    const status = await this.#requireDefaultStatus(tx);
    const prefix = await this.#requirePrefix(tx, brandId);

    const body = sanitizeMessageBody(input.bodyHtml);
    const ticket = await this.#tickets.insertTicket(tx, {
      brandId,
      departmentId: input.departmentId,
      number: await this.#tickets.nextNumber(tx, brandId),
      prefix,
      subject: input.subject,
      statusId: status.id,
      priority: input.priority,
      channel: input.channel,
      ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
      ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
      ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
    });

    const message = await this.#tickets.insertMessage(tx, {
      brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      seq: 1,
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      kind: 'public',
      authorType: authorTypeFor(principal),
      authorId: actor.actorId,
      bodyHtml: body.html,
      bodyText: body.text,
      channel: input.channel,
    });

    await writeTicketActivity(tx, {
      brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      actor,
      action: 'ticket.created',
      to: { subject: ticket.subject, statusId: status.id, priority: ticket.priority },
    });

    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.created, {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
    });

    return {
      ticket: toTicket(ticket, status),
      messages: { messages: [toTicketMessage(message)], nextAfter: null },
      activity: (await this.#tickets.activityOf(tx, ticket.id, ACTIVITY_PAGE)).map(
        toTicketActivity,
      ),
    };
  }

  /**
   * Moves whatever the body names. An empty body is refused rather than
   * answering 200 with nothing changed, because "it worked" and "there was
   * nothing to do" must not look the same to a caller retrying a failed write.
   */
  async update(
    brandId: string,
    principal: Principal,
    ticketId: string,
    input: TicketUpdateRequest,
  ): Promise<Ticket> {
    if (Object.keys(input).length === 0) {
      throw new BadRequestException('That request changes nothing');
    }

    const tx = getTx();
    const actor = activityActorFor(principal);
    const { ticket, status } = await this.#require(tx, ticketId);

    const { values, from, to } = plainChanges(ticket, input);

    if (input.departmentId !== undefined && input.departmentId !== ticket.departmentId) {
      await this.#requireDepartment(tx, input.departmentId);
    }

    const statusResult =
      input.statusId === undefined
        ? undefined
        : await this.#changeStatus(tx, ticket, status, input.statusId);

    if (statusResult?.changed === true) {
      values.statusId = statusResult.statusId;
      values.closedAt = statusResult.closedAt;
    }

    if (Object.keys(values).length === 0) {
      return toTicket(ticket, status);
    }

    const updated = await this.#tickets.updateTicket(tx, ticketId, values);
    /* c8 ignore next 3 -- the read above already proved the row is visible. */
    if (updated === undefined) {
      throw new NotFoundException('No such ticket');
    }

    if (Object.keys(to).length > 0) {
      await writeTicketActivity(tx, {
        brandId,
        ticketId,
        departmentId: updated.departmentId,
        actor,
        action: 'ticket.updated',
        from,
        to,
      });
    }

    if (statusResult?.changed === true) {
      await writeTicketActivity(tx, {
        brandId,
        ticketId,
        departmentId: updated.departmentId,
        actor,
        action: 'ticket.status.changed',
        from: { statusId: status.id },
        to: { statusId: statusResult.statusId },
      });
    }

    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.updated, {
      ticketId,
      departmentId: updated.departmentId,
    });

    const nextStatus =
      statusResult?.changed === true ? await this.#requireStatus(tx, updated.statusId) : status;

    return toTicket(updated, nextStatus);
  }

  /**
   * A public reply or an internal note (M1-03).
   *
   * The order is deliberate. `nextSeq` takes a `FOR UPDATE` lock on the ticket
   * row first, so twenty simultaneous replies queue rather than race; the
   * `client_id` lookup happens *inside* that lock, so a retry that arrives
   * while the first attempt is still committing finds the row rather than
   * writing a second one (DOMAIN-RULES §7).
   */
  async addMessage(
    brandId: string,
    principal: Principal,
    ticketId: string,
    input: MessageCreateRequest,
  ): Promise<TicketMessage> {
    const tx = getTx();
    const actor = activityActorFor(principal);
    const { ticket } = await this.#require(tx, ticketId);

    const seq = await this.#tickets.nextSeq(tx, ticketId);

    if (input.clientId !== undefined) {
      const existing = await this.#tickets.findMessageByClientId(tx, ticketId, input.clientId);
      if (existing !== undefined) {
        return toTicketMessage(existing);
      }
    }

    const body = sanitizeMessageBody(input.bodyHtml);
    const message = await this.#tickets.insertMessage(tx, {
      brandId,
      ticketId,
      departmentId: ticket.departmentId,
      seq,
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      kind: input.kind,
      authorType: authorTypeFor(principal),
      authorId: actor.actorId,
      bodyHtml: body.html,
      bodyText: body.text,
      channel: ticket.channel,
    });

    const action = input.kind === 'note' ? 'ticket.note_added' : 'ticket.replied';

    await writeTicketActivity(tx, {
      brandId,
      ticketId,
      departmentId: ticket.departmentId,
      actor,
      action,
      to: { messageId: message.id, seq },
    });

    // The ticket has moved even though none of its own columns did: the list
    // orders by `updated_at`, and a reply that did not touch it would leave the
    // ticket at the bottom of the queue it just became urgent in.
    await this.#tickets.updateTicket(tx, ticketId, {});

    await enqueueTicketEvent(
      tx,
      brandId,
      action === 'ticket.note_added' ? TICKET_EVENTS.noteAdded : TICKET_EVENTS.replied,
      {
        ticketId,
        departmentId: ticket.departmentId,
        messageId: message.id,
        seq,
        kind: message.kind,
      },
    );

    return toTicketMessage(message);
  }

  // ---------------------------------------------------------------- internals

  async #require(tx: DbTransaction, ticketId: string) {
    const found = await this.#tickets.findTicket(tx, ticketId);
    if (found === undefined) {
      // A ticket in another department is invisible to the policy, so this is
      // also what "outside your scope" answers (DOMAIN-RULES §1.2).
      throw new NotFoundException('No such ticket');
    }

    return found;
  }

  /**
   * The one way a `status_id` is decided. M1-08 replaces what
   * {@link applyStatusChange} does; what stays is that no caller writes the
   * column itself.
   *
   * A status that is not this brand's answers 404 rather than 403: the
   * transaction cannot see it, so the api genuinely does not know whether it
   * exists, and saying "forbidden" would tell a brand that another brand's id
   * is real.
   */
  async #changeStatus(
    tx: DbTransaction,
    ticket: TicketRow,
    current: TicketStatusRow,
    requestedStatusId: string,
  ) {
    try {
      return applyStatusChange({
        requestedStatusId,
        current,
        next: await this.#tickets.findStatus(tx, requestedStatusId),
        closedAt: ticket.closedAt,
        now: new Date(),
      });
    } catch (error) {
      if (error instanceof UnknownStatusError) {
        throw new NotFoundException(error.message);
      }
      /* c8 ignore next 2 -- nothing else in that call throws. */
      throw error;
    }
  }

  async #requireStatus(tx: DbTransaction, statusId: string): Promise<TicketStatusRow> {
    const status = await this.#tickets.findStatus(tx, statusId);
    /* c8 ignore next 3 -- a foreign key guarantees the row the ticket points at. */
    if (status === undefined) {
      throw new NotFoundException('No such status');
    }

    return status;
  }

  async #requireDefaultStatus(tx: DbTransaction): Promise<TicketStatusRow> {
    const status = await this.#tickets.findDefaultStatus(tx);
    if (status === undefined) {
      // Every brand is seeded with its statuses when it is created
      // (`seedBrandStatuses`). A brand without them predates that and cannot
      // hold a ticket, which is a configuration problem and not a request one.
      throw new ConflictException('This brand has no default ticket status');
    }

    return status;
  }

  async #requirePrefix(tx: DbTransaction, brandId: string): Promise<string> {
    const prefix = await this.#tickets.brandPrefix(tx, brandId);
    /* c8 ignore next 3 -- the permission guard resolved this brand from a role in it. */
    if (prefix === undefined) {
      throw new NotFoundException('No such brand');
    }

    return prefix;
  }

  /**
   * A department outside the actor's own scope is refused here rather than by
   * the policy, so the answer is a sentence and not a 500.
   *
   * DOMAIN-RULES §1.2 says moving a ticket to a department the actor cannot see
   * is allowed — it is how escalation works — and the `WITH CHECK` half of the
   * department policy does not permit it. Escalation in v1 therefore happens
   * through a rule, which runs as the system principal with every department
   * (§1.4, M3-03), and a restricted agent moving a ticket by hand into a
   * department they cannot see is refused. That gap is M1-08's to close.
   */
  async #requireDepartment(tx: DbTransaction, departmentId: string): Promise<void> {
    if (!(await this.#tickets.departmentIsWritable(tx, departmentId))) {
      throw new ForbiddenException('That department is outside your scope');
    }
  }

  /** A malformed cursor is the caller's mistake, so it answers 400 and not 500. */
  async #read<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

/** Who a message is from, in the vocabulary of `ticket_messages.author_type`. */
const authorTypeFor = (principal: Principal): 'staff' | 'contact' | 'system' | 'ai' => {
  switch (principal.type) {
    case 'staff':
      return 'staff';
    case 'visitor':
      return 'contact';
    case 'apikey':
    case 'system':
      return 'system';
  }
};

/**
 * The fields a `PATCH` moves that are not the status, with the before and after
 * the activity row records. A field set to the value it already holds is not a
 * change and is left out, so an activity log does not fill with "priority:
 * medium → medium".
 */
const plainChanges = (
  ticket: TicketRow,
  input: TicketUpdateRequest,
): {
  values: Record<string, unknown>;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
} => {
  const values: Record<string, unknown> = {};
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};

  const move = <K extends 'subject' | 'priority' | 'departmentId' | 'teamId' | 'assigneeId'>(
    key: K,
    next: TicketRow[K] | undefined,
  ): void => {
    if (next === undefined || next === ticket[key]) {
      return;
    }
    values[key] = next;
    from[key] = ticket[key];
    to[key] = next;
  };

  move('subject', input.subject);
  move('priority', input.priority);
  move('departmentId', input.departmentId);
  move('teamId', input.teamId);
  move('assigneeId', input.assigneeId);

  return { values, from, to };
};
