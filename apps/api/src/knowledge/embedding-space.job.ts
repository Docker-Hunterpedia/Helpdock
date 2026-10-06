import type { Ai } from '@helpdock/ai';
import type { Settings } from '@helpdock/config';
import {
  buildEmbeddingIndex,
  type Db,
  knowledgeChunks,
  readEmbeddingSpace,
  setEmbeddingDims,
  toVectorLiteral,
  updateEmbeddingSpace,
} from '@helpdock/db';
import {
  type JobLogger,
  KNOWLEDGE_REEMBED_JOB_ID,
  knowledgeConfigureJob,
  knowledgeReembedJob,
} from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { liveBrandIds } from '../tenant/live-brands.js';
import { withSystemJob } from '../tenant/system-job.js';

/**
 * The embedding space's two jobs (M7-02, DOMAIN-RULES §8, ADR 0005).
 *
 * ```
 * every minute  knowledge.configure   settings ≠ space? drop index, resize column, reindexing → add reembed
 *               knowledge.reembed     brand by brand: chunks not in the target model → embed → store
 *                                     all done → HNSW index → ready, active = target
 * ```
 *
 * **Never mixed.** Retrieval ranks by vector only while the space is `ready`,
 * and only rows whose `embedding_model` is the active one
 * (`activeEmbeddingSpace`). For the whole re-embed the space is `reindexing`,
 * so retrieval is full text alone; a re-embed that fails stays `reindexing`
 * with `last_error` set, and the next tick resumes it from the chunks still
 * left. The space flips to `ready` only when no chunk of any brand is left in
 * another model.
 *
 * **Tenancy.** `brands` and `embedding_space` are global tables, and the DDL
 * runs through owner-rights functions; every read and write of a chunk is in
 * a system transaction of that chunk's brand alone (DOMAIN-RULES §1.4).
 */

/** Chunks per embedding request and per write. */
export const REEMBED_BATCH_SIZE = 64;

export type EmbeddingSettingsReader = Pick<Settings, 'get'>;

export interface ReembedQueue {
  add(jobId: string): Promise<void>;
}

export type ConfigureOutcome = 'unconfigured' | 'settled' | 'resumed' | 'started';

/** Compares the settings with the space and starts or resumes a re-embed when they differ. */
export const configureEmbeddingSpace = async ({
  db,
  settings,
  queue,
  now = new Date(),
}: {
  readonly db: Db;
  readonly settings: EmbeddingSettingsReader;
  readonly queue: ReembedQueue;
  readonly now?: Date;
}): Promise<ConfigureOutcome> => {
  const [provider, model, dims] = await Promise.all([
    settings.get('embedding.provider'),
    settings.get('embedding.model'),
    settings.get('embedding.dims'),
  ]);
  if (model === '' || dims === 0) {
    return 'unconfigured';
  }

  const space = await readEmbeddingSpace(db);
  if (space.targetModel === model && space.targetDims === dims) {
    if (space.status === 'ready') {
      return 'settled';
    }
    await queue.add(KNOWLEDGE_REEMBED_JOB_ID);
    return 'resumed';
  }

  await setEmbeddingDims(db, dims);
  await updateEmbeddingSpace(db, {
    status: 'reindexing',
    targetProvider: provider,
    targetModel: model,
    targetDims: dims,
    columnDims: dims,
    lastError: null,
    startedAt: now,
    finishedAt: null,
  });
  await queue.add(KNOWLEDGE_REEMBED_JOB_ID);
  return 'started';
};

export interface ReembedResult {
  readonly embedded: number;
  readonly ready: boolean;
}

/**
 * Moves every chunk into the target model, then opens the space. Stops early,
 * without flipping anything, if the target changes underneath it: the next
 * tick starts over for the new one.
 */
