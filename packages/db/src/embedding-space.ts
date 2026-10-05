import { eq, sql } from 'drizzle-orm';
import type { Db, DbTransaction } from './client.js';
import { type EmbeddingSpaceRow, embeddingSpace } from './schema/knowledge.js';

/**
 * The install's one embedding space (DOMAIN-RULES §8, ADR 0005) as code reads
 * and moves it. Retrieval asks {@link activeEmbeddingSpace}; the
 * `knowledge.configure` and `knowledge.reembed` jobs move it with the rest.
 */

type Executor = Db | DbTransaction;

/** The vectors retrieval may rank: the model they came from and their dimension. */
export interface ActiveEmbeddingSpace {
  readonly model: string;
  readonly dims: number;
}

/** pgvector's HNSW and IVFFlat indexes cover at most this many dimensions. */
export const MAX_EMBEDDING_DIMS = 2_000;

export const readEmbeddingSpace = async (executor: Executor): Promise<EmbeddingSpaceRow> => {
  const [row] = await executor.select().from(embeddingSpace).limit(1);
  if (row === undefined) {
    // The migration seeds the row; a missing one is a database restored without it.
    throw new Error('The embedding_space row is missing; run the migrations again');
  }
  return row;
};

/**
 * What a vector search may compare against, or null when it may not search by
 * vector at all: before an embedding model is configured, and for the whole of
 * a re-embed, when retrieval falls back to full text (DOMAIN-RULES §8).
 *
 * Every vector query filters `knowledge_chunks.embedding_model = model`. That,
 * and not the dimension, is what keeps two models' vectors out of one ranking:
 * two models can share a dimension and still mean nothing to each other.
 */
export const activeEmbeddingSpace = async (
  executor: Executor,
): Promise<ActiveEmbeddingSpace | null> => {
  const row = await readEmbeddingSpace(executor);
  return row.status === 'ready' && row.activeModel !== null && row.activeDims !== null
    ? { model: row.activeModel, dims: row.activeDims }
    : null;
};

/** The model new chunks are embedded with: the target while a re-embed runs, else the active one. */
export const embeddingTarget = async (executor: Executor): Promise<ActiveEmbeddingSpace | null> => {
  const row = await readEmbeddingSpace(executor);
  return row.targetModel !== null && row.targetDims !== null
    ? { model: row.targetModel, dims: row.targetDims }
    : null;
};

export const updateEmbeddingSpace = async (
  executor: Executor,
  changes: Partial<Omit<EmbeddingSpaceRow, 'singleton' | 'updatedAt'>>,
): Promise<void> => {
  await executor
    .update(embeddingSpace)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(embeddingSpace.singleton, true));
};

/**
 * Drops the vector index and gives `knowledge_chunks.embedding` this dimension,
 * through the owner-rights function of migration 0038: the runtime role may
 * not run DDL (DOMAIN-RULES §1.5).
 */
export const setEmbeddingDims = async (executor: Executor, dims: number): Promise<void> => {
  if (!Number.isInteger(dims) || dims < 1 || dims > MAX_EMBEDDING_DIMS) {
    throw new RangeError(`An embedding dimension must be 1 to ${MAX_EMBEDDING_DIMS}, got ${dims}`);
  }
  await executor.execute(sql`SELECT public.helpdock_set_embedding_dims(${dims}::integer)`);
};

/** Builds the HNSW cosine index over `knowledge_chunks.embedding`, once the re-embed is done. */
export const buildEmbeddingIndex = async (executor: Executor): Promise<void> => {
  await executor.execute(sql`SELECT public.helpdock_build_embedding_index()`);
};

/** The `[0.1,0.2,…]` text form pgvector reads a vector from, for a bound parameter. */
export const toVectorLiteral = (vector: readonly number[]): string => {
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new RangeError('A vector may only hold finite numbers');
  }
  return `[${vector.join(',')}]`;
};
