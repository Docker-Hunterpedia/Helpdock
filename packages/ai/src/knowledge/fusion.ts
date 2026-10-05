/**
 * Reciprocal rank fusion with a locale boost (M7-04, ARCHITECTURE §10;
 * [ADR 0019](../../../../docs/decisions/0019-knowledge-chunking-and-fusion.md)).
 *
 * Retrieval asks two rankers — pgvector cosine and Postgres full text — for
 * their best chunks, each already filtered by audience in SQL, and merges the
 * lists here. A chunk scores `1 / (k + rank)` in every list it is in, summed:
 * no calibration between a cosine distance and a `ts_rank` is needed, and a
 * chunk both rankers like beats one only one of them does.
 *
 * A chunk in the reader's language is then multiplied by
 * {@link LOCALE_BOOST}: an Arabic question is better answered by the Arabic
 * version of an article than by the English one, but a strong English match
 * still beats a weak Arabic one.
 */

/** The usual RRF constant: it damps the gap between rank 1 and rank 2. The help center uses the same. */
export const RRF_K = 60;
/** The multiplier for a chunk in the reader's language. */
export const LOCALE_BOOST = 1.25;

export interface RankedChunk {
  readonly id: string;
  readonly locale: string;
}

export interface FusedChunk {
  readonly id: string;
  readonly score: number;
}

export const fuseRankings = (
  lists: readonly (readonly RankedChunk[])[],
  { locale, k = RRF_K, boost = LOCALE_BOOST }: { locale: string; k?: number; boost?: number },
): FusedChunk[] => {
  const merged = new Map<string, { score: number; first: number; locale: string }>();
  let seen = 0;
  for (const list of lists) {
    list.forEach((chunk, rank) => {
      const entry = merged.get(chunk.id);
      const score = 1 / (k + rank + 1);
      if (entry === undefined) {
        merged.set(chunk.id, { score, first: seen, locale: chunk.locale });
        seen += 1;
      } else {
        entry.score += score;
      }
    });
  }

  return [...merged.entries()]
    .map(([id, entry]) => ({
      id,
      score: entry.locale === locale ? entry.score * boost : entry.score,
      first: entry.first,
    }))
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .map(({ id, score }) => ({ id, score }));
};
