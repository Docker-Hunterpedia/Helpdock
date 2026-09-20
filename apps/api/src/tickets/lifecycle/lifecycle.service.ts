import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { withWidenedDepartments } from '@helpdock/db';
import { createI18n, type Locale } from '@helpdock/i18n';
import type { BrandSettings } from '@helpdock/schemas';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { ActivityActor } from '../ticket-activity.js';
import { writeTicketActivity } from '../ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../ticket-events.js';
import { TicketRepository } from '../tickets.repository.js';
import { TicketLifecycleHooks } from './hooks.js';
import { TicketLifecycleRepository } from './lifecycle.repository.js';
import { TicketLifecycleFailure } from './lifecycle-failure.js';
import { decideReopen } from './reopen-policy.js';
import { transitionFor } from './transitions.js';

/**
 * The transitions of
 * [DOMAIN-RULES §2.2](../../../../../docs/planning/DOMAIN-RULES.md#22-transitions)
 * and the reopen policy of §2.3, carried out.
 *
 * `transitions.ts` says what should happen and `reopen-policy.ts` answers the
 * one cell that needs a setting and a date; this is where rows are written.
 * Three rules hold across every method:
 *
 * **Everything is the caller's transaction.** A transition writes the ticket,
 * its activity row and its outbox row together or not at all — §6 forbids a
 * side effect that can drift from the change that caused it, and an activity
 * log that records what did not happen is worse than none.
 *
 * **Hooks fire before the outbox row.** M3's clocks and M1-12's survey run
 * inside the same transaction ({@link ./hooks.js hooks.ts} says why), so what
 * they write commits with the transition.
 *
 * **Nothing here reads the clock twice.** One `now` is threaded through a
 * transition, so `closed_at`, the reopen window and every timestamp it leaves
 * behind agree with each other.
 */

/** What every method here is told about the request it is serving. */
export interface LifecycleContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actor: ActivityActor;
  /** Shared by every write of one transition, so they cannot disagree. */
  readonly now: Date;
}

/** Where a customer's reply belongs, once §2.2 and §2.3 have been applied. */
export interface CustomerReplyLanding {
  /**
   * The ticket the message is to be written to: the one that was replied to —
   * reopened if it was closed — or a new ticket continuing it (§2.3).
   */
  readonly ticket: TicketRow;
  readonly status: TicketStatusRow;
  /** True when `ticket` is not the one the reply was addressed to. */
  readonly continued: boolean;
}

@Injectable()
export class TicketLifecycleService {
  readonly #lifecycle: TicketLifecycleRepository;
  readonly #tickets: TicketRepository;
  readonly #hooks: TicketLifecycleHooks;

  constructor(
    @Inject(TicketLifecycleRepository) lifecycle: TicketLifecycleRepository,
    @Inject(TicketRepository) tickets: TicketRepository,
    @Inject(TicketLifecycleHooks) hooks: TicketLifecycleHooks,
  ) {
    this.#lifecycle = lifecycle;
    this.#tickets = tickets;
    this.#hooks = hooks;
  }

  // ------------------------------------------------------------- the settings

  /**
   * The brand's reply behaviour, or the defaults.
   *
   * A brand row that has vanished under an open request is not something a
   * reply can be answered from, so it raises rather than guessing; every other
   * shape falls back to the defaults inside `parseBrandSettings`, because
   * these settings describe behaviour and behaviour has to have an answer.
   */
  async settings(tx: DbTransaction, brandId: string): Promise<BrandSettings> {
    const settings = await this.#lifecycle.brandSettings(tx, brandId);
    /* c8 ignore next 3 -- the permission guard resolved this brand from a role in it. */
    if (settings === undefined) {
      throw new ConflictException('No such brand');
    }

    return settings;
  }

  // ---------------------------------------------------------- customer replies

  /**
   * §2.2 row 1 and row 5: where a customer's public reply lands.
   *
   * | The ticket is | The reply |
   * |---|---|
   * | open, on hold or escalated | reopens nothing; the ticket moves to the brand's default open status and `awaiting_customer` is cleared with it |
   * | closed | governed by the reopen policy (§2.3): the ticket comes back, or a new one continues it |
   *
   * It is called from the message-create path **before** the message is
   * written, because on the continuation branch the message belongs to a ticket
   * that does not exist yet. The channels of M2, M4 and M6 call the same
   * method with the same contract.
   *
   * Clearing `awaiting_customer` is not a column write. The flag lives on the
   * *status*, so "clears `awaiting_customer`" and "moves to the default open
   * status" are the same act — which is why §2.2 words them as one cell.
   */
  async onCustomerReply(
    context: LifecycleContext,
    ticket: TicketRow,
    status: TicketStatusRow,
  ): Promise<CustomerReplyLanding> {
    const outcome = transitionFor({ ...ticket, systemState: status.systemState }, 'customer.reply');
    if (outcome.kind === 'refused') {
      throw new TicketLifecycleFailure(outcome.reason);
    }

    if (outcome.kind === 'to-default-open') {
      return this.#moveToDefaultOpen(context, ticket, status);
    }

    const settings = await this.settings(context.tx, context.brandId);
    const decision = decideReopen({
      policy: settings.reopenPolicy,
      closedAt: ticket.closedAt,
      now: context.now,
    });

    return decision.kind === 'reopen'
      ? this.reopen(context, ticket, status)
      : this.#continueInNewTicket(context, ticket);
  }

