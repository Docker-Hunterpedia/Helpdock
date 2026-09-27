import type { WorkflowRuleList } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { MOCK_AUTOMATION, MockAutomationApi } from '../../../automation/mock-api.js';
import {
  actionDraft,
  draftOf,
  emptyDraft,
  moveItem,
  newAction,
  newCondition,
  requestOf,
  withField,
  withOperator,
} from './rule-draft.js';
import { latestLoop } from './rules-tab.tsx';
import { timeOfDay } from './time.js';

const savedRules = async (): Promise<WorkflowRuleList['rules']> =>
  (await new MockAutomationApi().rules('brand')).rules;

describe('the rule draft', () => {
  it('round-trips a saved rule to the request it was saved from', async () => {
    const [refunds] = await savedRules();
    if (refunds === undefined) {
      throw new Error('the fixture has no rules');
    }

    expect(requestOf(draftOf(refunds))).toEqual({
      name: refunds.name,
      description: refunds.description,
      kind: 'event',
      trigger: 'ticket_created',
      conditions: refunds.conditions,
      actions: refunds.actions,
      enabled: true,
    });
  });

  it('has no request while a condition or an action is incomplete', () => {
    const draft = { ...emptyDraft('event'), name: 'Anything' };
    expect(requestOf(draft)).toBeNull();

    const complete = {
      ...draft,
      groups: [
        {
          key: 'g',
          match: 'all' as const,
          conditions: [{ ...newCondition('subject'), values: ['refund'] }],
        },
      ],
      actions: [actionDraft({ type: 'assign_team', teamId: MOCK_AUTOMATION.teams.billing })],
    };
    expect(requestOf(complete)).not.toBeNull();
    expect(requestOf({ ...complete, name: '  ' })).toBeNull();
  });

  it('sends a scheduled rule its interval and no event, and time in status as a duration', () => {
    const draft = {
      ...emptyDraft('scheduled'),
      name: 'Close stale',
      groups: [
        {
          key: 'g',
          match: 'all' as const,
          conditions: [{ ...newCondition('time_in_status'), amount: '4' }],
        },
      ],
      actions: [actionDraft(newAction('close'))],
    };

    expect(requestOf(draft)).toMatchObject({
      kind: 'scheduled',
      intervalMinutes: 15,
      conditions: {
        groups: [
          {
            conditions: [
              {
                field: 'time_in_status',
                operator: 'more_than',
                values: [],
                duration: { amount: 4, unit: 'days' },
              },
            ],
          },
        ],
      },
    });
    expect(requestOf(draft)).not.toHaveProperty('trigger');
  });

  it('resets a condition to its new field’s first operator, and trims a list to one value', () => {
    const channel = { ...withField(newCondition(), 'channel'), values: ['email', 'chat'] };
    expect(channel).toMatchObject({ field: 'channel', operator: 'is', values: ['email', 'chat'] });
    expect(withOperator(channel, 'is').values).toEqual(['email']);
    expect(withOperator(channel, 'any_of').values).toEqual(['email', 'chat']);
    expect(withField(channel, 'custom_field', 'order_number')).toMatchObject({
      field: 'custom_field',
      customKey: 'order_number',
      values: [],
    });
  });

  it('moves an action within the list, clamped to its ends', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    const same = ['a', 'b'];
    expect(moveItem(same, 0, -1)).toBe(same);
  });
});

describe('latestLoop', () => {
  it('names the rules of the newest loop in the last day, and the rule it stopped', async () => {
    const api = new MockAutomationApi(Date.parse('2026-09-27T14:05:00Z'));
    const rules = await savedRules();
    const { runs } = await api.runs('brand', {});

    expect(latestLoop(runs, rules, Date.parse('2026-09-27T14:05:00Z'))).toEqual({
      ruleId: rules[2]?.id,
      names: ['Invoices to Returns', 'Returns back to Billing'],
      ticket: 'HD-1041',
    });
    expect(latestLoop(runs, rules, Date.parse('2026-09-29T14:05:00Z'))).toBeNull();
    expect(latestLoop(runs, [], Date.parse('2026-09-27T14:05:00Z'))).toBeNull();
  });
});

describe('timeOfDay', () => {
  const now = Date.parse('2026-09-27T14:05:00');

  it('prints a time today, and a date and time before that, in Latin digits', () => {
    expect(timeOfDay(new Date('2026-09-27T09:07:00').toISOString(), 'en', now)).toBe('09:07');
    expect(timeOfDay(new Date('2026-09-20T09:07:00').toISOString(), 'en', now)).toMatch(/20/);
    expect(timeOfDay(new Date('2026-09-27T09:07:00').toISOString(), 'ar', now)).toBe('09:07');
  });
});
