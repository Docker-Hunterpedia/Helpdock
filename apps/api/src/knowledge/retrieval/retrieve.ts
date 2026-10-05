import { type Ai, fuseRankings, type RankedChunk } from '@helpdock/ai';
import {
  activeEmbeddingSpace,
  type Db,
  type DbTransaction,
  systemContext,
  toVectorLiteral,
  withTenant,
} from '@helpdock/db';
import type { KnowledgeSourceKind, KnowledgeVisibility } from '@helpdock/schemas';
import { type SQL, sql } from 'drizzle-orm';
import { normalizeQuery, searchTerms } from '../../help-center/search/query-terms.js';
import { type RetrievalAudience, visibleChunks } from './visibility.js';

/**
 * Hybrid retrieval with an audience (M7-04, ARCHITECTURE §10, DOMAIN-RULES §5
 * and §8): what assist, auto-reply and help center search ask the knowledge
 * base.
 *
 * ```
 * embed the question (outside any transaction)       only while the space is `ready`
 * brand transaction:
 *   vector  — chunks visible to the audience, in the active model, by cosine distance
 *   lexical — chunks visible to the audience, by full text (`arabic` or `english`)
 *   reciprocal rank fusion, locale boost (`fuseRankings`)
 *   the top k read back, visibility re-checked
 * ```
 *
 * The audience filter is the first condition of both rankers' SQL, so nothing
 * is ranked that the audience may not see (`visibility.ts`). While the
 * embedding space is not `ready` — no model yet, or a re-embed running — or
 * the embeddings endpoint fails, retrieval is full text alone and says so in
 * {@link RetrievalResult.mode}.
 */

/** Candidates each ranker hands to the fusion. */
export const RETRIEVAL_CANDIDATES = 50;
export const DEFAULT_K = 6;
export const MAX_K = 20;

export interface RetrieveRequest {
  readonly brandId: string;
  readonly query: string;
  readonly audience: RetrievalAudience;
  /** The reader's language, which the locale boost favours. */
  readonly locale: string;
  readonly k?: number;
}

export interface RetrievedChunk {
  /** One-based: the number the model cites it by (`validateCitations`). */
  readonly index: number;
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceKind: KnowledgeSourceKind;
  readonly sourceName: string;
  readonly title: string;
  readonly url: string | null;
  readonly articleId: string | null;
  readonly locale: string;
  /** Whether a visitor could be shown it: agent assist marks internal citations. */
  readonly visibility: KnowledgeVisibility;
  readonly content: string;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly suspicious: boolean;
  readonly score: number;
}

export interface RetrievalResult {
  readonly chunks: readonly RetrievedChunk[];
  readonly mode: 'hybrid' | 'lexical';
}

/** A question's vector in the active model, as the literal pgvector reads. */
export interface QueryVector {
  readonly model: string;
  readonly literal: string;
}

export type QueryEmbedder = (brandId: string, text: string) => Promise<QueryVector | null>;

/**
 * Embeds a question in the active model, or answers null — no model, a
 * re-embed running, the endpoint failing — so the caller falls back to full
 * text instead of failing (DOMAIN-RULES §8).
 */
export const createQueryEmbedder =
  (
    db: Db,
    ai: Pick<Ai, 'embed'>,
    onError: (error: unknown) => void = () => undefined,
  ): QueryEmbedder =>
  async (brandId, text) => {
    const active = await activeEmbeddingSpace(db);
    if (active === null) {
      return null;
    }
    try {
      const { vectors, model } = await ai.embed({
        brandId,
        feature: 'knowledge.retrieve',
        texts: [text],
      });
      const vector = vectors[0];
      return model === active.model && vector !== undefined
        ? { model, literal: toVectorLiteral(vector) }
        : null;
    } catch (error) {
      onError(error);
      return null;
    }
  };

const from = (brandId: string, audience: RetrievalAudience): SQL => sql`
  from knowledge_chunks c
  join knowledge_sources s on s.id = c.source_id
  where c.brand_id = ${brandId} and ${visibleChunks(audience)}`;

const configOf = sql`(case when c.locale = 'ar' then 'arabic' else 'english' end)::regconfig`;

