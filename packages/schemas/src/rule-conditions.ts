import type { TicketChannel, TicketPriority } from './ticket.js';
import {
  type ConditionTrace,
  type GroupTrace,
  RULE_FIELD_VALUE_KIND,
  type RuleCondition,
  type RuleConditionGroup,
  type RuleConditions,
  type RuleMatch,
  ruleDurationMinutes,
} from './workflow-rules.js';

/**
 * REQUIREMENTS §4.3's "IF <conditions>", answered (M3-03). Pure: the facts and
 * the clock are passed in, so every operator is testable without a database,
 * and the test run evaluates a draft exactly as the engine would. It lives
 * here rather than in `apps/api` because the admin's mock api evaluates its
 * fixture rules with the same code the engine runs.
 *
 * Two levels, as the builder draws them: the rule matches **all** or **any**
 * of its groups, and each group **all** or **any** of its conditions. Every
 * condition is still evaluated, because the test run shows each one; a
 * condition whose group was already decided by another is reported
 * `not_needed` rather than `failed`, which is the difference between "this
 * rule would not run" and "one match is enough".
 */

/** What a condition may ask about a ticket. The api reads it; a fixture writes it. */
export interface RuleTicketFacts {
  readonly subject: string;
  /** The newest public message from the contact, as text. */
  readonly body: string;
  readonly channel: TicketChannel;
  readonly departmentId: string;
  readonly teamId: string | null;
  readonly assigneeId: string | null;
  readonly priority: TicketPriority;
  readonly statusId: string;
  /** When the ticket entered the status it is in. */
  readonly statusChangedAt: Date;
  readonly tagIds: readonly string[];
  readonly contactEmails: readonly string[];
  readonly accountId: string | null;
  readonly custom: Readonly<Record<string, unknown>>;
}

export interface EvaluationContext {
  readonly now: Date;
  /**
   * Whether the ticket's department is open now (M3-01's calendar). The engine
   * asks `BusinessHoursProbe`; a condition on business hours reads the answer.
   */
  readonly withinBusinessHours: boolean;
  /**
   * Whether to report the text a text condition was checked against. The test
   * run does, for somebody who can read the ticket; the stored log does not,
   * because it outlives that reader's view of the ticket.
   */
  readonly includeText: boolean;
}

export interface ConditionsOutcome {
  readonly matched: boolean;
  readonly groups: readonly GroupTrace[];
}

/** Case- and form-insensitive, so "Refund" finds "refund" and Arabic presentation forms fold. */
const fold = (text: string): string => text.normalize('NFKC').toLocaleLowerCase().trim();

const TEXT_FIELDS = new Set(['subject', 'body', 'contact_email', 'custom_field']);

/** What the ticket holds for a field, as strings. */
const actualOf = (
  condition: RuleCondition,
  facts: RuleTicketFacts,
  context: EvaluationContext,
): string[] => {
  switch (condition.field) {
    case 'subject':
      return [facts.subject];
    case 'body':
      return [facts.body];
    case 'contact_email':
      return [...facts.contactEmails];
    case 'custom_field': {
      const value = facts.custom[condition.key ?? ''];
      return value === undefined || value === null || value === '' ? [] : [String(value)];
    }
    case 'channel':
      return [facts.channel];
    case 'priority':
      return [facts.priority];
    case 'department':
      return [facts.departmentId];
    case 'team':
      return facts.teamId === null ? [] : [facts.teamId];
    case 'assignee':
      return facts.assigneeId === null ? [] : [facts.assigneeId];
    case 'status':
      return [facts.statusId];
    case 'tag':
      return [...facts.tagIds];
    case 'account':
      return facts.accountId === null ? [] : [facts.accountId];
    case 'time_in_status':
      return [String(minutesInStatus(facts, context.now))];
    case 'business_hours':
      return [context.withinBusinessHours ? 'inside' : 'outside'];
  }
};

export const minutesInStatus = (facts: RuleTicketFacts, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - facts.statusChangedAt.getTime()) / 60_000));

