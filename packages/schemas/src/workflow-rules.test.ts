import { describe, expect, it } from 'vitest';
import {
  RULE_OPERATORS_BY_FIELD,
  ruleActionSchema,
  ruleConditionFieldSchema,
  ruleConditionSchema,
  ruleConditionsSchema,
  ruleDraftSchema,
  ruleDurationMinutes,
  ruleNotifyPayloadSchema,
  ruleReorderRequestSchema,
  ruleTestRunRequestSchema,
} from './workflow-rules.js';

const ID = '01924f00-0000-7000-8000-000000000001';

const eventDraft = {
  name: 'Refunds to Billing',
  kind: 'event',
  trigger: 'ticket_created',
  conditions: { match: 'all', groups: [] },
  actions: [{ type: 'assign_team', teamId: ID }],
};

describe('ruleConditionSchema', () => {
  it('accepts every operator the builder offers for each field', () => {
    for (const field of ruleConditionFieldSchema.options) {
      expect(RULE_OPERATORS_BY_FIELD[field].length).toBeGreaterThan(0);
    }
  });

  it.each([
    { field: 'subject', operator: 'contains', values: ['refund'] },
    { field: 'channel', operator: 'any_of', values: ['email', 'chat'] },
    { field: 'tag', operator: 'is_set' },
    { field: 'status', operator: 'is', values: [ID] },
    { field: 'custom_field', key: 'order_number', operator: 'is_set' },
    { field: 'time_in_status', operator: 'more_than', duration: { amount: 3, unit: 'days' } },
    { field: 'business_hours', operator: 'is', values: ['outside'] },
  ])('accepts %j', (condition) => {
    expect(ruleConditionSchema.safeParse(condition).success).toBe(true);
  });

  it.each([
    ['an operator the field does not take', { field: 'body', operator: 'is', values: ['x'] }],
    ['a missing value', { field: 'subject', operator: 'contains', values: [] }],
    [
      'two values where one is asked',
      { field: 'priority', operator: 'is', values: ['low', 'high'] },
    ],
    ['a value with is_set', { field: 'tag', operator: 'is_set', values: [ID] }],
    ['a channel that does not exist', { field: 'channel', operator: 'is', values: ['fax'] }],
    ['an id that is not one', { field: 'team', operator: 'is', values: ['billing'] }],
    ['a blank text', { field: 'subject', operator: 'contains', values: ['  '] }],
    ['a custom field without its key', { field: 'custom_field', operator: 'is_set' }],
    ['a key on another field', { field: 'subject', key: 'x', operator: 'is_set' }],
    ['time in status without a duration', { field: 'time_in_status', operator: 'more_than' }],
    [
      'business hours that are neither',
      { field: 'business_hours', operator: 'is', values: ['sometimes'] },
    ],
  ])('refuses %s', (_label, condition) => {
    expect(ruleConditionSchema.safeParse(condition).success).toBe(false);
  });

  it('counts a duration in minutes', () => {
    expect(ruleDurationMinutes({ amount: 3, unit: 'days' })).toBe(4_320);
    expect(ruleDurationMinutes({ amount: 72, unit: 'hours' })).toBe(4_320);
  });
});

describe('ruleConditionsSchema', () => {
  it('refuses an empty group, which would read as "every ticket" by accident', () => {
    expect(
      ruleConditionsSchema.safeParse({ match: 'all', groups: [{ match: 'all', conditions: [] }] })
        .success,
    ).toBe(false);
  });
});

describe('ruleActionSchema', () => {
  it('leaves a canned reply out of the first-response clock unless it says otherwise', () => {
    expect(ruleActionSchema.parse({ type: 'send_canned', cannedResponseId: ID })).toEqual({
      type: 'send_canned',
      cannedResponseId: ID,
      countsAsResponse: false,
    });
  });

  it('refuses an action that does not exist, which is how v1 keeps webhooks and AI out', () => {
    expect(ruleActionSchema.safeParse({ type: 'call_webhook', url: 'https://x' }).success).toBe(
      false,
    );
  });
});

describe('ruleDraftSchema', () => {
  it('accepts an event rule and a scheduled rule', () => {
    expect(ruleDraftSchema.safeParse(eventDraft).success).toBe(true);
    expect(
      ruleDraftSchema.safeParse({
        ...eventDraft,
        kind: 'scheduled',
        trigger: undefined,
        intervalMinutes: 15,
      }).success,
    ).toBe(true);
  });

  it('refuses an event rule with no event, and a scheduled rule with one', () => {
    expect(ruleDraftSchema.safeParse({ ...eventDraft, trigger: undefined }).success).toBe(false);
    expect(
      ruleDraftSchema.safeParse({ ...eventDraft, kind: 'scheduled', intervalMinutes: 15 }).success,
    ).toBe(false);
    expect(
      ruleDraftSchema.safeParse({
        ...eventDraft,
        kind: 'scheduled',
        trigger: undefined,
        intervalMinutes: 7,
      }).success,
    ).toBe(false);
  });

  it('refuses a rule that does nothing', () => {
    expect(ruleDraftSchema.safeParse({ ...eventDraft, actions: [] }).success).toBe(false);
  });
});

describe('the other requests', () => {
  it('reorders a non-empty list of one kind', () => {
    expect(ruleReorderRequestSchema.safeParse({ kind: 'event', ruleIds: [ID] }).success).toBe(true);
    expect(ruleReorderRequestSchema.safeParse({ kind: 'event', ruleIds: [] }).success).toBe(false);
  });

  it('test-runs a draft against a ticket reference', () => {
    expect(
      ruleTestRunRequestSchema.safeParse({ rule: eventDraft, ticket: 'HD-1042' }).success,
    ).toBe(true);
    expect(ruleTestRunRequestSchema.safeParse({ rule: eventDraft, ticket: '' }).success).toBe(
      false,
    );
  });

  it('describes the notify event M3-07 consumes', () => {
    expect(
      ruleNotifyPayloadSchema.safeParse({
        ticketId: ID,
        recipients: [ID],
        message: null,
        ruleId: ID,
      }).success,
    ).toBe(true);
  });
});
