import type {
  SlaCondition,
  SlaEscalationStep,
  SlaPolicy,
  SlaPolicyCreateRequest,
  SlaTimeMode,
  TicketPriority,
} from '@helpdock/schemas';
import { SLA_PRIORITIES, SLA_TARGET_MINUTES_MAX } from '@helpdock/schemas';

/**
 * The SLAs tab's policy editor state (M3-02, `Admin/Ticketing-SLAs`) and the
 * decisions about it, apart from the components so they can be tested alone.
 *
 * Targets are typed as a number and a unit, as the artboard draws them, and
 * sent as minutes. A field holds what was typed — possibly nothing, possibly
 * "0" — so the editor can say "Enter a target above 0" under the one that is
 * wrong instead of refusing the keystroke.
 */

export type TargetUnit = 'minutes' | 'hours';

export interface TargetField {
  readonly value: string;
  readonly unit: TargetUnit;
}

export interface PolicyDraft {
  readonly name: string;
  readonly conditions: readonly SlaCondition[];
  readonly timeMode: SlaTimeMode;
  readonly targets: Readonly<
    Record<
      TicketPriority,
      { readonly firstResponse: TargetField; readonly resolution: TargetField }
    >
  >;
  readonly escalation: readonly SlaEscalationStep[];
}

const fieldOf = (minutes: number): TargetField =>
  minutes % 60 === 0
    ? { value: String(minutes / 60), unit: 'hours' }
    : { value: String(minutes), unit: 'minutes' };

export const draftOfPolicy = (policy: SlaPolicy): PolicyDraft => ({
  name: policy.name,
  conditions: policy.conditions,
  timeMode: policy.timeMode,
  targets: Object.fromEntries(
    SLA_PRIORITIES.map((priority) => [
      priority,
      {
        firstResponse: fieldOf(policy.targets[priority].firstResponseMinutes),
        resolution: fieldOf(policy.targets[priority].resolutionMinutes),
      },
    ]),
  ) as PolicyDraft['targets'],
  escalation: policy.escalation,
});

/** A new policy: every priority 4 h to respond and 1 day to resolve, a breach step. */
export const newPolicyDraft = (name: string): PolicyDraft => ({
  name,
  conditions: [],
  timeMode: 'business',
  targets: Object.fromEntries(
    SLA_PRIORITIES.map((priority) => [
      priority,
      { firstResponse: fieldOf(240), resolution: fieldOf(1440) },
    ]),
  ) as PolicyDraft['targets'],
  escalation: [{ atPercent: 100, actions: [{ type: 'set_escalated' }] }],
});

/** Minutes, or `null` when the field cannot be sent. */
export const minutesOf = (field: TargetField): number | null => {
  const value = Number(field.value.trim());
  if (field.value.trim() === '' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const minutes = Math.round(field.unit === 'hours' ? value * 60 : value);
  return minutes >= 1 && minutes <= SLA_TARGET_MINUTES_MAX ? minutes : null;
};

/** The fields that stop a save: the name, and every target that is not above 0. */
export interface DraftIssues {
  readonly name: boolean;
  readonly targets: readonly `${TicketPriority}.${'firstResponse' | 'resolution'}`[];
  readonly steps: readonly number[];
}

export const issuesOf = (draft: PolicyDraft): DraftIssues => ({
  name: draft.name.trim() === '',
  targets: SLA_PRIORITIES.flatMap((priority) =>
    (['firstResponse', 'resolution'] as const).flatMap((clock) =>
      minutesOf(draft.targets[priority][clock]) === null ? [`${priority}.${clock}` as const] : [],
    ),
  ),
  // A step with no action, or a percent shared with another step.
  steps: draft.escalation.flatMap((step, index) =>
    step.actions.length === 0 ||
    step.atPercent < 1 ||
    draft.escalation.some((other, at) => at !== index && other.atPercent === step.atPercent)
      ? [index]
      : [],
  ),
});

export const issueCount = (issues: DraftIssues): number =>
  Number(issues.name) + issues.targets.length + issues.steps.length;

export const requestOfDraft = (draft: PolicyDraft): SlaPolicyCreateRequest | null => {
  if (issueCount(issuesOf(draft)) > 0) {
    return null;
  }
  return {
    name: draft.name.trim(),
    conditions: [...draft.conditions],
    timeMode: draft.timeMode,
    targets: Object.fromEntries(
      SLA_PRIORITIES.map((priority) => [
        priority,
        {
          firstResponseMinutes: minutesOf(draft.targets[priority].firstResponse) ?? 1,
          resolutionMinutes: minutesOf(draft.targets[priority].resolution) ?? 1,
        },
      ]),
    ) as SlaPolicyCreateRequest['targets'],
    escalation: [...draft.escalation].sort((a, b) => a.atPercent - b.atPercent),
  };
};

export const sameDraft = (a: PolicyDraft, b: PolicyDraft): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The combinations of department and priority no policy covers, for "A ticket
 * no policy matches has no SLA clocks. Here: Sales tickets at Low priority."
 */
export const uncovered = (
  policies: readonly Pick<SlaPolicy, 'conditions'>[],
  departmentIds: readonly string[],
): { readonly departmentId: string; readonly priority: TicketPriority }[] => {
  const holds = (condition: SlaCondition, departmentId: string, priority: TicketPriority) => {
    const value = condition.field === 'department' ? departmentId : priority;
    const listed = (condition.values as readonly string[]).includes(value);
    return condition.operator === 'any' ? listed : !listed;
  };

  return departmentIds.flatMap((departmentId) =>
    SLA_PRIORITIES.filter(
      (priority) =>
        !policies.some((policy) =>
          policy.conditions.every((condition) => holds(condition, departmentId, priority)),
        ),
    ).map((priority) => ({ departmentId, priority })),
  );
};
