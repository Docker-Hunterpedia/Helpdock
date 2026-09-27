import type { DbTransaction } from '@helpdock/db';
import type { HcAudience, HcLocale } from '@helpdock/schemas';
import type { SearchTerms } from './query-terms.js';

/**
 * How candidates from several retrieval methods become one ranking (M5-05).
 *
 * **The seam for M7.** Search asks every {@link CandidateSource} for its best
 * articles and merges the lists here. M5 has one source, the lexical one
 * (full text plus trigram, `lexical.ts`); M7 adds a semantic source over
 * `knowledge_chunks` beside it, and nothing else about search changes. Every
 * source is handed the audience and must filter by it in SQL before it ranks
 * (DOMAIN-RULES §5), as the lexical one does through `readableVersions`.
 *
 * **Reciprocal rank fusion** merges them: an article scores `1 / (k + rank)`
 * in each list it appears in, summed. It needs no calibration between a
 * `ts_rank` and a cosine distance, which is what makes adding a source safe;
 * with one list it keeps that list's order.
 */

export interface Candidate {
  readonly articleId: string;
  /** The language this article matched in. */
  readonly locale: HcLocale;
}

export interface CandidateScope {
  readonly brandId: string;
  readonly audience: HcAudience;
  readonly locale: HcLocale;
  readonly defaultLocale: HcLocale;
}

export interface CandidateSource {
  /** Best first, at most {@link CANDIDATE_LIMIT}, only articles the audience may read. */
  candidates(
    tx: DbTransaction,
    scope: CandidateScope,
    terms: SearchTerms,
  ): Promise<readonly Candidate[]>;
}

/** How many candidates a source returns, and so the most a search can count as `total`. */
export const CANDIDATE_LIMIT = 100;

/** The usual constant of reciprocal rank fusion; it damps the difference between rank 1 and 2. */
export const RRF_K = 60;

export const mergeRankings = (lists: readonly (readonly Candidate[])[]): Candidate[] => {
  const merged = new Map<string, { candidate: Candidate; score: number; first: number }>();
  let seen = 0;

  for (const list of lists) {
    list.forEach((candidate, rank) => {
      const entry = merged.get(candidate.articleId);
      const score = 1 / (RRF_K + rank + 1);
      if (entry === undefined) {
        merged.set(candidate.articleId, { candidate, score, first: seen });
        seen += 1;
      } else {
        entry.score += score;
      }
    });
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, CANDIDATE_LIMIT)
    .map((entry) => entry.candidate);
};
