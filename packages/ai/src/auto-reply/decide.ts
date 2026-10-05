import { type Citation, validateCitations } from '../knowledge/citations.js';
import { answerConfidence, readSelfAssessment, retrievalSupport } from './confidence.js';

/**
 * Whether a model's answer goes to the customer or the conversation goes to
 * the team (M7-06, DOMAIN-RULES §5 and §9), in order:
 *
 * 1. a citation the model was not given → hand off (`invalid_citation`);
 * 2. no valid citation, or confidence under the brand's threshold → hand off
 *    (`low_confidence`);
 * 3. otherwise the answer, with its confidence line removed.
 */

export interface DecisionChunk {
  readonly chunkId: string;
  readonly score: number;
  readonly locale: string;
}

export interface DecisionInput {
  readonly answer: string;
  /** In the order the model saw them: `[1]` is the first. */
  readonly chunks: readonly DecisionChunk[];
  readonly mode: 'hybrid' | 'lexical';
  readonly locale: string;
  readonly threshold: number;
}

export type AutoReplyDecision =
  | {
      readonly kind: 'answer';
      readonly text: string;
      readonly citations: readonly Citation[];
      readonly confidence: number;
    }
  | {
      readonly kind: 'handoff';
      readonly reason: 'invalid_citation' | 'low_confidence';
      readonly confidence: number;
    };

export const decideAutoReply = ({
  answer,
  chunks,
  mode,
  locale,
  threshold,
}: DecisionInput): AutoReplyDecision => {
  const { text, self } = readSelfAssessment(answer);
  const check = validateCitations(text, chunks);
  const cited = check.citations.flatMap(
    (citation) => chunks.find((chunk) => chunk.chunkId === citation.chunkId) ?? [],
  );
  const support = retrievalSupport(cited, { rankers: mode === 'hybrid' ? 2 : 1, locale });
  const confidence = answerConfidence(self, support, !check.uncited);

  if (check.handoff) {
    return { kind: 'handoff', reason: 'invalid_citation', confidence };
  }
  if (check.uncited || confidence < threshold || check.text === '') {
    return { kind: 'handoff', reason: 'low_confidence', confidence };
  }
  return { kind: 'answer', text: check.text, citations: check.citations, confidence };
};
