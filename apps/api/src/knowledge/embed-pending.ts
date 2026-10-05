import type { Ai } from '@helpdock/ai';
import { type Db, embeddingTarget, knowledgeChunks, toVectorLiteral } from '@helpdock/db';
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { withSystemJob } from '../tenant/system-job.js';

/**
 * Embeds one brand's chunks that have no vector in the install's target model
 * yet (M7-03): what an article publish or a sync just wrote. The target, not
 * the active model, so chunks written during a re-embed land in the model the
 * space is moving to (`embeddingTarget`, DOMAIN-RULES §8).
 *
 * Reads and writes run in short system transactions of the brand; the
 * provider call runs between them, outside any transaction. Nothing is
 * embedded before the install has an embedding model: the chunks wait, and
 * full-text retrieval finds them meanwhile.
 */

export const EMBED_BATCH_SIZE = 64;

export const embedPending = async ({
  db,
  ai,
  brandId,
  jobId,
  batchSize = EMBED_BATCH_SIZE,
  now = () => new Date(),
}: {
  readonly db: Db;
  readonly ai: Pick<Ai, 'embed'>;
  readonly brandId: string;
  readonly jobId: string;
  readonly batchSize?: number;
  readonly now?: () => Date;
}): Promise<number> => {
  const target = await embeddingTarget(db);
  if (target === null) {
    return 0;
  }
  let embedded = 0;
  // Never more passes than chunks could need: a batch the provider answers
  // for but that a concurrent rewrite deleted meanwhile cannot loop forever.
  for (let pass = 0; pass < 10_000; pass += 1) {
    const batch = await withSystemJob(db, brandId, jobId, (tx) =>
      tx
        .select({ id: knowledgeChunks.id, content: knowledgeChunks.content })
        .from(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.brandId, brandId),
            or(
              isNull(knowledgeChunks.embeddingModel),
              ne(knowledgeChunks.embeddingModel, target.model),
              sql`${sql.identifier('embedding')} IS NULL`,
            ),
          ),
        )
        .orderBy(asc(knowledgeChunks.id))
        .limit(batchSize),
    );
    if (batch.length === 0) {
      return embedded;
    }
    const { vectors, model } = await ai.embed({
      brandId,
      feature: 'knowledge.embed',
      texts: batch.map((chunk) => chunk.content),
    });
    if (model !== target.model) {
      // The settings moved on while this ran; `knowledge.configure` takes it from here.
      return embedded;
    }
    const at = now().toISOString();
    await withSystemJob(db, brandId, jobId, async (tx) => {
      for (const [index, chunk] of batch.entries()) {
        await tx.execute(sql`
          UPDATE knowledge_chunks
          SET embedding = ${toVectorLiteral(vectors[index] ?? [])}::vector,
              embedding_model = ${model},
              embedded_at = ${at}::timestamptz
          WHERE id = ${chunk.id}`);
      }
    });
    embedded += batch.length;
  }
  return embedded;
};
