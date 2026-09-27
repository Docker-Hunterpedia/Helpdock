import { sanitizeMessageBody } from '@helpdock/channels';
import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import {
  type ActionOutcome,
  RULE_NOTIFY_EVENT,
  type RuleAction,
  type RuleNotifyRecipient,
  ruleNotifyPayloadSchema,
} from '@helpdock/schemas';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { requestAutoAssign } from '../assignment/assignment-events.js';
import { canWorkDepartment } from '../assignment/rotation.js';
import { routesAutomatically } from '../assignment/ticket-assignment.js';
import { escapeHtml } from '../auth/email-templates.js';
import { mergeCustomValues, parseCustomValues } from '../ticketing/custom-values.js';
import { replaceTicketTags, tagsOfTicket } from '../ticketing/ticket-tags.js';
import type {
  LifecycleContext,
  TicketLifecycleService,
} from '../tickets/lifecycle/lifecycle.service.js';
import { applyStatusChange } from '../tickets/status-change.js';
import { type ActivityActor, writeTicketActivity } from '../tickets/ticket-activity.js';
import {
  enqueueTicketEvent,
  TICKET_EVENTS,
  type TicketChange,
  type TicketEvent,
} from '../tickets/ticket-events.js';
import type { TicketRepository } from '../tickets/tickets.repository.js';
import type { CannedResponseRenderer } from './ports.js';
import type { RulesRepository } from './rules.repository.js';

/**
 * REQUIREMENTS §4.3's "THEN <actions>", carried out inside the brand's system
 * transaction the job opened, in the order the rule lists them.
 *
 * Every change leaves what a person's change leaves — the column, a
 * `ticket_activity` row with actor `rule:<id>` and `via = rule` (DOMAIN-RULES
 * §2.2: "logged with actor `rule:<id>`"), and one outbox event — so the thread,
 * the open screens, the clocks and the next rule all hear about it the way they
 * hear about anything else. The event carries the rule chain, which is how the
 * depth guard follows a chain through the outbox.
 *
 * An action that cannot be done — a team that was deleted since the rule was
 * saved, an agent who cannot work the department — is reported `unavailable`
 * and the rest still run: a rule that assigned and replied should still reply
 * when the team it named is gone. An action that would change nothing writes
 * nothing, so an idempotent rule never sets off another.
 */

/** Who a rule's changes are recorded as. */
export const ruleActor = (ruleId: string): ActivityActor => ({
  actorType: 'system',
  actorId: `rule:${ruleId}`,
  via: 'rule',
});

/**
 * The lifecycle moments a rule's changes owe: M1's close and reopen (§2.2,
 * §3.5), and M3-02's change and response, which move the SLA clocks as an
 * agent's change or reply would (§3.1 to §3.3).
 */
export type LifecycleMoments = Pick<
  TicketLifecycleService,
  'onClosed' | 'onReopened' | 'onChanged' | 'onResponded'
>;

export interface RuleActionDeps {
  readonly rules: RulesRepository;
  readonly tickets: TicketRepository;
  readonly assignment: AssignmentRepository;
  readonly lifecycle: LifecycleMoments;
  readonly cannedResponses: CannedResponseRenderer;
}

export interface RuleActionContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly ruleId: string;
  /** The chain the changes carry: the rules before this one, then this one. */
  readonly chain: readonly string[];
  readonly now: Date;
}

/** What one run of a rule's actions changed, accumulated across them. */
interface RunState {
  ticket: TicketRow;
  status: TicketStatusRow;
  readonly changes: Set<TicketChange>;
  /** The status event the run ends with, when a status action moved it. */
  statusEvent: TicketEvent | null;
  /** Whether an action left the ticket unassigned and wanting the rotation. */
  wantsRotation: boolean;
}

type Effect = Omit<ActionOutcome, 'action'>;

const CHANGED: Effect = { effect: 'changed' };
const UNCHANGED: Effect = { effect: 'unchanged' };
const UNAVAILABLE: Effect = { effect: 'unavailable' };