const textMatches = (condition: RuleCondition, actual: readonly string[]): boolean => {
  const needle = fold(condition.values[0] ?? '');
  const haystacks = actual.map(fold);

  switch (condition.operator) {
    case 'contains':
      return haystacks.some((text) => text.includes(needle));
    case 'not_contains':
      return haystacks.every((text) => !text.includes(needle));
    case 'is':
      return haystacks.some((text) => text === needle);
    case 'is_not':
      return haystacks.every((text) => text !== needle);
    default:
      return false;
  }
};

const setMatches = (condition: RuleCondition, actual: readonly string[]): boolean => {
  const held = new Set(actual);

  switch (condition.operator) {
    // For a tag, "is" is "carries"; for a single-valued field it is equality,
    // which is the same test over a set of one.
    case 'is':
      return held.has(condition.values[0] ?? '');
    case 'is_not':
      return !held.has(condition.values[0] ?? '');
    case 'any_of':
      return condition.values.some((value) => held.has(value));
    default:
      return false;
  }
};

/** Whether one condition holds. Exported for the time-based scan's own narrowing. */
export const conditionHolds = (
  condition: RuleCondition,
  facts: RuleTicketFacts,
  context: EvaluationContext,
): boolean => {
  const actual = actualOf(condition, facts, context);

  if (condition.operator === 'is_set') {
    return actual.some((value) => value.trim() !== '');
  }

  switch (RULE_FIELD_VALUE_KIND[condition.field]) {
    case 'text':
      return textMatches(condition, actual);
    case 'duration': {
      const minutes = minutesInStatus(facts, context.now);
      const limit = condition.duration === undefined ? 0 : ruleDurationMinutes(condition.duration);
      return condition.operator === 'more_than' ? minutes > limit : minutes < limit;
    }
    default:
      return setMatches(condition, actual);
  }
};

/** Settles a list of outcomes by `all` or `any`, marking the ones that did not decide it. */
const settle = <T extends { outcome: 'matched' | 'failed' | 'not_needed' }>(
  match: RuleMatch,
  items: readonly T[],
): { matched: boolean; items: T[] } => {
  const matched =
    match === 'all'
      ? items.every((item) => item.outcome === 'matched')
      : items.some((item) => item.outcome === 'matched');

  // An `any` that matched did not need the ones that failed.
  const settled =
    match === 'any' && matched
      ? items.map((item) =>
          item.outcome === 'failed' ? { ...item, outcome: 'not_needed' as const } : item,
        )
      : [...items];

  return { matched, items: settled };
};

const traceCondition = (
  condition: RuleCondition,
  facts: RuleTicketFacts,
  context: EvaluationContext,
): ConditionTrace => {
  const actual = actualOf(condition, facts, context);

  return {
    condition,
    outcome: conditionHolds(condition, facts, context) ? 'matched' : 'failed',
    actual: TEXT_FIELDS.has(condition.field) && !context.includeText ? null : actual,
  };
};

const traceGroup = (
  group: RuleConditionGroup,
  facts: RuleTicketFacts,
  context: EvaluationContext,
): GroupTrace => {
  const { matched, items } = settle(
    group.match,
    group.conditions.map((condition) => traceCondition(condition, facts, context)),
  );

  return { match: group.match, outcome: matched ? 'matched' : 'failed', conditions: items };
};

export const evaluateConditions = (
  conditions: RuleConditions,
  facts: RuleTicketFacts,
  context: EvaluationContext,
): ConditionsOutcome => {
  if (conditions.groups.length === 0) {
    return { matched: true, groups: [] };
  }

  const { matched, items } = settle(
    conditions.match,
    conditions.groups.map((group) => traceGroup(group, facts, context)),
  );

  return { matched, groups: items };
};

/** The first group that did not match: what the log says a skip was about. */
export const firstFailedGroup = (outcome: ConditionsOutcome): GroupTrace | null =>
  outcome.groups.find((group) => group.outcome === 'failed') ?? null;
