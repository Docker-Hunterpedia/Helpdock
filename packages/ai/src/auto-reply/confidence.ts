import { LOCALE_BOOST, RRF_K } from '../knowledge/fusion.js';

/**
 * How sure auto-reply is of an answer (M7-06, REQUIREMENTS §4.7: "confidence
 * threshold"). Two signals, because neither is enough alone:
 *
 * 1. **Self-assessment.** The model ends its answer with `CONFIDENCE: 0.82`,
 *    how sure it is that the sources directly answer the customer's exact
 *    question and that its answer says so. Models are over-confident, so this
 *    is an upper bound, never a proof; a missing or unreadable figure counts
 *    as 0. A model whose sources do not answer the question writes
 *    `NO_ANSWER` instead, and has nothing to send.
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

/** The label of the model's self-assessment, as the prompt spells it. */
export const CONFIDENCE_LABEL = 'CONFIDENCE';
/** What the model writes when its sources do not answer the question. */
export const NO_ANSWER = 'NO_ANSWER';

const NO_ANSWER_MARK = /\bNO_ANSWER\b/i;
// A regex rather than an upper-cased copy, whose indices can drift from the original's.
const LABEL_ANYWHERE = new RegExp(CONFIDENCE_LABEL, 'gi');
// Matched against text with emphasis removed and blanks collapsed, so no run
// of blanks is ever matched twice.
const FIGURE = /^ ?[:：] ?(\d+(?:[.,]\d+)?) ?%?\.?$/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const EMPHASIS = /[*_`]/g;
const BLANKS = /\s+/g;

export interface SelfAssessment {
  /** The answer without its confidence figure; empty when the model wrote `NO_ANSWER`. */
  readonly text: string;
  /** 0 to 1; 0 when the model wrote none, or `NO_ANSWER`. */
  readonly self: number;
}

/**
 * Reads and removes the model's `CONFIDENCE: x`: a line of its own (the last
 * one wins), or else the end of the answer, where some models run it on from
 * the last sentence. Markdown emphasis (`**Confidence:** 0.9`), case and
 * blanks do not matter; a figure anywhere else in the text is never read as
 * confidence.
 */
export const readSelfAssessment = (answer: string): SelfAssessment => {
  if (NO_ANSWER_MARK.test(answer)) {
    return { text: '', self: 0 };
  }
  let self: number | undefined;
  const kept = answer.split('\n').filter((line) => {
    const figure = labelledFigure(line);
    if (figure === undefined) {
      return true;
    }
    self = figure;
    return false;
  });
  if (self !== undefined) {
    return { text: kept.join('\n').trim(), self: clamp(self) };
  }
  return trailingAssessment(answer.trim());
};

/** The figure of a line that is nothing but `CONFIDENCE: x`. */
const labelledFigure = (line: string): number | undefined => {
  const plain = line.replace(EMPHASIS, '').trim().toUpperCase();
  return plain.startsWith(CONFIDENCE_LABEL)
    ? figureOf(plain.slice(CONFIDENCE_LABEL.length))
    : undefined;
};

/** `… [2]. CONFIDENCE: 0.95`: the label as the answer's last words. */
const trailingAssessment = (answer: string): SelfAssessment => {
  const at = [...answer.matchAll(LABEL_ANYWHERE)].at(-1)?.index ?? -1;
  const before = answer.charAt(at - 1);
  const figure =
    at === -1 || LETTER_OR_DIGIT.test(before)
      ? undefined
      : figureOf(answer.slice(at + CONFIDENCE_LABEL.length));
  if (figure === undefined) {
    return { text: answer, self: 0 };
  }
  return { text: trimEmphasisEnd(answer.slice(0, at)), self: clamp(figure) };
};

/** `: 0.82`, `: 82 %` or `：0,82` after the label, and nothing more. */
const figureOf = (rest: string): number | undefined => {
  const digits = FIGURE.exec(rest.replace(EMPHASIS, '').replace(BLANKS, ' ').trimEnd())?.[1];
  if (digits === undefined) {
    return undefined;
  }
  const value = Number.parseFloat(digits.replace(',', '.'));
  return value > 1 ? value / 100 : value;
};

const trimEmphasisEnd = (text: string): string => {
  let end = text.length;
  while (end > 0 && /[\s*_]/.test(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(0, end);
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
