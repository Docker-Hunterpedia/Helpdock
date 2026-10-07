import {
  AiNotConfiguredError,
  AiProviderError,
  BudgetExceededError,
  UnreadableAnswerError,
} from '@helpdock/ai';
import { describe, expect, it } from 'vitest';
import type { AssistMessage } from './assist.repository.js';
import { AssistFailure, assistFailureOf } from './assist-failure.js';
import { resetsAt } from './assist-state.service.js';
import { retrievalQuery, threadLines } from './thread-lines.js';

const message = (overrides: Partial<AssistMessage>): AssistMessage => ({
  id: 'm',
  kind: 'public',
  authorType: 'contact',
  bodyText: 'Where is my refund?',
  ...overrides,
});

describe('threadLines', () => {
  const messages = [
    message({}),
    message({ kind: 'note', authorType: 'staff', bodyText: 'Finance is checking.' }),
    message({ kind: 'ai', authorType: 'ai', bodyText: 'Five days.' }),
    message({ authorType: 'staff', bodyText: 'On its way.' }),
    message({ bodyText: '   ' }),
  ];

  it('labels who wrote each message and drops empty ones', () => {
    expect(threadLines(messages, { publicOnly: false }).map((line) => line.role)).toEqual([
      'customer',
      'note',
      'assistant',
      'agent',
    ]);
  });

  it('leaves internal notes out of anything a customer may read', () => {
    expect(threadLines(messages, { publicOnly: true }).map((line) => line.role)).not.toContain(
      'note',
    );
  });

  it('asks retrieval with the subject and what the customer said last', () => {
    expect(retrievalQuery('Refund', threadLines(messages, { publicOnly: false }))).toBe(
      'Refund\nWhere is my refund?',
    );
  });
});

describe('resetsAt', () => {
  it('names the next UTC day or month', () => {
    expect(resetsAt({ period: 'day', periodStart: '2026-10-31' })).toBe('2026-11-01T00:00:00.000Z');
    expect(resetsAt({ period: 'month', periodStart: '2026-12-01' })).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});

describe('assistFailureOf', () => {
  it('turns what the facade throws into the refusal the admin explains', () => {
    const reasonOf = (error: unknown) => (assistFailureOf(error) as AssistFailure).reason;
    expect(
      reasonOf(new BudgetExceededError('b', { period: 'day', spentUsd: 1, limitUsd: 1 })),
    ).toBe('budget-exceeded');
    expect(reasonOf(new AiNotConfiguredError('b'))).toBe('not-configured');
    expect(reasonOf(new AiProviderError('call', 'overloaded'))).toBe('provider-failed');
    expect(reasonOf(new UnreadableAnswerError('summarize'))).toBe('unreadable-answer');
    expect(new AssistFailure('provider-failed').getStatus()).toBe(502);
  });

  it('passes anything else through', () => {
    const error = new Error('bug');
    expect(assistFailureOf(error)).toBe(error);
  });
});
