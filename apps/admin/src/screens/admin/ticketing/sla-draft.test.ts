import type { SlaPolicy } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  draftOfPolicy,
  issueCount,
  issuesOf,
  minutesOf,
  newPolicyDraft,
  requestOfDraft,
  sameDraft,
  uncovered,
} from './sla-draft.js';

const BILLING = '0192c3f0-1a2b-7c3d-8e4f-0000000000d2';
const SALES = '0192c3f0-1a2b-7c3d-8e4f-0000000000d3';
const target = (firstResponseMinutes: number, resolutionMinutes: number) => ({
  firstResponseMinutes,
  resolutionMinutes,
});

const policy: SlaPolicy = {
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000005a1',
  name: 'Billing',
  position: 0,
  conditions: [{ field: 'department', operator: 'any', values: [BILLING] }],
  timeMode: 'business',
  targets: {
    low: target(480, 2880),
    medium: target(240, 960),
    high: target(120, 480),
    urgent: target(45, 240),
  },
  escalation: [{ atPercent: 100, actions: [{ type: 'set_escalated' }] }],
  runningTickets: 3,
  updatedAt: '2026-09-21T10:00:00.000Z',
  updatedBy: null,
};

describe('targets', () => {
  it('shows whole hours as hours and the rest as minutes', () => {
    const draft = draftOfPolicy(policy);
    expect(draft.targets.high.firstResponse).toEqual({ value: '2', unit: 'hours' });
    expect(draft.targets.urgent.firstResponse).toEqual({ value: '45', unit: 'minutes' });
  });

  it('reads a field as minutes, or nothing for a target that is not above 0', () => {
    expect(minutesOf({ value: '1.5', unit: 'hours' })).toBe(90);
    expect(minutesOf({ value: '0', unit: 'hours' })).toBeNull();
    expect(minutesOf({ value: '', unit: 'minutes' })).toBeNull();
    expect(minutesOf({ value: 'soon', unit: 'minutes' })).toBeNull();
  });
});

describe('issues', () => {
  it('names the fields that stop a save', () => {
    const draft = draftOfPolicy(policy);
    const broken = {
      ...draft,
      name: ' ',
      targets: {
        ...draft.targets,
        low: { ...draft.targets.low, resolution: { value: '0', unit: 'hours' as const } },
      },
      escalation: [...draft.escalation, { atPercent: 100, actions: [] }],
    };

    const issues = issuesOf(broken);
    expect(issues).toEqual({ name: true, targets: ['low.resolution'], steps: [0, 1] });
    expect(issueCount(issues)).toBe(4);
    expect(requestOfDraft(broken)).toBeNull();
  });

  it('sends a clean draft as minutes, with its steps in order', () => {
    const draft = {
      ...draftOfPolicy(policy),
      escalation: [
        { atPercent: 150, actions: [{ type: 'raise_priority' as const }] },
        { atPercent: 75, actions: [{ type: 'set_escalated' as const }] },
      ],
    };

    expect(requestOfDraft(draft)).toMatchObject({
      name: 'Billing',
      targets: policy.targets,
      escalation: [{ atPercent: 75 }, { atPercent: 150 }],
    });
  });

  it('starts a new policy that saves once it has a name', () => {
    expect(requestOfDraft(newPolicyDraft(''))).toBeNull();
    expect(requestOfDraft(newPolicyDraft('Everything'))?.targets.low).toEqual(target(240, 1440));
    expect(sameDraft(newPolicyDraft('a'), newPolicyDraft('a'))).toBe(true);
  });
});

describe('uncovered', () => {
  it('lists the department and priority pairs no policy matches', () => {
    expect(
      uncovered([policy], [BILLING, SALES]).filter((gap) => gap.departmentId === BILLING),
    ).toEqual([]);
    expect(uncovered([policy], [SALES])).toHaveLength(4);
    expect(
      uncovered(
        [{ conditions: [{ field: 'priority', operator: 'none', values: ['low'] }] }],
        [SALES],
      ),
    ).toEqual([{ departmentId: SALES, priority: 'low' }]);
  });
});
