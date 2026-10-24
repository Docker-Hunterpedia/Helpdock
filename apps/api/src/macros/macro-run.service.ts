import { tickets, users } from '@helpdock/db';
import type {
  MacroRunRequest,
  MacroRunResponse,
  SnoozePresetKey,
  TicketMessage,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { requestAutoAssign } from '../assignment/assignment-events.js';
import { routesAutomatically } from '../assignment/ticket-assignment.js';
import type { Principal } from '../auth/principal.js';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { getTx } from '../context/request-context.js';
import { replaceTicketTags, tagsOfTicket } from '../ticketing/ticket-tags.js';
import type { SnoozeResolver } from '../tickets/snooze/snooze-calendar.js';
import { activityActorFor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import type { ActivityBundle, TicketsService } from '../tickets/tickets.service.js';
import { actionsBelongTo, type MacroPlan, planMacro, tagsAfter } from './macro-actions.js';
import { type MacroActor, seesMacro, usableIn } from './macro-rules.js';
import type { MacrosRepository } from './macros.repository.js';
import { readRenderTicket } from './macros.repository.js';
import { actionsOf } from './macros.service.js';

/** The update a macro's actions come to: the planner's fields, plus the snooze's resolved instant. */
type MacroRunFields = MacroPlan['fields'] & { readonly snoozedUntil?: string };

/**
 * A macro or canned response applied to a ticket (M3-06).
 *
 * The composer stages a macro's actions as chips and sends them with the reply;
 * without a reply they run at once (artboard `AdminComposerMacros`). Either way
 * it is **one request and one transaction**: the reply, then the actions in
 * their order, then **one** activity entry — `ticket.macro_applied`, "via macro
 * Shipping delay" — carrying everything that moved. A reply that fails takes
 * the actions with it, and an action that fails takes the reply.
 *
 * Every action goes through the path a person's own edit takes —
 * `TicketsService.update` for status, priority and assignee, the tag
 * replacement for tags — so a macro can do nothing its user could not do by
 * hand: an assignee outside the department is refused the same way, and a
 * status move writes the same lifecycle rows.
 */
export class MacroRunService {
  readonly #macros: MacrosRepository;
  readonly #tickets: TicketsService;
  readonly #assignment: AssignmentRepository;
  readonly #snooze: SnoozeResolver;

  constructor(
    macros: MacrosRepository,
    tickets: TicketsService,
    assignment: AssignmentRepository,
    snooze: SnoozeResolver,
  ) {
    this.#macros = macros;
    this.#tickets = tickets;
    this.#assignment = assignment;
    this.#snooze = snooze;
  }

  async run(
    brandId: string,
    principal: Principal,
    actor: MacroActor,
    ticketId: string,
    request: MacroRunRequest,
  ): Promise<MacroRunResponse> {
    const tx = getTx();

    const ticket = await readRenderTicket(tx, ticketId);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }

    const row = await this.#macros.find(tx, request.macroId);
    if (row === undefined || !seesMacro(actor, row) || !usableIn(row, ticket.departmentId)) {
      throw new NotFoundException('No such macro or canned response for this ticket');
    }
    if (!actionsBelongTo(request.actions, actionsOf(row))) {
      throw new TicketingFailure('macro-changed');
    }

    const message: TicketMessage | null =
      request.reply === undefined
        ? null
        : await this.#tickets.addMessage(brandId, principal, ticketId, request.reply);
    // A reply to a closed ticket may have landed on a ticket that continues it
    // (DOMAIN-RULES §2.3); the actions follow the conversation there.
    const targetId = message?.ticketId ?? ticketId;

    await this.#macros.touchUsed(tx, row.id, new Date());

    if (request.actions.length === 0) {
      return { message };
    }

    const bundle: ActivityBundle = { from: {}, to: {} };
    const plan = planMacro(request.actions, actor.userId);

    // #368. The `snooze` action's preset becomes an instant here, against the
    // ticket's department calendar, and the rest is the one update's work —
    // activity, outbox event, wake timer, `snoozed_by` — exactly as the
    // sender's own snooze through the same method.
    const fields =
      plan.snoozePreset === undefined
        ? plan.fields
        : await this.#withSnooze(brandId, targetId, plan.fields, plan.snoozePreset, actor.userId);

    const departmentId =
      Object.keys(fields).length === 0
        ? (await readRenderTicket(tx, targetId))?.departmentId
        : (await this.#tickets.update(brandId, principal, targetId, fields, { bundle }))
            .departmentId;
    /* c8 ignore next 3 -- the ticket was read above, inside this transaction. */
    if (departmentId === undefined) {
      throw new NotFoundException('No such ticket');
    }

    if (plan.tagOps.length > 0) {
      await this.#applyTags(brandId, targetId, departmentId, plan.tagOps, bundle);
    }

    if (plan.routeToTeam && (await routesAutomatically(this.#assignment, tx, departmentId))) {
      await requestAutoAssign(tx, brandId, { ticketId: targetId, trigger: 'routed' });
    }

    await writeTicketActivity(tx, {
      brandId,
      ticketId: targetId,
      departmentId,
      actor: activityActorFor(principal),
      action: 'ticket.macro_applied',
      from: bundle.from,
      to: {
        ...bundle.to,
        macroId: row.id,
        macroName: row.name,
        ...(message === null ? {} : { messageId: message.id }),
      },
    });

    return { message };
  }

  /**
   * The ticket the actions land on, for the instant's calendar: the same
   * read the update itself will make, so a ticket that is not there refuses
   * before anything is resolved.
   */
  async #withSnooze(
    brandId: string,
    ticketId: string,
    fields: MacroPlan['fields'],
    preset: SnoozePresetKey,
    userId: string,
  ): Promise<MacroRunFields> {
    const tx = getTx();
    const target = await readRenderTicket(tx, ticketId);
    if (target === undefined) {
      throw new NotFoundException('No such ticket');
    }
    // The person's own zone from Profile (M14-12), as the Snooze menu uses it;
    // the brand's when they have not chosen one.
    const [profile] = await tx
      .select({ timeZone: users.timeZone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const until = await this.#snooze.at(
      tx,
      brandId,
      target.departmentId,
      preset,
      new Date(),
      profile?.timeZone ?? null,
    );

    return { ...fields, snoozedUntil: until.toISOString() };
  }

  async #applyTags(
    brandId: string,
    ticketId: string,
    departmentId: string,
    ops: ReturnType<typeof planMacro>['tagOps'],
    bundle: ActivityBundle,
  ): Promise<void> {
    const tx = getTx();
    const tagIds = ops.map((op) => op.tagId);
    const known = await this.#macros.referencesExist(tx, {
      statusIds: [],
      tagIds,
      userIds: [],
      teamIds: [],
    });
    if (!known) {
      // Somebody deleted a tag the macro names since it was saved.
      throw new TicketingFailure('macro-changed');
    }

    const current = (await tagsOfTicket(tx, ticketId)).map((tag) => tag.id);
    const change = await replaceTicketTags(tx, {
      brandId,
      ticketId,
      departmentId,
      tagIds: tagsAfter(current, ops),
    });
    if (!change.changed) {
      return;
    }

    bundle.from.tagIds = change.before;
    bundle.to.tagIds = change.after;
    await tx.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, ticketId));
    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.updated, { ticketId, departmentId });
  }
}