  // ------------------------------------------------------------- agent replies

  /**
   * §2.2 row 2: "`open` | Agent public reply, toggle on | Awaiting customer".
   *
   * Both halves of that row are conditions, and both are checked: the ticket
   * has to be `open` — the table has no cell for an agent reply moving an
   * escalated or on-hold ticket — and the brand's `autoAwaitOnAgentReply` has
   * to be on. A brand with the toggle off, or a ticket somewhere deliberate,
   * is left where it is and nothing is logged.
   *
   * Returns the status the ticket ended in, so the caller can answer with a
   * ticket that is true rather than the one it read before replying.
   */
  async onAgentPublicReply(
    context: LifecycleContext,
    ticket: TicketRow,
    status: TicketStatusRow,
  ): Promise<TicketStatusRow> {
    const outcome = transitionFor({ ...ticket, systemState: status.systemState }, 'agent.reply');
    if (outcome.kind !== 'to-awaiting-customer') {
      return status;
    }

    const settings = await this.settings(context.tx, context.brandId);
    if (!settings.autoAwaitOnAgentReply) {
      return status;
    }

    const awaiting = await this.#lifecycle.awaitingCustomerStatus(context.tx);
    // A brand whose only awaiting-customer status was deleted has nowhere to
    // move the ticket to. The reply is the thing that matters and it has
    // already been written; leaving the status alone is the harmless half.
    if (awaiting === undefined || awaiting.id === status.id) {
      return status;
    }

    await this.#applyStatus(context, ticket, status, awaiting, { closedAt: null });

    return awaiting;
  }

  // -------------------------------------------------------------- close, open

  /**
   * The hooks a close fires (§2.2 row 4), once the status has already moved.
   *
   * `onResolved` fires for **every** close, including spam and merge: a
   * resolution clock left running on a ticket nobody will touch again is a
   * clock that breaches. `onClosedForCsat` is the one §2.2 qualifies — "if
   * enabled, not spam, not merged" — and both exclusions are read off data
   * rather than off a name: `merged_into_id` on the ticket, and
   * `excluded_from_reports` on the status a brand may have renamed.
   */
  async onClosed(
    context: LifecycleContext,
    ticket: TicketRow,
    status: TicketStatusRow,
  ): Promise<void> {
    const event = { brandId: context.brandId, ticket, status, at: context.now };

    await this.#hooks.onResolved(context.tx, event);

    if (ticket.mergedIntoId === null && !status.excludedFromReports) {
      await this.#hooks.onClosedForCsat(context.tx, event);
    }
  }

