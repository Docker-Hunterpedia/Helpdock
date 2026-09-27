import type { DbTransaction } from '@helpdock/db';
import type { ActionOutcome, RuleAction, RuleTestFollowOn, RuleTrigger } from '@helpdock/schemas';
import {
  type EvaluationContext,
  evaluateConditions,
  firstFailedGroup,
  ruleActionSchema,
  ruleConditionsSchema,
} from '@helpdock/schemas';
import { z } from 'zod';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { canWorkDepartment } from '../assignment/rotation.js';
import { routesAutomatically } from '../assignment/ticket-assignment.js';
import type { TicketChange } from '../tickets/ticket-events.js';
import type { RulesRepository } from './rules.repository.js';
import type { TicketFacts } from './ticket-facts.js';
import { guardRun, RULE_SOURCE_EVENTS, triggersFor } from './triggers.js';

/**
 * M3-05's test run: a draft rule against a real ticket, with **nothing
 * changed, sent or logged**. Every read goes through the reader's own request
 * transaction, so a ticket they cannot see is a ticket the test cannot find,
 * and nothing here writes.
 *
 * What it answers is what the artboard asks: would the rule run, and why
 * (each condition with what it found); what each action would do; and which
 * other rules its changes could set off at depth 2, with whether they would
 * run. It looks one level deep: that is the step a person can reason about
 * when editing one rule, and the log shows the rest when it happens.
 */

export interface PreviewDeps {
  readonly rules: RulesRepository;
  readonly assignment: AssignmentRepository;
}

interface Simulation {
  facts: TicketFacts;
  readonly changes: Set<TicketChange>;
  closedOrReopened: boolean;
}

type Effect = Omit<ActionOutcome, 'action'>;

const CHANGED: Effect = { effect: 'changed' };
const UNCHANGED: Effect = { effect: 'unchanged' };
const UNAVAILABLE: Effect = { effect: 'unavailable' };

const moveStatusTo = async (
  tx: DbTransaction,
  deps: PreviewDeps,
  sim: Simulation,
  statusId: string | undefined,
): Promise<Effect> => {
  const next = statusId === undefined ? undefined : await deps.rules.status(tx, statusId);
  if (next === undefined) {
    return UNAVAILABLE;
  }
  if (next.id === sim.facts.statusId) {
    return UNCHANGED;
  }
  const current = await deps.rules.status(tx, sim.facts.statusId);
  sim.closedOrReopened ||= (current?.systemState === 'closed') !== (next.systemState === 'closed');
  sim.facts = { ...sim.facts, statusId: next.id };
  sim.changes.add('status');
  return CHANGED;
};

const previewOne = async (
  tx: DbTransaction,
  brandId: string,
  deps: PreviewDeps,
  sim: Simulation,
  action: RuleAction,
): Promise<Effect> => {
  const { facts } = sim;

  switch (action.type) {
    case 'set_status':
      return moveStatusTo(tx, deps, sim, action.statusId);
    case 'escalate':
      return moveStatusTo(tx, deps, sim, (await deps.rules.statusByKey(tx, 'escalated'))?.id);
    case 'close':
      return moveStatusTo(tx, deps, sim, (await deps.rules.statusByKey(tx, 'closed'))?.id);
    case 'set_priority':
      if (facts.priority === action.priority) {
        return UNCHANGED;
      }
      sim.facts = { ...facts, priority: action.priority };
      sim.changes.add('priority');
      return CHANGED;
    case 'set_field':
      if ((facts.custom[action.key] ?? null) === action.value) {
        return UNCHANGED;
      }
      sim.facts = { ...facts, custom: { ...facts.custom, [action.key]: action.value } };
      sim.changes.add('custom');
      return CHANGED;
    case 'assign_team': {
      const team = await deps.rules.team(tx, action.teamId);
      if (team === undefined) {
        return UNAVAILABLE;
      }
      if (facts.teamId === team.id) {
        return UNCHANGED;
      }
      sim.facts = { ...facts, teamId: team.id, departmentId: team.departmentId };
      sim.changes.add('team');
      return CHANGED;
    }
    case 'assign_agent': {
      const member = await deps.assignment.member(tx, brandId, action.userId);
      if (member === undefined || !canWorkDepartment(member, facts.departmentId)) {
        return UNAVAILABLE;
      }
      if (facts.assigneeId === action.userId) {
        return UNCHANGED;
      }
      sim.facts = { ...facts, assigneeId: action.userId };
      sim.changes.add('assignee');
      return CHANGED;
    }
    case 'assign_round_robin':
      return (await routesAutomatically(deps.assignment, tx, facts.departmentId))
        ? CHANGED
        : UNAVAILABLE;
    case 'add_tag':
    case 'remove_tag': {
      if (!(await deps.rules.tagExists(tx, action.tagId))) {
        return UNAVAILABLE;
      }
      const has = facts.tagIds.includes(action.tagId);
      if (has === (action.type === 'add_tag')) {
        return UNCHANGED;
      }
      sim.facts = {
        ...facts,
        tagIds: has
          ? facts.tagIds.filter((id) => id !== action.tagId)
          : [...facts.tagIds, action.tagId],
      };
      sim.changes.add('tags');
      if (!has) {
        sim.changes.add('tag_added');
      }
      return CHANGED;
    }
    case 'send_canned':
    case 'add_note':
      return CHANGED;
    case 'notify': {
      const recipients = await recipientsFor(tx, brandId, deps, facts, action.recipient);
      return recipients.length === 0
        ? UNAVAILABLE
        : { effect: 'changed', recipientIds: recipients };
    }
  }
};