const lifecycleContext = (context: RuleActionContext): LifecycleContext => ({
  tx: context.tx,
  brandId: context.brandId,
  actor: ruleActor(context.ruleId),
  now: context.now,
});

const writeUpdate = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  values: Partial<TicketRow>,
  from: Record<string, unknown>,
): Promise<void> => {
  const updated = await deps.tickets.updateTicket(context.tx, state.ticket.id, values);
  /* c8 ignore next 3 -- the system transaction read the row a moment ago. */
  if (updated === undefined) {
    throw new Error('The ticket a rule was acting on disappeared');
  }
  await writeTicketActivity(context.tx, {
    brandId: context.brandId,
    ticketId: updated.id,
    departmentId: updated.departmentId,
    actor: ruleActor(context.ruleId),
    action: 'ticket.updated',
    from,
    to: values,
  });
  state.ticket = updated;
};

const moveStatus = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  next: TicketStatusRow | undefined,
): Promise<Effect> => {
  if (next === undefined) {
    return UNAVAILABLE;
  }

  let result: ReturnType<typeof applyStatusChange>;
  try {
    // A rule uses the same transitions as an agent picking a status
    // (DOMAIN-RULES §2.2: "Time-based rules and workflow actions use the same
    // transitions"), so it is refused where an agent would be.
    result = applyStatusChange({
      requestedStatusId: next.id,
      current: state.status,
      next,
      closedAt: state.ticket.closedAt,
      ticket: state.ticket,
      event: 'agent.status',
      now: context.now,
    });
  } catch {
    return UNAVAILABLE;
  }
  if (!result.changed) {
    return UNCHANGED;
  }

  const previous = state.status;
  const updated = await deps.tickets.updateTicket(context.tx, state.ticket.id, {
    statusId: result.statusId,
    closedAt: result.closedAt,
  });
  /* c8 ignore next 3 -- as above. */
  if (updated === undefined) {
    throw new Error('The ticket a rule was acting on disappeared');
  }
  const actor = ruleActor(context.ruleId);
  const base = {
    brandId: context.brandId,
    ticketId: updated.id,
    departmentId: updated.departmentId,
    actor,
  };
  await writeTicketActivity(context.tx, {
    ...base,
    action: 'ticket.status.changed',
    from: { statusId: previous.id },
    to: { statusId: next.id },
  });

  if (result.closing) {
    await writeTicketActivity(context.tx, {
      ...base,
      action: 'ticket.closed',
      from: { statusId: previous.id },
      to: { statusId: next.id, closedAt: updated.closedAt?.toISOString() ?? null },
    });
    await deps.lifecycle.onClosed(lifecycleContext(context), updated, next);
  } else if (result.reopening) {
    await writeTicketActivity(context.tx, {
      ...base,
      action: 'ticket.reopened',
      from: { statusId: previous.id },
      to: { statusId: next.id },
    });
    await deps.lifecycle.onReopened(lifecycleContext(context), updated, next);
  }

  state.ticket = updated;
  state.status = next;
  state.changes.add('status');
  state.statusEvent = statusEventFor(next, result) ?? state.statusEvent;
  return CHANGED;
};

/** The named event a status move is, as `tickets.service.ts` names a person's. */
const statusEventFor = (
  next: TicketStatusRow,
  result: { readonly closing: boolean; readonly reopening: boolean },
): TicketEvent | null => {
  if (next.isSpam) {
    return TICKET_EVENTS.spam;
  }
  if (result.closing) {
    return TICKET_EVENTS.closed;
  }
  return result.reopening ? TICKET_EVENTS.reopened : null;
};

