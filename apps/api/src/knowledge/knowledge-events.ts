import { brands, type DbTransaction, knowledgeSources } from '@helpdock/db';
import {
  enqueueOutbox,
  type KnowledgeEmbedPayload,
  type KnowledgeSyncPayload,
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
} from '@helpdock/jobs';
import {
  HC_ACCESS_CHANGED_EVENT,
  HC_ARTICLE_CHANGED_EVENT,
  HC_STRUCTURE_CHANGED_EVENT,
  hcArticleChangedPayloadSchema,
  type KnowledgeSchedule,
} from '@helpdock/schemas';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { syncArticleKnowledge } from './article-knowledge.js';

/**
 * The knowledge base's outbox events (M7-03, DOMAIN-RULES §6), each written
 * in the transaction of the change that causes it:
 *
 * | Event | Written when | Handler |
 * |---|---|---|
 * | `knowledge.sync_requested` | an upload is confirmed, "Sync now", a source is added or its config changes | adds `knowledge.sync` with the outbox row's id |
 * | `knowledge.source_changed` | a source is added, its schedule changes | upserts or removes the source's job scheduler |
 * | `knowledge.source_removed` | a source is removed (its chunks are already gone) | removes its scheduler and its uploaded file |
 *
 * And the `knowledge` subscriber of the help center's three events, which
 * rewrites the chunks of the articles concerned in the event's transaction
 * and adds `knowledge.embed` for the new ones.
 */

export const KNOWLEDGE_SYNC_REQUESTED_EVENT = 'knowledge.sync_requested';
export const KNOWLEDGE_SOURCE_CHANGED_EVENT = 'knowledge.source_changed';
export const KNOWLEDGE_SOURCE_REMOVED_EVENT = 'knowledge.source_removed';
/** This module's name among the subscribers of the `help_center.*` events. */
export const KNOWLEDGE_SUBSCRIBER = 'knowledge';

const syncRequestedSchema = z.object({
  sourceId: z.uuid(),
  trigger: z.enum(['upload', 'manual', 'created', 'changed']),
  actorId: z.string().max(100).optional(),
});
type SyncRequested = z.infer<typeof syncRequestedSchema>;

const sourceChangedSchema = z.object({ sourceId: z.uuid() });
const sourceRemovedSchema = z.object({
  sourceId: z.uuid(),
  objectKey: z.string().max(500).nullable(),
});

export const enqueueSyncRequested = (
  tx: DbTransaction,
  brandId: string,
  payload: SyncRequested,
): Promise<string> =>
  enqueueOutbox(tx, { brandId, event: KNOWLEDGE_SYNC_REQUESTED_EVENT, payload: { ...payload } });

export const enqueueSourceChanged = (
  tx: DbTransaction,
  brandId: string,
  sourceId: string,
): Promise<string> =>
  enqueueOutbox(tx, { brandId, event: KNOWLEDGE_SOURCE_CHANGED_EVENT, payload: { sourceId } });

export const enqueueSourceRemoved = (
  tx: DbTransaction,
  brandId: string,
  payload: z.infer<typeof sourceRemovedSchema>,
): Promise<string> =>
  enqueueOutbox(tx, { brandId, event: KNOWLEDGE_SOURCE_REMOVED_EVENT, payload: { ...payload } });

/** Daily and weekly runs are at 03:00 in the brand's zone; weekly on Sunday. */
export const cronFor = (schedule: KnowledgeSchedule): string | null => {
  switch (schedule) {
    case 'daily':
      return '0 3 * * *';
    case 'weekly':
      return '0 3 * * 0';
    default:
      return null;
  }
};

/** What the handlers reach BullMQ through. The worker passes queues; a test passes a double. */
export interface KnowledgeQueues {
  addSync(payload: KnowledgeSyncPayload, jobId: string): Promise<void>;
  addEmbed(payload: KnowledgeEmbedPayload, jobId: string): Promise<void>;
  /** Upserts the source's repeating sync, or removes it when `cron` is null. */
  schedule(
    sourceId: string,
    cron: { readonly pattern: string; readonly tz: string } | null,
    payload: KnowledgeSyncPayload,
  ): Promise<void>;
}

export interface KnowledgeObjects {
  remove(key: string): Promise<void>;
}

/** Job ids: dots, because BullMQ refuses colons. */
export const knowledgeSyncJobId = (outboxId: string): string => `knowledge.sync.${outboxId}`;
export const knowledgeEmbedJobId = (outboxId: string): string => `knowledge.embed.${outboxId}`;

