import {
  type Ai,
  AiNotConfiguredError,
  AUTO_REPLY_MAX_TOKENS,
  type AutoReplyDecision,
  asksForHuman,
  autoReplyInstructions,
  autoReplyMessages,
  BudgetExceededError,
  type ConversationTurn,
  decideAutoReply,
  type KnowledgeLocale,
} from '@helpdock/ai';
import type { JobLogger } from '@helpdock/jobs';
import type { AiPauseReason } from '@helpdock/schemas';
import type { RetrievedChunk, Retriever } from '../../knowledge/retrieval/retrieve.js';

/**
 * The generation step of `ai.auto_reply` (M7-06): everything between the
 * customer's message and the decision, outside any transaction. The job
 * wraps it in the conversation's reads and writes; the evaluation harness
 * (M7-11, DOMAIN-RULES §9) calls it directly, so what the nightly run
 * measures is the path a visitor's message takes.
 *
 * ```
 * asks for a person?                       → handoff (customer_request), no model
 * retrieve (audience visitor)   nothing?   → handoff (low_confidence)
 * complete → validate citations → confidence → answer, or handoff
 * budget spent / no model                  → null: stop without a word
 * ```
 */

export const AUTO_REPLY_FEATURE = 'auto_reply';
const RETRIEVE_K = 6;

export interface GenerateDeps {
  readonly ai: Pick<Ai, 'complete'>;
  readonly retriever: Retriever;
  readonly log: JobLogger;
}

export interface GenerateInput {
  readonly brandId: string;
  /** Null outside a conversation, as the evaluation harness runs it. */
  readonly ticketId: string | null;
  /** The customer's latest message. */
  readonly text: string;
  readonly locale: KnowledgeLocale;
  /** The conversation so far, the latest message last. */
  readonly turns: readonly ConversationTurn[];
  /** The brand's confidence threshold for this channel. */
  readonly threshold: number;
}

export type GenerateOutcome =
  | { readonly kind: 'answer'; readonly decision: Extract<AutoReplyDecision, { kind: 'answer' }> }
  | {
      readonly kind: 'handoff';
      readonly reason: AiPauseReason;
      readonly confidence: number | null;
      /** False for the customer's own request: the widget already says it, and there is no answer to replace. */
      readonly withMessage: boolean;
    };

export interface Generated {
  readonly outcome: GenerateOutcome;
  readonly chunks: readonly RetrievedChunk[];
  /** The model's text as it wrote it, confidence line and all; null when no model ran. */
  readonly rawAnswer: string | null;
  readonly callId: string | null;
  readonly model: string | null;
}

/** Null: a spent budget or no model; the assistant stays quiet and a person answers. */
export const generateAutoReply = async (
  deps: GenerateDeps,
  input: GenerateInput,
): Promise<Generated | null> => {
  if (asksForHuman(input.text)) {
    return {
      outcome: {
        kind: 'handoff',
        reason: 'customer_request',
        confidence: null,
        withMessage: false,
      },
      chunks: [],
      rawAnswer: null,
      callId: null,
      model: null,
    };
  }

  const { chunks, mode } = await deps.retriever.retrieve({
    brandId: input.brandId,
    query: input.text,
    audience: 'visitor',
    locale: input.locale,
    k: RETRIEVE_K,
  });
  if (chunks.length === 0) {
    return {
      outcome: { kind: 'handoff', reason: 'low_confidence', confidence: 0, withMessage: true },
      chunks,
      rawAnswer: null,
      callId: null,
      model: null,
    };
  }

  let completion: Awaited<ReturnType<GenerateDeps['ai']['complete']>>;
  try {
    completion = await deps.ai.complete({
      brandId: input.brandId,
      feature: AUTO_REPLY_FEATURE,
      ticketId: input.ticketId,
      locale: input.locale,
      instructions: autoReplyInstructions(chunks, input.locale),
      messages: autoReplyMessages(input.turns),
      sources: chunks.map((chunk) => chunk.chunkId),
      maxTokens: AUTO_REPLY_MAX_TOKENS,
      temperature: 0.2,
    });
  } catch (error) {
    // DOMAIN-RULES §9 and REQUIREMENTS §4.7: a spent budget or no model means
    // the assistant stays quiet and a person answers; the visitor is never
    // told why. The refusal is already in `ai_calls`.
    if (error instanceof BudgetExceededError || error instanceof AiNotConfiguredError) {
      deps.log.info(
        { feature: AUTO_REPLY_FEATURE, brandId: input.brandId, reason: error.name },
        'auto-reply skipped',
      );
      return null;
    }
    throw error;
  }

  const decision = decideAutoReply({
    answer: completion.text,
    chunks,
    mode,
    locale: input.locale,
    threshold: input.threshold,
  });
  return {
    outcome:
      decision.kind === 'answer'
        ? { kind: 'answer', decision }
        : {
            kind: 'handoff',
            reason: decision.reason,
            confidence: decision.confidence,
            withMessage: true,
          },
    chunks,
    rawAnswer: completion.text,
    callId: completion.callId,
    model: completion.model,
  };
};
