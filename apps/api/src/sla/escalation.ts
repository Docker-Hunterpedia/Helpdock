import {
  type DbTransaction,
  type Ticket as TicketRow,
  tags,
  ticketStatuses,
  tickets,
  ticketTags,
} from '@helpdock/db';
import type { SlaTimerPayload } from '@helpdock/jobs';
import {
  SLA_BREACH_PERCENT,
  type SlaAction,
  type SlaNotify,
  type TicketPriority,
} from '@helpdock/schemas';
import { eq } from 'drizzle-orm';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { worksDepartment } from '../assignment/ticket-assignment.js';
import { type ActivityActor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import { breach, hasFired, isCounting, markFired, timeOfPercent } from './clock.js';
import type { SlaRepository } from './sla.repository.js';
import type { SlaService } from './sla.service.js';
import { enqueueSlaBreached, enqueueSlaWarning, enqueueTicketEscalated } from './sla-events.js';
import { summaryColumns } from './ticket-clocks.js';

/**
 * What one SLA timer does when it fires (DOMAIN-RULES §3.4), inside the
 * brand's system transaction.
 *
 * 1. The clock is read under a lock on its ticket. A clock that is no longer
 *    counting, or a step that already ran, ends the job: a timer is a nudge,
 *    and the clock row is the truth.
 * 2. A timer that is early — the clock was paused, or its target raised, after
 *    the timer was added — reports when it should fire instead, and the caller
 *    moves the job there.
 * 3. Otherwise the step is marked fired, the breach recorded at 100 %, the
 *    step's actions run, and the events go out through the outbox: `sla.warning`
 *    below 100 %, `sla.breached` at it, `ticket.escalated` past it or when a
 *    step set status Escalated.
 */

export type TimerOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'fired' }
  | { readonly kind: 'early'; readonly fireAt: Date };

export interface EscalationDeps {
  readonly repository: SlaRepository;
  readonly sla: SlaService;
  readonly assignment: AssignmentRepository;
}

/** A timer may run up to this much before its moment and still fire. */
const EARLY_TOLERANCE_MS = 1_000;

const PRIORITY_ORDER: readonly TicketPriority[] = ['low', 'medium', 'high', 'urgent'];

export const fireSlaTimer = async (
  tx: DbTransaction,
  deps: EscalationDeps,
  payload: SlaTimerPayload,
  now: Date,
): Promise<TimerOutcome> => {
  const found = await deps.repository.findTicket(tx, payload.ticketId);
  if (found === undefined) {
    return { kind: 'done' };
  }
  await deps.repository.lockTicket(tx, payload.ticketId);

  const clocks = await deps.repository.currentClocks(tx, payload.ticketId);
  const clock = clocks.find((candidate) => candidate.kind === payload.clock);
  const percent = payload.stepPercent;
  if (
    clock === undefined ||
    !isCounting(clock) ||
    hasFired(clock, percent) ||
    (percent === SLA_BREACH_PERCENT && clock.breachedAt !== null)
  ) {
    return { kind: 'done' };
  }

  const brand = await deps.sla.brandContext(tx, payload.brandId);
  const fireAt = timeOfPercent(
    clock,
    brand.calendarFor(clock.timeMode, found.ticket.departmentId),
    percent,
  );
  if (fireAt === null) {
    return { kind: 'done' };
  }
  if (fireAt.getTime() - now.getTime() > EARLY_TOLERANCE_MS) {
    return { kind: 'early', fireAt };
  }

  const ticket = found.ticket;
  const breaching = percent >= SLA_BREACH_PERCENT && clock.breachedAt === null;
  const fired = markFired(breaching ? breach(clock, now) : clock, percent, now);
  const current = clocks.map((candidate) => (candidate.id === fired.id ? fired : candidate));
  await deps.repository.saveClocks(tx, payload.brandId, ticket, [fired]);
  await deps.repository.writeSummary(tx, ticket, {
    ...summaryColumns(current, ticket.slaPolicyId),
    slaCycle: ticket.slaCycle,
  });

  const actor: ActivityActor = { actorType: 'system', actorId: 'sla', via: 'system' };
  const base = { brandId: payload.brandId, ticketId: ticket.id, departmentId: ticket.departmentId };
  if (breaching) {
    await writeTicketActivity(tx, {
      ...base,
      actor,
      action: 'ticket.sla.breached',
      to: { clock: clock.kind, cause: 'timer' },
    });
    await enqueueSlaBreached(tx, payload.brandId, {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      clock: clock.kind,
      cause: 'timer',
    });
  }

  const policy = brand.policies.find((candidate) => candidate.id === fired.policyId);
  const step = policy?.escalation.find((candidate) => candidate.atPercent === percent);
  if (step !== undefined) {
    await writeTicketActivity(tx, {
      ...base,
      actor,
      action: 'ticket.sla.step',
      to: { clock: clock.kind, percent },
    });
    const escalatedByStatus = await runActions(tx, deps, ticket, step.actions, actor);
    const event = {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      clock: clock.kind,
      stepPercent: percent,
      ...notifyOf(step.actions),
    };
    if (percent < SLA_BREACH_PERCENT) {
      await enqueueSlaWarning(tx, payload.brandId, event);
    }
    if (percent >= SLA_BREACH_PERCENT || escalatedByStatus) {
      await enqueueTicketEscalated(tx, payload.brandId, event);
    }
  }

  // A step may have raised the priority or moved the status; the clocks follow
  // (§3.3), and the steps already fired stay fired.
  await deps.sla.sync(tx, { brandId: payload.brandId, ticketId: ticket.id, at: now });
  await enqueueTicketEvent(tx, payload.brandId, TICKET_EVENTS.updated, {
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
  });

  return { kind: 'fired' };
};

