import { type RuleConditions, ruleConditionsSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { narrowingOf } from './engine.js';
import { ticketNumberOf } from './test-run.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const AWAITING = '01924f00-0000-7000-8000-000000000005';
const ON_HOLD = '01924f00-0000-7000-8000-000000000006';

const conditions = (input: unknown): RuleConditions => ruleConditionsSchema.parse(input);

const awaitingFor = (days: number) => ({
  match: 'all',
  conditions: [
    { field: 'status', operator: 'is', values: [AWAITING] },
    { field: 'time_in_status', operator: 'more_than', duration: { amount: days, unit: 'days' } },
  ],
});

describe('narrowingOf', () => {
  it('asks SQL for the status and the longest wait a required group names', () => {
    expect(narrowingOf(conditions({ match: 'all', groups: [awaitingFor(3)] }), NOW)).toEqual({
      statusIds: [AWAITING],
      changedBefore: new Date('2026-09-24T12:00:00Z'),
    });
  });

  it('intersects two status conditions, and keeps the earlier cut-off', () => {
    const narrowed = narrowingOf(
      conditions({
        match: 'all',
        groups: [
          awaitingFor(3),
          {
            match: 'all',
            conditions: [
              { field: 'status', operator: 'any_of', values: [AWAITING, ON_HOLD] },
              {
                field: 'time_in_status',
                operator: 'more_than',
                duration: { amount: 5, unit: 'days' },
              },
            ],
          },
        ],
      }),
      NOW,
    );

    expect(narrowed).toEqual({
      statusIds: [AWAITING],
      changedBefore: new Date('2026-09-22T12:00:00Z'),
    });
  });

  it('narrows nothing that only one of several alternatives requires', () => {
    expect(
      narrowingOf(
        conditions({
          match: 'any',
          groups: [
            awaitingFor(3),
            { match: 'all', conditions: [{ field: 'priority', operator: 'is', values: ['low'] }] },
          ],
        }),
        NOW,
      ),
    ).toEqual({});
    expect(
      narrowingOf(
        conditions({
          match: 'all',
          groups: [{ ...awaitingFor(3), match: 'any' }],
        }),
        NOW,
      ),
    ).toEqual({});
  });
});

describe('ticketNumberOf', () => {
  it.each([
    ['HD-1042', 1042],
    ['hd-1042', 1042],
    [' 1042 ', 1042],
    ['ACME2-7', 7],
  ])('reads %s as ticket %i', (reference, number) => {
    expect(ticketNumberOf(reference)).toBe(number);
  });

  it.each(['', 'HD-', 'HD-0', 'HD 1042', '1042-HD', 'HD-1e3'])(
    'finds no ticket in %j',
    (reference) => {
      expect(ticketNumberOf(reference)).toBeUndefined();
    },
  );
});
