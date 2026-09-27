import { describe, expect, it } from 'vitest';
import { type MatchablePolicy, matchPolicy } from './policy-match.js';

const BILLING = '01937f5e-7e53-7000-8000-0000000000d1';
const SALES = '01937f5e-7e53-7000-8000-0000000000d2';
const target = { firstResponseMinutes: 60, resolutionMinutes: 480 };

const policy = (
  id: string,
  position: number,
  conditions: MatchablePolicy['conditions'],
): MatchablePolicy => ({
  id,
  name: id,
  position,
  conditions,
  timeMode: 'business',
  targets: { low: target, medium: target, high: target, urgent: target },
  escalation: [],
});

// The artboard's three policies, deliberately out of order.
const policies = [
  policy('sales', 2, [
    { field: 'department', operator: 'any', values: [SALES] },
    { field: 'priority', operator: 'none', values: ['low'] },
  ]),
  policy('urgent-anywhere', 0, [{ field: 'priority', operator: 'any', values: ['urgent'] }]),
  policy('billing', 1, [{ field: 'department', operator: 'any', values: [BILLING] }]),
];

describe('matchPolicy', () => {
  it('takes the first match in position order', () => {
    expect(matchPolicy(policies, { departmentId: BILLING, priority: 'urgent' })?.id).toBe(
      'urgent-anywhere',
    );
    expect(matchPolicy(policies, { departmentId: BILLING, priority: 'low' })?.id).toBe('billing');
  });

  it('needs every condition, and honours "none of"', () => {
    expect(matchPolicy(policies, { departmentId: SALES, priority: 'medium' })?.id).toBe('sales');
    expect(matchPolicy(policies, { departmentId: SALES, priority: 'low' })).toBeNull();
  });

  it('matches everything when a policy has no conditions', () => {
    expect(matchPolicy([policy('all', 0, [])], { departmentId: SALES, priority: 'low' })?.id).toBe(
      'all',
    );
  });
});