/** Who a step's `notify` actions named, or nothing when it has none. */
const notifyOf = (actions: readonly SlaAction[]): { notify?: SlaNotify } => {
  const recipients = actions.flatMap((action) =>
    action.type === 'notify' ? [action.recipient] : [],
  );
  if (recipients.length === 0) {
    return {};
  }

  return {
    notify: {
      userIds: recipients.flatMap((recipient) =>
        recipient.kind === 'user' ? [recipient.userId] : [],
      ),
      teamIds: recipients.flatMap((recipient) =>
        recipient.kind === 'team' ? [recipient.teamId] : [],
      ),
      departmentLeads: recipients.some((recipient) => recipient.kind === 'department_leads'),
    },
  };
};

/**
 * The actions of one step, in order. An action whose target has gone — a
 * deleted tag, somebody who can no longer work the department — is skipped:
 * the step still ran, and the rest of it still matters. Returns whether the
 * step moved the ticket to Escalated.
 */
const runActions = async (
  tx: DbTransaction,
  deps: EscalationDeps,
  ticket: TicketRow,
  actions: readonly SlaAction[],
  actor: ActivityActor,
): Promise<boolean> => {
  let escalated = false;
  const log = (from: Record<string, unknown>, to: Record<string, unknown>) =>
    writeTicketActivity(tx, {
      brandId: ticket.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      actor,
      action: 'ticket.updated',
      from,
      to,
    });

  for (const action of actions) {
    switch (action.type) {
      case 'notify':
        break;
      case 'raise_priority': {
        const [row] = await tx
          .select({ priority: tickets.priority })
          .from(tickets)
          .where(eq(tickets.id, ticket.id));
        const from = row?.priority ?? ticket.priority;
        const to = PRIORITY_ORDER[PRIORITY_ORDER.indexOf(from) + 1];
        if (to !== undefined) {
          await tx
            .update(tickets)
            .set({ priority: to, updatedAt: new Date() })
            .where(eq(tickets.id, ticket.id));
          await log({ priority: from }, { priority: to });
        }
        break;
      }
      case 'reassign': {
        const eligible = await worksDepartment(deps.assignment, tx, {
          brandId: ticket.brandId,
          userId: action.userId,
          departmentId: ticket.departmentId,
        });
        if (eligible && action.userId !== ticket.assigneeId) {
          await tx
            .update(tickets)
            .set({ assigneeId: action.userId, updatedAt: new Date() })
            .where(eq(tickets.id, ticket.id));
          await log({ assigneeId: ticket.assigneeId }, { assigneeId: action.userId });
        }
        break;
      }
      case 'add_tag': {
        const [tag] = await tx.select({ id: tags.id }).from(tags).where(eq(tags.id, action.tagId));
        if (tag !== undefined) {
          const before = (
            await tx
              .select({ tagId: ticketTags.tagId })
              .from(ticketTags)
              .where(eq(ticketTags.ticketId, ticket.id))
          ).map((row) => row.tagId);
          const added = await tx
            .insert(ticketTags)
            .values({
              brandId: ticket.brandId,
              ticketId: ticket.id,
              tagId: tag.id,
              departmentId: ticket.departmentId,
            })
            .onConflictDoNothing()
            .returning({ tagId: ticketTags.tagId });
          if (added.length > 0) {
            await writeTicketActivity(tx, {
              brandId: ticket.brandId,
              ticketId: ticket.id,
              departmentId: ticket.departmentId,
              actor,
              action: 'ticket.tags.changed',
              from: { tagIds: before },
              to: { tagIds: [...before, tag.id] },
            });
          }
        }
        break;
      }
      case 'set_escalated': {
        const [status] = await tx
          .select({ id: ticketStatuses.id })
          .from(ticketStatuses)
          .where(eq(ticketStatuses.systemKey, 'escalated'));
        if (status !== undefined && status.id !== ticket.statusId) {
          await tx
            .update(tickets)
            .set({ statusId: status.id, updatedAt: new Date() })
            .where(eq(tickets.id, ticket.id));
          await writeTicketActivity(tx, {
            brandId: ticket.brandId,
            ticketId: ticket.id,
            departmentId: ticket.departmentId,
            actor,
            action: 'ticket.status.changed',
            from: { statusId: ticket.statusId },
            to: { statusId: status.id },
          });
          escalated = true;
        }
        break;
      }
    }
  }

  return escalated;
};