const assignTeam = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  teamId: string,
): Promise<Effect> => {
  const team = await deps.rules.team(context.tx, teamId);
  if (team === undefined) {
    return UNAVAILABLE;
  }
  if (state.ticket.teamId === teamId) {
    return UNCHANGED;
  }

  const { ticket } = state;
  const values: Partial<TicketRow> = { teamId };
  const from: Record<string, unknown> = { teamId: ticket.teamId };

  // A team belongs to one department, so handing the ticket to it moves the
  // ticket there — which is how a rule escalates (DOMAIN-RULES §1.2). An
  // assignee who cannot follow is taken off, as for a person's move (M1-07).
  if (team.departmentId !== ticket.departmentId) {
    values.departmentId = team.departmentId;
    from.departmentId = ticket.departmentId;
    state.changes.add('department');

    if (ticket.assigneeId !== null) {
      const member = await deps.assignment.member(context.tx, context.brandId, ticket.assigneeId);
      if (member === undefined || !canWorkDepartment(member, team.departmentId)) {
        values.assigneeId = null;
        from.assigneeId = ticket.assigneeId;
        state.changes.add('assignee');
      }
    }
  }

  await writeUpdate(deps, context, state, values, from);
  state.changes.add('team');
  state.wantsRotation = state.ticket.assigneeId === null;
  return CHANGED;
};

const assignAgent = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  userId: string,
): Promise<Effect> => {
  const member = await deps.assignment.member(context.tx, context.brandId, userId);
  if (member === undefined || !canWorkDepartment(member, state.ticket.departmentId)) {
    return UNAVAILABLE;
  }
  if (state.ticket.assigneeId === userId) {
    return UNCHANGED;
  }

  await writeUpdate(
    deps,
    context,
    state,
    { assigneeId: userId },
    { assigneeId: state.ticket.assigneeId },
  );
  state.changes.add('assignee');
  state.wantsRotation = false;
  return CHANGED;
};

const assignRoundRobin = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
): Promise<Effect> => {
  if (!(await routesAutomatically(deps.assignment, context.tx, state.ticket.departmentId))) {
    return UNAVAILABLE;
  }

  if (state.ticket.assigneeId !== null) {
    await writeUpdate(
      deps,
      context,
      state,
      { assigneeId: null },
      { assigneeId: state.ticket.assigneeId },
    );
    state.changes.add('assignee');
  }
  state.wantsRotation = true;
  return CHANGED;
};

const setField = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  key: string,
  value: string | null,
): Promise<Effect> => {
  let patch: Record<string, unknown> | undefined;
  try {
    patch = await parseCustomValues(context.tx, 'ticket', { [key]: value }, { partial: true });
  } catch {
    // A field that was deleted, or a value its definition no longer accepts.
    return UNAVAILABLE;
  }

  const merged = mergeCustomValues(state.ticket.custom, patch ?? {});
  if (JSON.stringify(merged) === JSON.stringify(state.ticket.custom)) {
    return UNCHANGED;
  }

  await writeUpdate(deps, context, state, { custom: merged }, { custom: state.ticket.custom });
  state.changes.add('custom');
  return CHANGED;
};

const changeTag = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  tagId: string,
  add: boolean,
): Promise<Effect> => {
  if (!(await deps.rules.tagExists(context.tx, tagId))) {
    return UNAVAILABLE;
  }

  const current = (await tagsOfTicket(context.tx, state.ticket.id)).map((tag) => tag.id);
  const next = add ? [...current, tagId] : current.filter((id) => id !== tagId);
  const change = await replaceTicketTags(context.tx, {
    brandId: context.brandId,
    ticketId: state.ticket.id,
    departmentId: state.ticket.departmentId,
    tagIds: next,
  });
  if (!change.changed) {
    return UNCHANGED;
  }

  await writeTicketActivity(context.tx, {
    brandId: context.brandId,
    ticketId: state.ticket.id,
    departmentId: state.ticket.departmentId,
    actor: ruleActor(context.ruleId),
    action: 'ticket.tags.changed',
    from: { tagIds: change.before },
    to: { tagIds: change.after },
  });
  state.changes.add('tags');
  if (add) {
    state.changes.add('tag_added');
  }
  return CHANGED;
};