const recipientsFor = async (
  tx: DbTransaction,
  brandId: string,
  deps: PreviewDeps,
  facts: TicketFacts,
  recipient: Extract<RuleAction, { type: 'notify' }>['recipient'],
): Promise<string[]> => {
  switch (recipient.kind) {
    case 'department_leads':
      return deps.rules.departmentLeadIds(tx, brandId, facts.departmentId);
    case 'assignee':
      return facts.assigneeId === null ? [] : [facts.assigneeId];
    case 'team':
      return deps.rules.teamMemberIds(tx, recipient.teamId);
    case 'user':
      return (await deps.rules.isActiveMember(tx, brandId, recipient.userId))
        ? [recipient.userId]
        : [];
  }
};

/** What the draft's actions would do, in order, and the ticket they would leave. */
export const previewActions = async (
  tx: DbTransaction,
  brandId: string,
  deps: PreviewDeps,
  facts: TicketFacts,
  actions: readonly RuleAction[],
): Promise<{ outcomes: ActionOutcome[]; simulation: Simulation }> => {
  const simulation: Simulation = { facts, changes: new Set(), closedOrReopened: false };
  const outcomes: ActionOutcome[] = [];

  for (const action of actions) {
    outcomes.push({ action, ...(await previewOne(tx, brandId, deps, simulation, action)) });
  }

  return { outcomes, simulation };
};

/** Stands in for a draft that has no id yet; no saved rule can have it. */
const UNSAVED_DRAFT_ID = '00000000-0000-0000-0000-000000000000';

const storedRuleSchema = z.object({
  conditions: ruleConditionsSchema,
  actions: z.array(ruleActionSchema),
});

/**
 * The rules the draft's changes would start, one level on, each with whether
 * it would run against the ticket as the draft would leave it. The draft
 * itself, if saved as `draftRuleId`, is judged by the depth guard like any
 * other: starting itself again is a cycle.
 */
export const followOnsOf = async (
  tx: DbTransaction,
  deps: PreviewDeps,
  simulation: Simulation,
  draftRuleId: string | undefined,
  context: EvaluationContext,
): Promise<RuleTestFollowOn[]> => {
  if (simulation.changes.size === 0) {
    return [];
  }

  const event = simulation.closedOrReopened
    ? RULE_SOURCE_EVENTS.closed
    : RULE_SOURCE_EVENTS.updated;
  const triggers = triggersFor(event, { changes: [...simulation.changes] });
  // An unsaved draft still stands at depth 1 of the chain it would start.
  const chain = [draftRuleId ?? UNSAVED_DRAFT_ID];
  const rules = await deps.rules.eventRules(tx, triggers);

  return rules.flatMap((rule): RuleTestFollowOn[] => {
    const parsed = storedRuleSchema.safeParse(rule);
    if (!parsed.success) {
      return [];
    }
    const outcome = evaluateConditions(parsed.data.conditions, simulation.facts, context);
    const guard = guardRun(rule.id, chain);

    return [
      {
        trigger: rule.trigger as RuleTrigger,
        ruleId: rule.id,
        ruleName: rule.name,
        depth: guard.depth,
        outcome: followOnOutcome(outcome.matched, guard.kind),
        failedGroup: firstFailedGroup(outcome),
      },
    ];
  });
};

const followOnOutcome = (matched: boolean, guard: 'run' | 'stop'): RuleTestFollowOn['outcome'] => {
  if (!matched) {
    return 'would_skip';
  }
  return guard === 'stop' ? 'would_stop' : 'would_run';
};

/** `HD-1042`, `hd-1042` or `1042` → 1042; anything else is no ticket. */
export const ticketNumberOf = (reference: string): number | undefined => {
  const match = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d{1,15})$/.exec(reference.trim());
  if (match?.[1] === undefined) {
    return undefined;
  }
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};