const scheduleSource = async (
  tx: DbTransaction,
  brandId: string,
  sourceId: string,
  queues: KnowledgeQueues,
): Promise<void> => {
  const [row] = await tx
    .select({ schedule: knowledgeSources.schedule, timezone: brands.timezone })
    .from(knowledgeSources)
    .innerJoin(brands, eq(brands.id, knowledgeSources.brandId))
    .where(eq(knowledgeSources.id, sourceId))
    .limit(1);
  const pattern = row === undefined ? null : cronFor(row.schedule);
  await queues.schedule(
    sourceId,
    pattern === null || row === undefined ? null : { pattern, tz: row.timezone },
    { brandId, sourceId, trigger: 'schedule' },
  );
};

/** Re-registers every daily and weekly source's scheduler, on worker boot (DOMAIN-RULES §10). */
export const scheduleBrandSources = async (
  tx: DbTransaction,
  brandId: string,
  queues: KnowledgeQueues,
): Promise<number> => {
  const sources = await tx.select({ id: knowledgeSources.id }).from(knowledgeSources);
  for (const { id } of sources) {
    await scheduleSource(tx, brandId, id, queues);
  }
  return sources.length;
};

export const createKnowledgeHandlers = (
  queues: KnowledgeQueues,
  objects: KnowledgeObjects,
): Readonly<Record<string, OutboxEventHandler>> => ({
  [KNOWLEDGE_SYNC_REQUESTED_EVENT]: async ({ brandId, payload, outboxId, event, log }) => {
    const request = syncRequestedSchema.parse(payload);
    await queues.addSync(
      {
        brandId,
        sourceId: request.sourceId,
        trigger: request.trigger,
        ...(request.actorId === undefined ? {} : { actorId: request.actorId }),
      },
      knowledgeSyncJobId(outboxId),
    );
    log.info({ event, outboxId, brandId, ...request }, 'knowledge sync queued');
  },
  [KNOWLEDGE_SOURCE_CHANGED_EVENT]: async ({ tx, brandId, payload }) => {
    const { sourceId } = sourceChangedSchema.parse(payload);
    await scheduleSource(tx, brandId, sourceId, queues);
  },
  [KNOWLEDGE_SOURCE_REMOVED_EVENT]: async ({ brandId, payload, outboxId, event, log }) => {
    const { sourceId, objectKey } = sourceRemovedSchema.parse(payload);
    await queues.schedule(sourceId, null, { brandId, sourceId, trigger: 'schedule' });
    if (objectKey !== null) {
      await objects.remove(objectKey);
    }
    log.info({ event, outboxId, brandId, sourceId }, 'knowledge source removed');
  },
});

/**
 * The help center's events, under this module's subscriber name: an article
 * event rewrites that article's chunks; a structure or access change runs the
 * whole brand, which skips every document whose text is unchanged.
 */
export const createArticleKnowledgeHandlers = (
  queues: Pick<KnowledgeQueues, 'addEmbed'>,
): { article: OutboxEventHandler; brand: OutboxEventHandler } => {
  const after = async (
    brandId: string,
    outboxId: string,
    counts: { written: number; removed: number },
  ): Promise<void> => {
    if (counts.written > 0) {
      await queues.addEmbed({ brandId }, knowledgeEmbedJobId(outboxId));
    }
  };
  return {
    article: async ({ tx, brandId, payload, outboxId, event, log }) => {
      const { articleId } = hcArticleChangedPayloadSchema.parse(payload);
      const counts = await syncArticleKnowledge(tx, brandId, [articleId]);
      await after(brandId, outboxId, counts);
      log.info({ event, outboxId, brandId, articleId, ...counts }, 'article knowledge synced');
    },
    brand: async ({ tx, brandId, outboxId, event, log }) => {
      const counts = await syncArticleKnowledge(tx, brandId);
      await after(brandId, outboxId, counts);
      log.info({ event, outboxId, brandId, ...counts }, 'article knowledge synced');
    },
  };
};

/** Called by the worker's start-up, before the worker is created. */
export const registerKnowledgeEventHandlers = (
  queues: KnowledgeQueues,
  objects: KnowledgeObjects,
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  for (const [event, handler] of Object.entries(createKnowledgeHandlers(queues, objects))) {
    dispatcher.register(event, handler);
  }
  const articles = createArticleKnowledgeHandlers(queues);
  dispatcher.register(HC_ARTICLE_CHANGED_EVENT, articles.article, KNOWLEDGE_SUBSCRIBER);
  dispatcher.register(HC_STRUCTURE_CHANGED_EVENT, articles.brand, KNOWLEDGE_SUBSCRIBER);
  dispatcher.register(HC_ACCESS_CHANGED_EVENT, articles.brand, KNOWLEDGE_SUBSCRIBER);
};