/** Writes a message a rule sends or notes, and the event that tells everyone else. */
const writeMessage = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  message: { kind: 'public' | 'note'; html: string; countsAsResponse?: boolean },
): Promise<void> => {
  const body = sanitizeMessageBody(message.html);
  const { ticket } = state;
  const seq = await deps.tickets.nextSeq(context.tx, ticket.id);
  const row = await deps.tickets.insertMessage(context.tx, {
    brandId: context.brandId,
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    seq,
    kind: message.kind,
    authorType: 'system',
    authorId: `rule:${context.ruleId}`,
    bodyHtml: body.html,
    bodyText: body.text,
    channel: ticket.channel,
  });

  await writeTicketActivity(context.tx, {
    brandId: context.brandId,
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    actor: ruleActor(context.ruleId),
    action: message.kind === 'note' ? 'ticket.note_added' : 'ticket.replied',
    to: { messageId: row.id, seq },
  });
  const updated = await deps.tickets.updateTicket(context.tx, ticket.id, {});
  state.ticket = updated ?? ticket;

  await enqueueTicketEvent(
    context.tx,
    context.brandId,
    message.kind === 'note' ? TICKET_EVENTS.noteAdded : TICKET_EVENTS.replied,
    {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      messageId: row.id,
      seq,
      kind: message.kind,
      ruleChain: [...context.chain],
      ...(message.countsAsResponse === undefined
        ? {}
        : { countsAsResponse: message.countsAsResponse }),
    },
  );
};

const sendCanned = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  cannedResponseId: string,
  countsAsResponse: boolean,
): Promise<Effect> => {
  const locale =
    (await contactLocale(deps, context, state)) ??
    (await deps.rules.brandLocale(context.tx, context.brandId));
  const rendered = await deps.cannedResponses.render(cannedResponseId, {
    locale,
    ticket: state.ticket,
    tx: context.tx,
  });
  if (rendered === null) {
    return UNAVAILABLE;
  }

  await writeMessage(deps, context, state, {
    kind: 'public',
    html: rendered.bodyHtml,
    countsAsResponse,
  });
  // The SLA engine decides whether it counts: only with `counts_as_response`.
  await deps.lifecycle.onResponded(lifecycleContext(context), state.ticket, state.status, {
    by: 'rule',
    countsAsResponse,
  });
  return CHANGED;
};

const contactLocale = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
): Promise<'en' | 'ar' | null> =>
  state.ticket.contactId === null
    ? null
    : deps.rules.contactLocale(context.tx, state.ticket.contactId);

const recipientsOf = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  recipient: RuleNotifyRecipient,
): Promise<string[]> => {
  switch (recipient.kind) {
    case 'department_leads':
      return deps.rules.departmentLeadIds(context.tx, context.brandId, state.ticket.departmentId);
    case 'assignee':
      return state.ticket.assigneeId === null ? [] : [state.ticket.assigneeId];
    case 'team':
      return deps.rules.teamMemberIds(context.tx, recipient.teamId);
    case 'user':
      return (await deps.rules.isActiveMember(context.tx, context.brandId, recipient.userId))
        ? [recipient.userId]
        : [];
  }
};

/**
 * `rule.notify` through the outbox: the notifications of M3-07 decide how each
 * recipient hears (in-app, email, push, by their preferences). The rules
 * engine only decides who.
 */
const notify = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  recipient: RuleNotifyRecipient,
  message: string | null,
): Promise<Effect> => {
  const recipients = await recipientsOf(deps, context, state, recipient);
  if (recipients.length === 0) {
    return UNAVAILABLE;
  }

  await enqueueOutbox(context.tx, {
    brandId: context.brandId,
    event: RULE_NOTIFY_EVENT,
    payload: ruleNotifyPayloadSchema.parse({
      ticketId: state.ticket.id,
      recipients,
      message,
      ruleId: context.ruleId,
    }),
  });
  return { effect: 'changed', recipientIds: recipients };
};