export const lexicalChunksSql = (
  brandId: string,
  audience: RetrievalAudience,
  anyTerms: string,
): SQL => sql`
  select c.id, c.locale ${from(brandId, audience)}
    and c.search @@ to_tsquery(${configOf}, ${anyTerms})
  order by ts_rank_cd(c.search, to_tsquery(${configOf}, ${anyTerms}), 32) desc, c.id
  limit ${RETRIEVAL_CANDIDATES}`;

export const vectorChunksSql = (
  brandId: string,
  audience: RetrievalAudience,
  vector: QueryVector,
): SQL => sql`
  select c.id, c.locale ${from(brandId, audience)}
    and c.embedding_model = ${vector.model} and c.embedding is not null
  order by c.embedding <=> ${vector.literal}::vector, c.id
  limit ${RETRIEVAL_CANDIDATES}`;

type DetailRow = {
  readonly id: string;
  readonly source_id: string;
  readonly kind: KnowledgeSourceKind;
  readonly name: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly article_id: string | null;
  readonly locale: string;
  readonly public: boolean;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  readonly suspicious: boolean;
};

/** The chosen chunks read back for the answer, the audience filter applied once more. */
export const chunkDetailsSql = (
  brandId: string,
  audience: RetrievalAudience,
  ids: readonly string[],
): SQL => sql`
  select c.id, c.source_id, s.kind, s.name, d.title, d.url, c.article_id, c.locale,
    ${visibleChunks('visitor')} as public, c.content, c.meta, c.suspicious
  from knowledge_chunks c
  join knowledge_sources s on s.id = c.source_id
  join knowledge_documents d on d.id = c.document_id
  where c.brand_id = ${brandId} and ${visibleChunks(audience)}
    and c.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`;

const ranked = async (tx: DbTransaction, query: SQL): Promise<RankedChunk[]> =>
  (await tx.execute<{ id: string; locale: string }>(query)).map((row) => ({
    id: row.id,
    locale: row.locale,
  }));

export interface Retriever {
  retrieve(request: RetrieveRequest): Promise<RetrievalResult>;
}

export const createRetriever = ({
  db,
  embedQuery,
}: {
  readonly db: Db;
  readonly embedQuery: QueryEmbedder;
}): Retriever => ({
  async retrieve({ brandId, query, audience, locale, k = DEFAULT_K }) {
    const q = normalizeQuery(query);
    const terms = searchTerms(q);
    const vector = q === '' ? null : await embedQuery(brandId, q);
    if (terms === null && vector === null) {
      return { chunks: [], mode: 'lexical' };
    }
    const limit = Math.min(Math.max(k, 1), MAX_K);

    return withTenant(db, systemContext(brandId, 'knowledge.retrieve'), async (tx) => {
      const lists: RankedChunk[][] = [];
      if (vector !== null) {
        lists.push(await ranked(tx, vectorChunksSql(brandId, audience, vector)));
      }
      if (terms !== null) {
        lists.push(await ranked(tx, lexicalChunksSql(brandId, audience, terms.any)));
      }
      const top = fuseRankings(lists, { locale }).slice(0, limit);
      if (top.length === 0) {
        return { chunks: [], mode: vector === null ? 'lexical' : 'hybrid' };
      }
      const rows = await tx.execute<DetailRow>(
        chunkDetailsSql(
          brandId,
          audience,
          top.map((chunk) => chunk.id),
        ),
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const chunks = top.flatMap((chunk) => {
        const row = byId.get(chunk.id);
        return row === undefined ? [] : [{ row, score: chunk.score }];
      });
      return {
        mode: vector === null ? 'lexical' : 'hybrid',
        chunks: chunks.map(({ row, score }, position) => ({
          index: position + 1,
          chunkId: row.id,
          sourceId: row.source_id,
          sourceKind: row.kind,
          sourceName: row.name,
          title: row.title ?? '',
          url: row.url,
          articleId: row.article_id,
          locale: row.locale,
          visibility: row.public ? 'public' : 'internal',
          content: row.content,
          meta: row.meta,
          suspicious: row.suspicious,
          score,
        })),
      };
    });
  },
});
