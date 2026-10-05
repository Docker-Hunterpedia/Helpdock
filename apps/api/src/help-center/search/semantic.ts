import type { HcLocale } from '@helpdock/schemas';
import { type SQL, sql } from 'drizzle-orm';
import { readableVersions } from '../visibility.js';
import {
  CANDIDATE_LIMIT,
  type Candidate,
  type CandidateScope,
  type CandidateSource,
} from './ranking.js';

/**
 * The semantic candidates of help center search and the widget's suggestions
 * (M7-04, the seam `ranking.ts` left for M7): articles whose knowledge chunks
 * are nearest the question's vector, merged with the lexical list by
 * reciprocal rank fusion.
 *
 * **Visibility first**, as the lexical source: the query opens with
 * `readableVersions(audience)` and a chunk takes part only by joining the
 * live version that CTE let through, so a visitor is never shown an internal
 * or unpublished article however close its chunks are.
 *
 * Without a question vector — no embedding model, a re-embed running, the
 * endpoint failing — it returns nothing and search is lexical, as in M5.
 * Chunks further than {@link SEMANTIC_MAX_DISTANCE} are not candidates: a
 * nearest neighbour always exists, and a weak one is noise.
 */

/** Cosine distance (1 − similarity) past which a chunk is not a match. */
export const SEMANTIC_MAX_DISTANCE = 0.6;

export const semanticCandidatesSql = (
  scope: CandidateScope,
  vector: string,
  model: string,
): SQL => sql`
  with ${readableVersions(scope.audience)},
  near as (
    select c.article_id, c.meta->>'articleLocale' as locale,
      min(c.embedding <=> ${vector}::vector) as distance
    from knowledge_chunks c
    join readable r on r.article_id = c.article_id and r.locale = c.meta->>'articleLocale'
    where c.brand_id = ${scope.brandId} and c.article_id is not null
      and c.embedding_model = ${model} and c.embedding is not null
      and c.meta->>'articleLocale' in (${scope.locale}, ${scope.defaultLocale})
    group by c.article_id, c.meta->>'articleLocale'
  ),
  picked as (
    select distinct on (article_id) article_id, locale, distance
    from near
    order by article_id, (locale = ${scope.locale}) desc, distance
  )
  select article_id, locale from picked
  where distance <= ${SEMANTIC_MAX_DISTANCE}
  order by distance, article_id
  limit ${CANDIDATE_LIMIT}`;

export const semanticSource: CandidateSource = {
  async candidates(tx, scope): Promise<readonly Candidate[]> {
    if (scope.queryVector === undefined) {
      return [];
    }
    const rows = await tx.execute<{ article_id: string; locale: HcLocale }>(
      semanticCandidatesSql(scope, scope.queryVector.literal, scope.queryVector.model),
    );
    return rows.map((row) => ({ articleId: row.article_id, locale: row.locale }));
  },
};