const runOne = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  state: RunState,
  action: RuleAction,
): Promise<Effect> => {
  switch (action.type) {
    case 'set_status':
      return moveStatus(deps, context, state, await deps.rules.status(context.tx, action.statusId));
    case 'escalate':
      return moveStatus(
        deps,
        context,
        state,
        await deps.rules.statusByKey(context.tx, 'escalated'),
      );
    case 'close':
      return moveStatus(deps, context, state, await deps.rules.statusByKey(context.tx, 'closed'));
    case 'set_priority':
      if (state.ticket.priority === action.priority) {
        return UNCHANGED;
      }
      await writeUpdate(
        deps,
        context,
        state,
        { priority: action.priority },
        { priority: state.ticket.priority },
      );
      state.changes.add('priority');
      return CHANGED;
    case 'set_field':
      return setField(deps, context, state, action.key, action.value);
    case 'assign_team':
      return assignTeam(deps, context, state, action.teamId);
    case 'assign_agent':
      return assignAgent(deps, context, state, action.userId);
    case 'assign_round_robin':
      return assignRoundRobin(deps, context, state);
    case 'add_tag':
      return changeTag(deps, context, state, action.tagId, true);
    case 'remove_tag':
      return changeTag(deps, context, state, action.tagId, false);
    case 'send_canned':
      return sendCanned(deps, context, state, action.cannedResponseId, action.countsAsResponse);
    case 'add_note':
      await writeMessage(deps, context, state, {
        kind: 'note',
        html: `<p>${escapeHtml(action.body)}</p>`,
      });
      return CHANGED;
    case 'notify':
      return notify(deps, context, state, action.recipient, action.message ?? null);
  }
};

/** What the SLA clocks read: the status pauses them, the other two pick the policy (§3.2, §3.3). */
const CLOCK_CHANGES: readonly TicketChange[] = ['status', 'priority', 'department'];

/**
 * Runs a rule's actions on one ticket, in order, and writes the one ticket
 * event their changes add up to. Returns what each action did, for the log.
 */
export const applyRuleActions = async (
  deps: RuleActionDeps,
  context: RuleActionContext,
  target: { readonly ticket: TicketRow; readonly status: TicketStatusRow },
  actions: readonly RuleAction[],
): Promise<ActionOutcome[]> => {
  const state: RunState = {
    ticket: target.ticket,
    status: target.status,
    changes: new Set(),
    statusEvent: null,
    wantsRotation: false,
  };

  const outcomes: ActionOutcome[] = [];
  for (const action of actions) {
    outcomes.push({ action, ...(await runOne(deps, context, state, action)) });
  }

  const previousDepartmentId = target.ticket.departmentId;
  if (CLOCK_CHANGES.some((change) => state.changes.has(change))) {
    await deps.lifecycle.onChanged(
      lifecycleContext(context),
      state.ticket,
      state.status,
      previousDepartmentId === state.ticket.departmentId ? undefined : previousDepartmentId,
    );
  }

  if (state.changes.size > 0) {
    await enqueueTicketEvent(
      context.tx,
      context.brandId,
      state.statusEvent ?? TICKET_EVENTS.updated,
      {
        ticketId: state.ticket.id,
        departmentId: state.ticket.departmentId,
        ...(previousDepartmentId === state.ticket.departmentId ? {} : { previousDepartmentId }),
        changes: [...state.changes],
        ruleChain: [...context.chain],
      },
    );
  }

  // After the event, as a person's move does it (M1-07): the rotation picks in
  // its own job, and the pick carries the chain on to its `assigned` event.
  if (
    state.wantsRotation &&
    state.ticket.assigneeId === null &&
    (await routesAutomatically(deps.assignment, context.tx, state.ticket.departmentId))
  ) {
    await requestAutoAssign(context.tx, context.brandId, {
      ticketId: state.ticket.id,
      trigger: 'routed',
      ruleChain: [...context.chain],
    });
  }

  return outcomes;
};
