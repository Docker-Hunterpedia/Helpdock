import { LOCALE_BOOST, RRF_K } from '../knowledge/fusion.js';

/**
 * How sure auto-reply is of an answer (M7-06, REQUIREMENTS §4.7: "confidence
 * threshold"). Two signals, because neither is enough alone:
 *
 * 1. **Self-assessment.** The model ends its answer with `CONFIDENCE: 0.82`,
 *    how sure it is that the answer is right and supported by the sources it
 *    was given. Models are over-confident, so this is an upper bound, never a
 *    proof; a missing or unreadable line counts as 0.
 * 2. **Retrieval support.** How strongly retrieval backed the chunks the
 *    answer cites. A chunk's fused score is `Σ 1 / (60 + rank)` over the
 *    rankers that found it (ADR 0020), so dividing by the most it could score
 *    — first in every ranker that ran, with the locale boost when it applied —
 *    gives a number near 1 when every ranker put it at the top and about 0.5
 *    in hybrid mode when only one ranker found it at all. The best cited
 *    chunk counts.
 *
 * ```
 * confidence = self × (0.6 + 0.4 × support)      0 when nothing valid is cited
 * ```
 *
 * Support can only lower the model's own figure, by up to 40 %: an answer the
 * model is sure of, citing a chunk only one of two rankers found, scores
 * `0.95 × 0.8 = 0.76`. The brand compares the result with its threshold
 * (0.70 by default); the evaluation harness (M7-11, DOMAIN-RULES §9)
 * is what calibrates that default against "unanswerable handed off ≥ 95 %".
 */

export const SUPPORT_FLOOR = 0.6;

const CONFIDENCE_LINE = /^[ \t]*confidence[ \t]*[:：][ \t]*(\d+(?:[.,]\d+)?)[ \t]*%?[ \t]*$/gim;

export interface SelfAssessment {
  /** The answer without the confidence line. */
  readonly text: string;
  /** 0 to 1; 0 when the model wrote none. */
  readonly self: number;
}

/** Reads and removes the model's `CONFIDENCE:` line; the last one wins. */
export const readSelfAssessment = (answer: string): SelfAssessment => {
  let self = 0;
  const text = answer
    .replace(CONFIDENCE_LINE, (_, figure: string) => {
      const value = Number.parseFloat(figure.replace(',', '.'));
      self = value > 1 ? value / 100 : value;
      return '';
    })
    .trim();
  return { text, self: clamp(self) };
};

export interface SupportingChunk {
  readonly score: number;
  readonly locale: string;
}

/** 0 to 1: how close the best cited chunk came to the most it could score. */
export const retrievalSupport = (
  cited: readonly SupportingChunk[],
  { rankers, locale }: { readonly rankers: number; readonly locale: string },
): number => {
  const ceiling = (chunk: SupportingChunk): number =>
    (rankers / (RRF_K + 1)) * (chunk.locale === locale ? LOCALE_BOOST : 1);
  return cited.reduce((best, chunk) => Math.max(best, clamp(chunk.score / ceiling(chunk))), 0);
};

export const answerConfidence = (self: number, support: number, cited: boolean): number =>
  cited ? round(clamp(self) * (SUPPORT_FLOOR + (1 - SUPPORT_FLOOR) * clamp(support))) : 0;

const clamp = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const round = (value: number): number => Math.round(value * 100) / 100;
