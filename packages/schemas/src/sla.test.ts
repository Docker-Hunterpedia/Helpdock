import { describe, expect, it } from 'vitest';
import {
  SLA_PRIORITIES,
  slaPolicyCreateRequestSchema,
  slaSettingsUpdateRequestSchema,
  ticketEscalatedEventSchema,
} from './sla.js';
import { ticketPrioritySchema } from './ticket.js';

const target = { firstResponseMinutes: 120, resolutionMinutes: 480 };
const policy = {
  name: 'Billing and Returns',
  conditions: [
    {
      field: 'department',
      operator: 'any',
      values: ['01937f5e-7e53-7000-8000-00000000000a'],
    },
  ],
  timeMode: 'business',
  targets: { low: target, medium: target, high: target, urgent: target },
  escalation: [
    { atPercent: 75, actions: [{ type: 'notify', recipient: { kind: 'department_leads' } }] },
    { atPercent: 100, actions: [{ type: 'set_escalated' }] },
  ],
};

describe('slaPolicyCreateRequestSchema', () => {
  it('accepts the policy the artboard draws', () => {
    expect(slaPolicyCreateRequestSchema.safeParse(policy).success).toBe(true);
  });

  it('refuses a target of zero', () => {
    const zero = {
      ...policy,
      targets: { ...policy.targets, low: { ...target, resolutionMinutes: 0 } },
    };

    expect(slaPolicyCreateRequestSchema.safeParse(zero).success).toBe(false);
  });

  it('refuses two steps at the same percent', () => {
    const twice = {
      ...policy,
      escalation: [policy.escalation[0], { ...policy.escalation[1], atPercent: 75 }],
    };

    expect(slaPolicyCreateRequestSchema.safeParse(twice).success).toBe(false);
  });

  it('refuses two conditions on one field', () => {
    const twice = { ...policy, conditions: [policy.conditions[0], policy.conditions[0]] };

    expect(slaPolicyCreateRequestSchema.safeParse(twice).success).toBe(false);
  });

  it('refuses a step with no action and an unknown priority', () => {
    expect(
      slaPolicyCreateRequestSchema.safeParse({
        ...policy,
        escalation: [{ atPercent: 50, actions: [] }],
      }).success,
    ).toBe(false);
    expect(
      slaPolicyCreateRequestSchema.safeParse({
        ...policy,
        conditions: [{ field: 'priority', operator: 'any', values: ['critical'] }],
      }).success,
    ).toBe(false);
  });
});

describe('slaSettingsUpdateRequestSchema', () => {
  it('refuses a body that changes nothing', () => {
    expect(slaSettingsUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(slaSettingsUpdateRequestSchema.safeParse({ slaCountReopens: true }).success).toBe(true);
  });
});

describe('the SLA priorities', () => {
  it('are the ticket priorities', () => {
    expect([...SLA_PRIORITIES]).toEqual(ticketPrioritySchema.options);
  });
});

describe('ticketEscalatedEventSchema', () => {
  it('carries the contract payload, with recipients optional', () => {
    expect(
      ticketEscalatedEventSchema.safeParse({
        ticketId: '01937f5e-7e53-7000-8000-00000000000a',
        departmentId: '01937f5e-7e53-7000-8000-00000000000b',
        clock: 'resolution',
        stepPercent: 150,
      }).success,
    ).toBe(true);
  });
});
