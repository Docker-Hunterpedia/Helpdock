/**
 * Post-generation citation validation (M7-04, DOMAIN-RULES §5).
 *
 * The model is shown the retrieved chunks numbered from 1 and cites them as
 * `[1]`, `[2]` or `[1, 3]`. After it answers, every marker is checked against
 * the set it was actually given: a number outside that set is a citation the
 * model made up — training data echoed as a source — and is removed.
 *
 * Removing the marker does not make the sentence true. If the model cited
 * anything it was not given, the answer leaned on it, so {@link
 * CitationCheck.handoff} is set and the caller replaces the reply with the
 * handoff message instead of sending it. An answer with no citation at all is
 * reported as {@link CitationCheck.uncited}; whether that is acceptable is the
 * feature's decision (auto-reply treats it as low confidence).
 */

export interface RetrievedForCitation {
  readonly chunkId: string;
}

export interface Citation {
  /** The number the model wrote. */
  readonly marker: number;
  readonly chunkId: string;
}

export interface CitationCheck {
  /** The answer with every fabricated marker removed. */
  readonly text: string;
  /** Valid citations in the order first cited, each chunk once. */
  readonly citations: readonly Citation[];
  /** Numbers the model cited that were not in the retrieved set. */
  readonly dropped: readonly number[];
  /** The model cited something it was not given: send the handoff message instead. */
  readonly handoff: boolean;
  readonly uncited: boolean;
}

const MARKER = /\[(\s*\d+\s*(?:,\s*\d+\s*)*)\]/g;

export const validateCitations = (
  answer: string,
  retrieved: readonly RetrievedForCitation[],
): CitationCheck => {
  const citations: Citation[] = [];
  const cited = new Set<string>();
  const dropped = new Set<number>();

  const text = answer
    .replace(MARKER, (_, group: string) => {
      const kept = group
        .split(',')
        .map((number) => Number.parseInt(number.trim(), 10))
        .filter((marker) => {
          const chunk = retrieved[marker - 1];
          if (marker < 1 || chunk === undefined) {
            dropped.add(marker);
            return false;
          }
          if (!cited.has(chunk.chunkId)) {
            cited.add(chunk.chunkId);
            citations.push({ marker, chunkId: chunk.chunkId });
          }
          return true;
        });
      return kept.length === 0 ? '' : `[${kept.join(', ')}]`;
    })
    .replace(/[ \t]+([.,;:!?؟،])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return {
    text,
    citations,
    dropped: [...dropped],
    handoff: dropped.size > 0,
    uncited: citations.length === 0,
  };
};
