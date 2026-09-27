import type {
  SlaCondition,
  SlaEscalationStep,
  SlaTargets,
  SlaTimeMode,
  TicketPriority,
} from '@helpdock/schemas';

/**
 * Which policy a ticket runs under (M3-02). Policies are checked top to bottom
 * and the first whose conditions all match applies; a ticket no policy matches
 * has no clocks (artboard `Admin/Ticketing-SLAs`).
 */

export interface MatchablePolicy {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly conditions: readonly SlaCondition[];
  readonly timeMode: SlaTimeMode;
  readonly targets: SlaTargets;
  readonly escalation: readonly SlaEscalationStep[];
}

export interface PolicySubject {
  readonly departmentId: string;
  readonly priority: TicketPriority;
}

const conditionHolds = (condition: SlaCondition, subject: PolicySubject): boolean => {
  const value = condition.field === 'department' ? subject.departmentId : subject.priority;
  const listed = (condition.values as readonly string[]).includes(value);

  return condition.operator === 'any' ? listed : !listed;
};

export const policyMatches = (policy: MatchablePolicy, subject: PolicySubject): boolean =>
  policy.conditions.every((condition) => conditionHolds(condition, subject));

/** The first matching policy in `position` order, or null. */
export const matchPolicy = <P extends MatchablePolicy>(
  policies: readonly P[],
  subject: PolicySubject,
): P | null =>
  [...policies]
    .sort((a, b) => a.position - b.position)
    .find((policy) => policyMatches(policy, subject)) ?? null;
