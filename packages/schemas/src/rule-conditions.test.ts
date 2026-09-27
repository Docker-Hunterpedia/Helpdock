import { describe, expect, it } from 'vitest';
import {
  conditionHolds,
  evaluateConditions,
  firstFailedGroup,
  type RuleTicketFacts,
} from './rule-conditions.js';
import { type RuleCondition, type RuleConditions, ruleConditionSchema } from './workflow-rules.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const SUPPORT = '01924f00-0000-7000-8000-000000000001';
const BILLING = '01924f00-0000-7000-8000-000000000002';
const VIP = '01924f00-0000-7000-8000-000000000003';
const REFUND = '01924f00-0000-7000-8000-000000000004';
const AWAITING = '01924f00-0000-7000-8000-000000000005';

const facts = (overrides: Partial<RuleTicketFacts> = {}): RuleTicketFacts => ({
  subject: 'Refund not received after 10 days',
  body: 'I asked for a refund of order 88412.',
  channel: 'email',
  departmentId: SUPPORT,
  teamId: null,
  assigneeId: null,
  priority: 'medium',
  statusId: AWAITING,
  statusChangedAt: new Date('2026-09-23T12:00:00Z'),
  tagIds: [REFUND],
  contactEmails: ['mona.k@example.com'],
  accountId: null,
  custom: { order_number: '88412' },
  ...overrides,
});

const context = { now: NOW, withinBusinessHours: true, includeText: false };

const condition = (input: Record<string, unknown>): RuleCondition =>
  ruleConditionSchema.parse(input);

const holds = (input: Record<string, unknown>, ticket: RuleTicketFacts = facts()): boolean =>
  conditionHolds(condition(input), ticket, context);

describe('conditionHolds', () => {
  it.each([
    [{ field: 'subject', operator: 'contains', values: ['REFUND'] }, true],
    [{ field: 'subject', operator: 'not_contains', values: ['invoice'] }, true],
    [{ field: 'subject', operator: 'is', values: ['refund not received after 10 days'] }, true],
    [{ field: 'subject', operator: 'is_not', values: ['Refund'] }, true],
    [{ field: 'body', operator: 'contains', values: ['88412'] }, true],
    [{ field: 'contact_email', operator: 'contains', values: ['@example.com'] }, true],
    [{ field: 'custom_field', key: 'order_number', operator: 'is_set' }, true],
    [{ field: 'custom_field', key: 'missing', operator: 'is_set' }, false],
  ])('answers text conditions case-insensitively: %j', (input, expected) => {
    expect(holds(input)).toBe(expected);
  });

  it('folds compatibility forms, so an Arabic word typed either way matches', () => {
    expect(
      holds(
        { field: 'subject', operator: 'contains', values: ['استرداد'] },
        facts({ subject: 'طلب استرداد المبلغ' }),
      ),
    ).toBe(true);
  });

  it.each([
    [{ field: 'channel', operator: 'is', values: ['email'] }, true],
    [{ field: 'channel', operator: 'any_of', values: ['chat', 'form'] }, false],
    [{ field: 'priority', operator: 'is_not', values: ['urgent'] }, true],
    [{ field: 'department', operator: 'any_of', values: [BILLING, SUPPORT] }, true],
    [{ field: 'team', operator: 'is_set' }, false],
    [{ field: 'assignee', operator: 'is_not', values: [BILLING] }, true],
    [{ field: 'tag', operator: 'is', values: [REFUND] }, true],
    [{ field: 'tag', operator: 'is_not', values: [REFUND] }, false],
    [{ field: 'tag', operator: 'any_of', values: [VIP] }, false],
    [{ field: 'status', operator: 'is', values: [AWAITING] }, true],
    [{ field: 'account', operator: 'is_set' }, false],
  ])('answers id and enum conditions over the set the ticket holds: %j', (input, expected) => {
    expect(holds(input)).toBe(expected);
  });

  it('measures time in status from when the ticket entered it', () => {
    const moreThan = (amount: number, unit: 'hours' | 'days') =>
      holds({ field: 'time_in_status', operator: 'more_than', duration: { amount, unit } });
    expect(moreThan(3, 'days')).toBe(true);
    expect(moreThan(4, 'days')).toBe(false);
    expect(moreThan(95, 'hours')).toBe(true);
    expect(
      holds({
        field: 'time_in_status',
        operator: 'less_than',
        duration: { amount: 5, unit: 'days' },
      }),
    ).toBe(true);
  });

  it('reads business hours from the answer it is given', () => {
    const inside = condition({ field: 'business_hours', operator: 'is', values: ['inside'] });
    expect(conditionHolds(inside, facts(), context)).toBe(true);
    expect(conditionHolds(inside, facts(), { ...context, withinBusinessHours: false })).toBe(false);
  });
});

describe('evaluateConditions', () => {
  const refundOrInvoice = {
    match: 'any' as const,
    conditions: [
      { field: 'subject', operator: 'contains', values: ['refund'] },
      { field: 'subject', operator: 'contains', values: ['invoice'] },
    ],
  };
  const emailAndVip = {
    match: 'all' as const,
    conditions: [
      { field: 'channel', operator: 'is', values: ['email'] },
      { field: 'tag', operator: 'is', values: [VIP] },
    ],
  };
  const rule = (match: 'all' | 'any', groups: unknown[]): RuleConditions =>
    ({
      match,
      groups: groups.map((group) => ({
        ...(group as object),
        conditions: (group as { conditions: unknown[] }).conditions.map((entry) =>
          ruleConditionSchema.parse(entry),
        ),
      })),
    }) as RuleConditions;

  it('matches every ticket when there are no groups', () => {
    expect(evaluateConditions({ match: 'all', groups: [] }, facts(), context)).toEqual({
      matched: true,
      groups: [],
    });
  });

  it('marks a failed condition of an any-group that matched as not needed', () => {
    const outcome = evaluateConditions(rule('all', [refundOrInvoice]), facts(), context);

    expect(outcome.matched).toBe(true);
    expect(outcome.groups[0]?.conditions.map((trace) => trace.outcome)).toEqual([
      'matched',
      'not_needed',
    ]);
  });

  it('fails an all-rule on its first failing group, and says which', () => {
    const outcome = evaluateConditions(
      rule('all', [refundOrInvoice, emailAndVip]),
      facts(),
      context,
    );

    expect(outcome.matched).toBe(false);
    const failed = firstFailedGroup(outcome);
    expect(failed?.match).toBe('all');
    expect(failed?.conditions.map((trace) => trace.outcome)).toEqual(['matched', 'failed']);
    expect(failed?.conditions[1]?.actual).toEqual([REFUND]);
  });

  it('matches an any-rule on one group, marking the other not needed', () => {
    const outcome = evaluateConditions(
      rule('any', [emailAndVip, refundOrInvoice]),
      facts(),
      context,
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.groups.map((group) => group.outcome)).toEqual(['not_needed', 'matched']);
    expect(firstFailedGroup(outcome)).toBeNull();
  });

  it('leaves text out of the trace unless asked to include it', () => {
    const groups = rule('all', [refundOrInvoice]);

    expect(
      evaluateConditions(groups, facts(), context).groups[0]?.conditions[0]?.actual,
    ).toBeNull();
    expect(
      evaluateConditions(groups, facts(), { ...context, includeText: true }).groups[0]
        ?.conditions[0]?.actual,
    ).toEqual(['Refund not received after 10 days']);
  });
});