  /** §3.5's clocks, once a status change has taken a ticket out of a closed state. */
  async onReopened(
    context: LifecycleContext,
    ticket: TicketRow,
    status: TicketStatusRow,
  ): Promise<void> {
    await this.#hooks.onReopened(context.tx, {
      brandId: context.brandId,
      ticket,
      status,
      at: context.now,
    });
  }

  // ------------------------------------------------------------- soft deletion

  /**
   * §2.2 row 9: "Soft-deleted by Admin — hidden from all views; purged by
   * retention (§11)."
   *
   * The row stays and keeps the status it was in, because restoring one and
   * reporting on what was deleted both need it. Every read narrows on
   * `deleted_at IS NULL` from here, so the ticket is gone from the list, from
   * its own URL, from the contact timeline and from the thread — while the
   * department count that guards a department delete still sees it, which is
   * what stops a department being removed out from under a restorable ticket.
   */
  async softDelete(
    context: LifecycleContext,
    ticket: TicketRow,
    status: TicketStatusRow,
  ): Promise<void> {
    const outcome = transitionFor({ ...ticket, systemState: status.systemState }, 'soft.delete');
    if (outcome.kind === 'refused') {
      throw new TicketLifecycleFailure(outcome.reason);
    }

    await this.#tickets.updateTicket(context.tx, ticket.id, { deletedAt: context.now });

    await writeTicketActivity(context.tx, {
      brandId: context.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      actor: context.actor,
      action: 'ticket.deleted',
      to: { deletedAt: context.now.toISOString() },
    });

    await this.#lifecycle.writeAudit(context.tx, {
      brandId: context.brandId,
      actorType: context.actor.actorType,
      actorId: context.actor.actorId,
      action: 'ticket.deleted',
      targetType: 'ticket',
      targetId: ticket.id,
      meta: { number: ticket.number, prefix: ticket.prefix },
    });

    await enqueueTicketEvent(context.tx, context.brandId, TICKET_EVENTS.updated, {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
    });
  }

  // ---------------------------------------------------------------- internals

  /** §2.2 row 1, once the table has said so. */
  async #moveToDefaultOpen(
    context: LifecycleContext,
    ticket: TicketRow,
    status: TicketStatusRow,
  ): Promise<CustomerReplyLanding> {
    const open = await this.#requireDefaultOpen(context.tx);
    if (open.id === status.id) {
      return { ticket, status, continued: false };
    }

    const updated = await this.#applyStatus(context, ticket, status, open, { closedAt: null });

    return { ticket: updated, status: open, continued: false };
  }

  /**
   * §2.2 row 5 via §2.3, and §2.2 row 6 when an agent asks: the ticket returns
   * to the brand's default open status, `closed_at` is cleared, and §3.5's
   * clocks restart through {@link TicketLifecycleHooks.onReopened}.
   *
   * Public, because both callers are outside this class: the customer reply
   * above, and the status change an agent makes through `PATCH /tickets/:id`.
   */
  async reopen(
    context: LifecycleContext,
    ticket: TicketRow,
    status: TicketStatusRow,
  ): Promise<CustomerReplyLanding> {
    const open = await this.#requireDefaultOpen(context.tx);
    const updated = await this.#applyStatus(context, ticket, status, open, { closedAt: null });

    await writeTicketActivity(context.tx, {
      brandId: context.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      actor: context.actor,
      action: 'ticket.reopened',
      from: { statusId: status.id, closedAt: ticket.closedAt?.toISOString() ?? null },
      to: { statusId: open.id },
    });

    await this.onReopened(context, updated, open);

    await enqueueTicketEvent(context.tx, context.brandId, TICKET_EVENTS.reopened, {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
    });

    return { ticket: updated, status: open, continued: false };
  }

  /**
   * §2.3: "A new ticket created by this rule gets `parent_id` = the closed
   * ticket, a system message 'Continued from HD-1042', and appears next to it
   * on the contact timeline. The closed ticket gets a system message
   * 'Continued in HD-1101'."
   *
   * Both messages are written in the **contact's** language, not the reader's:
   * one of them is in a thread the customer receives, and a desk that reads
   * Arabic must not decide what an English-speaking customer is sent. The
   * closed ticket's own message is written in the same language for the same
   * reason — the two halves of one sentence should not disagree.
   *
   * Auto-responders treat the new ticket as new, which is M2's to honour: it
   * is an ordinary ticket with a `parent_id`, and nothing here suppresses
   * anything.
   */
  async #continueInNewTicket(
    context: LifecycleContext,
    closed: TicketRow,
  ): Promise<CustomerReplyLanding> {
    const open = await this.#requireDefaultOpen(context.tx);
    const locale = await this.#lifecycle.localeForContact(
      context.tx,
      context.brandId,
      closed.contactId,
    );

    const created = await this.#tickets.insertTicket(context.tx, {
      brandId: context.brandId,
      departmentId: closed.departmentId,
      number: await this.#tickets.nextNumber(context.tx, context.brandId),
      // The brand's prefix as it is *now*, the same rule a first ticket
      // follows; the parent keeps whatever it was created with.
      prefix: closed.prefix,
      subject: closed.subject,
      statusId: open.id,
      priority: closed.priority,
      channel: closed.channel,
      parentId: closed.id,
      ...(closed.contactId === null ? {} : { contactId: closed.contactId }),
      ...(closed.teamId === null ? {} : { teamId: closed.teamId }),
    });

    await this.#writeContinuationMessage(context, created, 'continuedFrom', locale, closed);
    await this.#writeContinuationMessage(context, closed, 'continuedIn', locale, created);

    await writeTicketActivity(context.tx, {
      brandId: context.brandId,
      ticketId: created.id,
      departmentId: created.departmentId,
      actor: context.actor,
      action: 'ticket.continued',
      from: { ticketId: closed.id },
      to: { ticketId: created.id },
    });
    await writeTicketActivity(context.tx, {
      brandId: context.brandId,
      ticketId: closed.id,
      departmentId: closed.departmentId,
      actor: context.actor,
      action: 'ticket.continued',
      from: { ticketId: closed.id },
      to: { ticketId: created.id },
    });

    await enqueueTicketEvent(context.tx, context.brandId, TICKET_EVENTS.created, {
      ticketId: created.id,
      departmentId: created.departmentId,
    });
    await enqueueTicketEvent(context.tx, context.brandId, TICKET_EVENTS.updated, {
      ticketId: closed.id,
      departmentId: closed.departmentId,
    });

    return { ticket: created, status: open, continued: true };
  }

  /** One of the two halves of §2.3's pair, as a `system` row in a thread. */
  async #writeContinuationMessage(
    context: LifecycleContext,
    into: TicketRow,
    key: 'continuedFrom' | 'continuedIn',
    locale: Locale,
    other: TicketRow,
  ): Promise<void> {
    const t = createI18n({ lng: locale }).getFixedT(locale, 'ticket');
    const text = t(`system.${key}`, { ticket: `${other.prefix}-${other.number}` });

    await this.#tickets.insertMessage(context.tx, {
      brandId: context.brandId,
      ticketId: into.id,
      departmentId: into.departmentId,
      seq: await this.#tickets.nextSeq(context.tx, into.id),
      kind: 'system',
      authorType: 'system',
      authorId: context.actor.actorId,
      // A ticket number and a fixed sentence: nothing here comes from a person,
      // so there is nothing for the sanitiser to remove.
      bodyHtml: `<p>${text}</p>`,
      bodyText: text,
      channel: into.channel,
    });
  }

  async #requireDefaultOpen(tx: DbTransaction): Promise<TicketStatusRow> {
    const open = await this.#lifecycle.defaultOpenStatus(tx);
    if (open === undefined) {
      // Every brand is seeded with its statuses when it is created. A brand
      // without them cannot hold a ticket, which is a configuration problem
      // rather than a request one.
      throw new ConflictException('This brand has no default ticket status');
    }

    return open;
  }

  /**
   * The status move itself: the column, the activity row and the queue.
   *
   * It does not fire the close or reopen hooks. Those belong to the *caller*,
   * which knows whether this was an agent closing a ticket or a customer
   * bringing one back, and §2.2 gives the two different rows.
   */
  async #applyStatus(
    context: LifecycleContext,
    ticket: TicketRow,
    from: TicketStatusRow,
    to: TicketStatusRow,
    values: { readonly closedAt: Date | null },
  ): Promise<TicketRow> {
    const updated = await this.#tickets.updateTicket(context.tx, ticket.id, {
      statusId: to.id,
      closedAt: values.closedAt,
    });
    /* c8 ignore next 3 -- the caller read the ticket through the same transaction. */
    if (updated === undefined) {
      throw new ConflictException('That ticket moved while it was being updated');
    }

    await writeTicketActivity(context.tx, {
      brandId: context.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      actor: context.actor,
      action: 'ticket.status.changed',
      from: { statusId: from.id },
      to: { statusId: to.id },
    });

    return updated;
  }
}