export const reembedChunks = async ({
  db,
  ai,
  jobId,
  batchSize = REEMBED_BATCH_SIZE,
  now = () => new Date(),
}: {
  readonly db: Db;
  readonly ai: Pick<Ai, 'embed'>;
  readonly jobId: string;
  readonly batchSize?: number;
  readonly now?: () => Date;
}): Promise<ReembedResult> => {
  const space = await readEmbeddingSpace(db);
  const model = space.targetModel;
  if (space.status !== 'reindexing' || model === null) {
    return { embedded: 0, ready: space.status === 'ready' };
  }

  // A brand in its deletion grace is re-embedded too: restored, its chunks
  // must already sit in the space the install moved to.
  const live = await liveBrandIds(db, 'not-deleted');
  let embedded = 0;
  try {
    for (const brandId of live) {
      embedded += await reembedBrand({ db, ai, jobId, brandId, model, batchSize, now });
    }
  } catch (error) {
    await updateEmbeddingSpace(db, {
      lastError: error instanceof Error ? error.message : 'the re-embed failed',
    });
    throw error;
  }

  if ((await readEmbeddingSpace(db)).targetModel !== model) {
    return { embedded, ready: false };
  }
  await buildEmbeddingIndex(db);
  await updateEmbeddingSpace(db, {
    status: 'ready',
    activeModel: model,
    activeDims: space.targetDims,
    lastError: null,
    finishedAt: now(),
  });
  return { embedded, ready: true };
};

const reembedBrand = async ({
  db,
  ai,
  jobId,
  brandId,
  model,
  batchSize,
  now,
}: {
  readonly db: Db;
  readonly ai: Pick<Ai, 'embed'>;
  readonly jobId: string;
  readonly brandId: string;
  readonly model: string;
  readonly batchSize: number;
  readonly now: () => Date;
}): Promise<number> => {
  let embedded = 0;
  for (;;) {
    const batch = await withSystemJob(db, brandId, jobId, (tx) =>
      tx
        .select({ id: knowledgeChunks.id, content: knowledgeChunks.content })
        .from(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.brandId, brandId),
            or(
              isNull(knowledgeChunks.embeddingModel),
              ne(knowledgeChunks.embeddingModel, model),
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

    // Outside any transaction: a provider call takes seconds.
    const { vectors } = await ai.embed({
      brandId,
      feature: 'knowledge.reembed',
      texts: batch.map((chunk) => chunk.content),
    });
    const at = now();
    await withSystemJob(db, brandId, jobId, async (tx) => {
      for (const [index, chunk] of batch.entries()) {
        await tx.execute(sql`
          UPDATE knowledge_chunks
          SET embedding = ${toVectorLiteral(vectors[index] ?? [])}::vector,
              embedding_model = ${model},
              embedded_at = ${at.toISOString()}::timestamptz
          WHERE id = ${chunk.id}`);
      }
    });
    embedded += batch.length;
  }
};

/**
 * The two jobs' share of the `knowledge` queue's processor: null for any
 * other job name, so the help center's processors get theirs.
 */
export const createEmbeddingSpaceProcessor = ({
  db,
  ai,
  settings,
  queue,
  log,
}: {
  readonly db: Db;
  readonly ai: Pick<Ai, 'embed'>;
  readonly settings: EmbeddingSettingsReader;
  readonly queue: ReembedQueue;
  readonly log: JobLogger;
}): ((job: Job) => Promise<void> | null) => {
  return (job) => {
    switch (job.name) {
      case knowledgeConfigureJob.name:
        return configureEmbeddingSpace({ db, settings, queue }).then((outcome) => {
          if (outcome === 'started') {
            log.info({ job: job.name }, 'embedding model changed; re-embedding every chunk');
          }
        });
      case knowledgeReembedJob.name:
        return reembedChunks({ db, ai, jobId: job.id ?? KNOWLEDGE_REEMBED_JOB_ID }).then(
          (result) => {
            log.info({ job: job.name, ...result }, 'knowledge re-embed finished');
          },
        );
      default:
        return null;
    }
  };
};
