import {
  AiNotConfiguredError,
  AiProviderError,
  BudgetExceededError,
  UnreadableAnswerError,
} from '@helpdock/ai';
import type { AssistRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * An assist request or proposal decision refused by a rule rather than a
 * permission (M7-05). The admin picks its sentence from `reason`, carried as
 * `error.assist.reason`; the messages are for the log and for `curl`.
 */

const STATUS_BY_REASON: Readonly<Record<AssistRefusal, number>> = {
  'assist-off': HttpStatus.CONFLICT,
  'budget-exceeded': HttpStatus.CONFLICT,
  'not-configured': HttpStatus.CONFLICT,
  'provider-failed': HttpStatus.BAD_GATEWAY,
  'ticket-not-closed': HttpStatus.CONFLICT,
  'proposal-exists': HttpStatus.CONFLICT,
  'proposal-decided': HttpStatus.CONFLICT,
  'nothing-to-work-from': HttpStatus.CONFLICT,
  'unreadable-answer': HttpStatus.BAD_GATEWAY,
};

const MESSAGE_BY_REASON: Readonly<Record<AssistRefusal, string>> = {
  'assist-off': 'Agent assist is turned off for this brand',
  'budget-exceeded': "The brand's AI budget is spent",
  'not-configured': 'No AI model is configured for this brand',
  'provider-failed': 'The AI provider failed; the call is in the AI log',
  'ticket-not-closed': 'An article can be drafted once the ticket is closed',
  'proposal-exists': 'This ticket already has an article waiting for approval',
  'proposal-decided': 'This proposal was already approved or rejected',
  'nothing-to-work-from': 'There is nothing in this ticket for the assistant to work from',
  'unreadable-answer': "The assistant's answer could not be read; try again",
};

export class AssistFailure extends HttpException {
  readonly reason: AssistRefusal;

  constructor(reason: AssistRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'AssistFailure';
    this.reason = reason;
  }
}

/** What a failed model call means to the agent, or the error itself when it means nothing. */
export const assistFailureOf = (error: unknown): unknown => {
  if (error instanceof BudgetExceededError) {
    return new AssistFailure('budget-exceeded');
  }
  if (error instanceof AiNotConfiguredError) {
    return new AssistFailure('not-configured');
  }
  if (error instanceof AiProviderError) {
    return new AssistFailure('provider-failed');
  }
  if (error instanceof UnreadableAnswerError) {
    return new AssistFailure('unreadable-answer');
  }
  return error;
};