/**
 * The escalation of DOMAIN-RULES §1.2, which is the gap M1-02 left open and
 * named: "moving a ticket to a department the actor cannot see is allowed (it
 * is how escalation works); the ticket disappears from their view afterwards
 * and the activity log records it."
 *
 * Three things have to happen inside one statement's worth of widened scope,
 * and all three are here so that the window is visible in one place:
 *
 * 1. the `UPDATE`, whose `WITH CHECK` half is evaluated against the **new**
 *    department;
 * 2. the `tickets_department_moved` trigger it fires, which rewrites the
 *    department of every message and activity row of that ticket;
 * 3. the activity row for the move, whose own `department_id` the
 *    `ticket_activity_department` trigger overwrites with the ticket's — by
 *    then the new one.
 *
 * Doing any of the three under the actor's own scope fails, and fails as a
 * policy violation rather than as a sentence. Doing all three widened is a
 * window of one call: {@link withWidenedDepartments} restores the scope in a
 * `finally`, never widens the brand, and leaves the policy shape untouched.
 *
 * The audit row is written **outside** the window, under the actor's own scope.
 * `audit_log` is brand-scoped and not department-scoped, so it does not need
 * the widening — and writing it outside is the proof that it does not.
 */
export const escalateIntoUnseenDepartment = async <T>(
  tx: DbTransaction,
  departmentId: string,
  move: () => Promise<T>,
): Promise<T> => withWidenedDepartments(tx, [departmentId], move);
