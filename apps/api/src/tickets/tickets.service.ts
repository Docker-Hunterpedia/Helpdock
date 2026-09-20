import { SanitizeLimitError, sanitizeMessageBody } from '@helpdock/channels';
import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import type {
  MessageCreateRequest,
  MessagePageQuery,
  Ticket,
  TicketActivityEntry,
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
import { TicketLifecycleRepository } from './lifecycle/lifecycle.repository.js';
import {
  escalateIntoUnseenDepartment,
  type LifecycleContext,
  TicketLifecycleService,
} from './lifecycle/lifecycle.service.js';
import { applyStatusChange, type StatusChangeResult, UnknownStatusError } from './status-change.js';
import { activityActorFor, writeTicketActivity } from './ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS, type TicketEvent } from './ticket-events.js';
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
  readonly #lifecycle: TicketLifecycleService;
  readonly #lifecycleReads: TicketLifecycleRepository;

  constructor(
    @Inject(TicketRepository) tickets: TicketRepository,
    @Inject(TicketLifecycleService) lifecycle: TicketLifecycleService,
    @Inject(TicketLifecycleRepository) lifecycleReads: TicketLifecycleRepository,
  ) {
    this.#tickets = tickets;
    this.#lifecycle = lifecycle;
    this.#lifecycleReads = lifecycleReads;
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
      // `#messagePage` rather than `messages`, which would re-run the ticket
      // read this method has already done.
      messages: await this.#messagePage(tx, ticketId, {
        after: 0,
        limit: TICKET_PAGE_SIZE_DEFAULT,
      }),
      activity: await this.#activityOf(tx, ticketId),
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

    return this.#messagePage(tx, ticketId, query);
  }

  async activity(ticketId: string): Promise<TicketActivityList> {
    const tx = getTx();
    await this.#require(tx, ticketId);

    return { activity: await this.#activityOf(tx, ticketId) };
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
    await this.#requireTeam(input.teamId);
    await this.#requireAssignee(tx, input.assigneeId);
    const status = await this.#requireDefaultStatus(tx);
    const prefix = await this.#requirePrefix(tx, brandId);

    const body = this.#body(input.bodyHtml);
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
      activity: await this.#activityOf(tx, ticket.id),
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
    const now = new Date();
    const actor = activityActorFor(principal);
    const { ticket, status } = await this.#require(tx, ticketId);
    const context: LifecycleContext = { tx, brandId, actor, now };

    const { values, from, to } = plainChanges(ticket, input);

    // `null` for a move the actor's own scope already covers, and the target
    // for an escalation — which is allowed, and is why this is not a refusal.
    const escalation =
      input.departmentId !== undefined && input.departmentId !== ticket.departmentId
        ? await this.#resolveDepartmentMove(tx, input.departmentId)
        : null;

    await this.#requireTeam(input.teamId ?? undefined);
    await this.#requireAssignee(tx, input.assigneeId ?? undefined);

    const statusResult =
      input.statusId === undefined
        ? undefined
        : await this.#changeStatus(tx, ticket, status, input.statusId, now);

    if (statusResult?.changed === true) {
      values.statusId = statusResult.statusId;
      values.closedAt = statusResult.closedAt;
    }

    if (Object.keys(values).length === 0) {
      return toTicket(ticket, status);
    }

    /**
     * The whole mutation, as one function, because on an escalation every
     * statement in it has to run inside the same widened window: the `UPDATE`
     * itself, the trigger that follows the ticket's messages and activity into
     * the new department, and the activity rows whose own department the
     * trigger then overwrites with it.
     */
    const write = async (): Promise<{ ticket: TicketRow; status: TicketStatusRow }> => {
      const moved = await this.#tickets.updateTicket(tx, ticketId, values);
      /* c8 ignore next 3 -- the read above already proved the row is visible. */
      if (moved === undefined) {
        throw new NotFoundException('No such ticket');
      }

      if (Object.keys(to).length > 0) {
        await writeTicketActivity(tx, {
          brandId,
          ticketId,
          departmentId: moved.departmentId,
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
          departmentId: moved.departmentId,
          actor,
          action: 'ticket.status.changed',
          from: { statusId: status.id },
          to: { statusId: statusResult.statusId },
        });
      }

      // Inside the window too. A close or a reopen writes another activity row,
      // and the `ticket_activity_department` trigger stamps it with the
      // ticket's department — by now the new one, which the actor's own scope
      // does not cover. Outside, the insert would be refused by the policy.
      const moveStatus =
        statusResult?.changed === true ? await this.#requireStatus(tx, moved.statusId) : status;
      await this.#afterStatusChange(context, moved, status, moveStatus, statusResult);

      return { ticket: moved, status: moveStatus };
    };

    const { ticket: updated, status: nextStatus } =
      escalation === null
        ? await write()
        : await escalateIntoUnseenDepartment(tx, escalation, write);

    if (escalation !== null) {
      await this.#auditEscalation(context, ticket, escalation);
    }

    await enqueueTicketEvent(tx, brandId, ticketEventFor(statusResult), {
      ticketId,
      departmentId: updated.departmentId,
      // On a move, whoever is watching the queue the ticket has just left is in
      // no other room this event reaches.
      ...(updated.departmentId === ticket.departmentId
        ? {}
        : { previousDepartmentId: ticket.departmentId }),
    });

    return toTicket(updated, nextStatus);
  }

  /**
   * DOMAIN-RULES §2.2 row 9: an Admin hides a ticket from every view. The row
   * stays until M1-14's retention purges it (§11).
   */
  async remove(brandId: string, principal: Principal, ticketId: string): Promise<void> {
    const tx = getTx();
    const { ticket, status } = await this.#require(tx, ticketId);

    await this.#lifecycle.softDelete(
      { tx, brandId, actor: activityActorFor(principal), now: new Date() },
      ticket,
      status,
    );
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
    const now = new Date();
    const actor = activityActorFor(principal);
    const authorType = authorTypeFor(principal);
    const { ticket, status } = await this.#require(tx, ticketId);
    const context: LifecycleContext = { tx, brandId, actor, now };

    // The lock comes first, on the ticket the reply was addressed to, so
    // concurrent replies queue however the lifecycle then moves them (§7).
    let seq = await this.#tickets.nextSeq(tx, ticketId);

    if (input.clientId !== undefined) {
      const existing = await this.#tickets.findMessageByClientId(tx, ticketId, input.clientId);
      if (existing !== undefined) {
        return toTicketMessage(existing);
      }

      // A reply to a closed ticket may have landed on a ticket that continues
      // it (§2.3). Without this, a retried send would create a second one.
      const continued = await this.#lifecycleReads.findContinuationMessage(
        tx,
        ticketId,
        input.clientId,
      );
      if (continued !== undefined) {
        return toTicketMessage(continued);
      }
    }

    // DOMAIN-RULES §2.2 rows 1 and 5. It runs *before* the insert because on
    // the continuation branch the message belongs to a ticket that does not
    // exist yet, and it decides which ticket that is.
    const landing =
      input.kind === 'public' && authorType === 'contact'
        ? await this.#lifecycle.onCustomerReply(context, ticket, status)
        : { ticket, status, continued: false };

    if (landing.ticket.id !== ticketId) {
      seq = await this.#tickets.nextSeq(tx, landing.ticket.id);
    }

    const target = landing.ticket;
    const body = this.#body(input.bodyHtml);
    const message = await this.#tickets.insertMessage(tx, {
      brandId,
      ticketId: target.id,
      departmentId: target.departmentId,
      seq,
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      kind: input.kind,
      authorType,
      authorId: actor.actorId,
      bodyHtml: body.html,
      bodyText: body.text,
      channel: target.channel,
    });

    const action = input.kind === 'note' ? 'ticket.note_added' : 'ticket.replied';

    await writeTicketActivity(tx, {
      brandId,
      ticketId: target.id,
      departmentId: target.departmentId,
      actor,
      action,
      to: { messageId: message.id, seq },
    });

    // The ticket has moved even though none of its own columns did: the list
    // orders by `updated_at`, and a reply that did not touch it would leave the
    // ticket at the bottom of the queue it just became urgent in.
    await this.#tickets.updateTicket(tx, target.id, {});

    // §2.2 row 2. After the reply, because the toggle is about what the reply
    // means and a status moved before the message existed would be a lie if the
    // insert then failed.
    if (input.kind === 'public' && authorType === 'staff') {
      await this.#lifecycle.onAgentPublicReply(context, target, landing.status);
    }

    await enqueueTicketEvent(
      tx,
      brandId,
      action === 'ticket.note_added' ? TICKET_EVENTS.noteAdded : TICKET_EVENTS.replied,
      {
        ticketId: target.id,
        departmentId: target.departmentId,
        messageId: message.id,
        seq,
        kind: message.kind,
      },
    );

    return toTicketMessage(message);
  }

  // ---------------------------------------------------------------- internals

  async #messagePage(
    tx: DbTransaction,
    ticketId: string,
    query: MessagePageQuery,
  ): Promise<TicketMessagePage> {
    const rows = await this.#tickets.messagesAfter(tx, ticketId, query.after, query.limit);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      messages: page.map(toTicketMessage),
      nextAfter: rows.length > query.limit && last !== undefined ? last.seq : null,
    };
  }

  /**
   * The newest entries, returned oldest first.
   *
   * The read is `ORDER BY created_at DESC LIMIT n` and the page is reversed
   * here, because the thread renders oldest first but the hundred that matter
   * on a long-running ticket are the *newest* ones. Ordering ascending with the
   * same limit would return the first hundred and silently drop every status
   * change and reassignment since.
   */
  async #activityOf(tx: DbTransaction, ticketId: string): Promise<TicketActivityEntry[]> {
    const rows = await this.#tickets.activityOf(tx, ticketId, ACTIVITY_PAGE);

    return rows.reverse().map(toTicketActivity);
  }

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
    now: Date,
  ): Promise<StatusChangeResult> {
    try {
      return applyStatusChange({
        requestedStatusId,
        current,
        next: await this.#tickets.findStatus(tx, requestedStatusId),
        closedAt: ticket.closedAt,
        ticket,
        // One event covers rows 3, 4 and 6 of §2.2. An agent "closing" a ticket
        // *is* an agent setting a status whose system state is `closed`, and a
        // reopen is the same act in the other direction: there is one control
        // on the screen and it is a status picker. Which of the three happened
        // is then read off the states, as `closing` and `reopening`.
        event: 'agent.status',
        now,
      });
    } catch (error) {
      if (error instanceof UnknownStatusError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /**
   * The hooks a status change owes DOMAIN-RULES §2.2 and §3.5, once the row has
   * moved and before the queue is told.
   */
  async #afterStatusChange(
    context: LifecycleContext,
    updated: TicketRow,
    previous: TicketStatusRow,
    next: TicketStatusRow,
    result: StatusChangeResult | undefined,
  ): Promise<void> {
    if (result === undefined || !result.changed) {
      return;
    }

    if (result.closing) {
      await writeTicketActivity(context.tx, {
        brandId: context.brandId,
        ticketId: updated.id,
        departmentId: updated.departmentId,
        actor: context.actor,
        action: 'ticket.closed',
        from: { statusId: previous.id },
        to: { statusId: next.id, closedAt: updated.closedAt?.toISOString() ?? null },
      });
      await this.#lifecycle.onClosed(context, updated, next);
      return;
    }

    if (result.reopening) {
      await writeTicketActivity(context.tx, {
        brandId: context.brandId,
        ticketId: updated.id,
        departmentId: updated.departmentId,
        actor: context.actor,
        action: 'ticket.reopened',
        from: { statusId: previous.id },
        to: { statusId: next.id },
      });
      await this.#lifecycle.onReopened(context, updated, next);
    }
  }

  /**
   * Whether this move needs the widened window, and refuses the two cases that
   * are not escalation at all.
   *
   * DOMAIN-RULES §1.2 allows a move into a department the actor cannot see —
   * "it is how escalation works" — so an out-of-scope department is not a
   * refusal here, which is the gap M1-02 named and left open. What is still
   * refused is a department id that is not this brand's: the transaction cannot
   * see it, so it answers as "no such department" rather than as an escalation
   * into somewhere that does not exist.
   */
  async #resolveDepartmentMove(tx: DbTransaction, departmentId: string): Promise<string | null> {
    if (await this.#tickets.departmentIsWritable(tx, departmentId)) {
      return null;
    }

    if (!(await this.#tickets.departmentExists(tx, departmentId))) {
      throw new NotFoundException('No such department in this brand');
    }

    return departmentId;
  }

  /**
   * An escalation is audited, because the actor cannot read the ticket
   * afterwards and the activity row goes with it into a department they cannot
   * see. `audit_log` is brand-scoped, so an Admin reading the brand's trail can
   * still find out where the ticket went.
   */
  async #auditEscalation(
    context: LifecycleContext,
    ticket: TicketRow,
    departmentId: string,
  ): Promise<void> {
    await this.#lifecycleReads.writeAudit(context.tx, {
      brandId: context.brandId,
      actorType: context.actor.actorType,
      actorId: context.actor.actorId,
      action: 'ticket.escalated',
      targetType: 'ticket',
      targetId: ticket.id,
      meta: {
        number: ticket.number,
        fromDepartmentId: ticket.departmentId,
        toDepartmentId: departmentId,
      },
    });
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
   * Where a ticket may be **filed** at creation.
   *
   * Creating is not escalating. §1.2 allows a ticket to be *moved* into a
   * department the actor cannot see, because that is what escalation is; there
   * is nothing to escalate about a ticket that does not exist yet, and a ticket
   * created straight into a department the author cannot read would be a ticket
   * nobody meant to file there. `#resolveDepartmentMove` is the other half.
   */
  async #requireDepartment(tx: DbTransaction, departmentId: string): Promise<void> {
    if (!(await this.#tickets.departmentIsWritable(tx, departmentId))) {
      throw new ForbiddenException('That department is outside your scope');
    }
  }

  /**
   * `teams` is M1-01's table and does not exist yet, so `team_id` has no
   * foreign key and *any* uuid would be stored permanently. Refusing is the
   * same judgement the `tagId` filter takes: a field that is accepted and not
   * honoured is worse than one that is refused.
   */
  async #requireTeam(teamId: string | undefined): Promise<void> {
    if (teamId !== undefined) {
      throw new BadRequestException('Assigning a team arrives with deliverable M1-01');
    }
    await Promise.resolve();
  }

  /**
   * An assignee has to hold a role in this brand. `tickets.assignee_id`
   * references the *global* `users` table, so the foreign key alone would
   * accept a stranger's id and produce a ticket owned by somebody who cannot
   * open it. `user_brand_roles` is brand-scoped, so the policy answers the
   * brand half and this answers the rest.
   *
   * Which *department* an assignee must be in is M1-07's question, with the
   * round-robin and the load caps.
   */
  async #requireAssignee(tx: DbTransaction, assigneeId: string | undefined): Promise<void> {
    if (assigneeId === undefined) {
      return;
    }

    if (!(await this.#tickets.isBrandMember(tx, assigneeId))) {
      throw new BadRequestException('That person holds no role in this brand');
    }
  }

  /**
   * The sanitised body, or a 400.
   *
   * A body the sanitiser refuses is a body somebody sent, not a bug here: the
   * limits exist because sanitising is synchronous and runs inside the
   * request's transaction, so a body built to be expensive is a way to stall a
   * replica. The caller has to learn that from the status code.
   */
  #body(html: string) {
    try {
      return sanitizeMessageBody(html);
    } catch (error) {
      if (error instanceof SanitizeLimitError) {
        throw new BadRequestException(error.message);
      }
      /* c8 ignore next 2 -- the sanitiser throws nothing else. */
      throw error;
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

/**
 * Which outbox event a status change is. `ticket.closed` and `ticket.reopened`
 * carry the same payload as `ticket.updated` and reach the same rooms; naming
 * them is what lets M1-12's survey and M3's clocks consume one event instead of
 * diffing two reads of the ticket (DOMAIN-RULES §2.2).
 */
const ticketEventFor = (result: StatusChangeResult | undefined): TicketEvent => {
  if (result?.closing === true) {
    return TICKET_EVENTS.closed;
  }
  if (result?.reopening === true) {
    return TICKET_EVENTS.reopened;
  }

  return TICKET_EVENTS.updated;
};

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
