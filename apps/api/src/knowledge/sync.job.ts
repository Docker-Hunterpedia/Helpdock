import { type Ai, ConnectorAuthError } from '@helpdock/ai';
import { aiSettings, type Db, type DbTransaction, uuidv7 } from '@helpdock/db';
import {
  type JobDefinition,
  type JobLogger,
  type KnowledgeSyncPayload,
  knowledgeEmbedJob,
  knowledgeSyncJob,
  parseJobPayload,
} from '@helpdock/jobs';
import type { KnowledgeLogCode, KnowledgeLogLevel } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { withSystemJob } from '../tenant/system-job.js';
import { syncArticleKnowledge } from './article-knowledge.js';
import { embedPending } from './embed-pending.js';
import { KnowledgeRepository } from './knowledge.repository.js';
import { type LoadOutcome, loadSource, type SourceLoaderDeps } from './load-source.js';
import { prepareDocument } from './prepare.js';

/**
 * `knowledge.sync` and `knowledge.embed` (M7-03), on the `knowledge` queue.
 *
 * ```
 * claim the source (syncing)           a source already syncing is left alone
 * load → for each document:            its own short transaction
 *   screen and chunk → write if changed, log the page or document
 * complete? remove the documents not seen this run
 * embed what is new                    outside any transaction; a failure defers, not fails
 * ok, or failed with the reason        `auth` when the service refused the credential
 * ```
 *
 * A run is not one transaction: a crawl takes minutes and a provider call
 * seconds, and the admin's drawer shows progress as it goes. A failure is
 * recorded on the source and in its log and the job completes, so BullMQ does
 * not retry a revoked token or a blocked address; "Sync now" or the schedule
 * runs it again.
 */

export interface SyncDeps {
  readonly db: Db;
  readonly ai: Pick<Ai, 'embed'>;
  readonly loaders: SourceLoaderDeps;
  readonly log: JobLogger;
  readonly repository?: KnowledgeRepository;
  readonly now?: () => Date;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'the sync failed';

const embedQuietly = async (
  deps: SyncDeps,
  brandId: string,
  jobId: string,
): Promise<{ embedded: number; error: string | null }> => {
  try {
    return {
      embedded: await embedPending({ db: deps.db, ai: deps.ai, brandId, jobId }),
      error: null,
    };
  } catch (error) {
    deps.log.warn({ err: error, brandId }, 'knowledge chunks stored but not embedded');
    return { embedded: 0, error: errorText(error) };
  }
};

export const runSourceSync = async (
  deps: SyncDeps,
  payload: KnowledgeSyncPayload,
  jobId: string,
): Promise<'synced' | 'busy' | 'missing' | 'failed'> => {
  const repository = deps.repository ?? new KnowledgeRepository();
  const now = deps.now ?? (() => new Date());
  const { brandId, sourceId } = payload;
  const inBrand = <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withSystemJob(deps.db, brandId, jobId, fn);
  const runId = uuidv7();
  const log = (
    level: KnowledgeLogLevel,
    code: KnowledgeLogCode,
    params: Record<string, unknown> = {},
  ): Promise<void> =>
    inBrand((tx) => repository.log(tx, { brandId, sourceId, runId, level, code, params }));

  const claimed = await inBrand(async (tx) => {
    const source = await repository.find(tx, sourceId);
    if (source === undefined) {
      return { state: 'missing' as const };
    }
    if (!(await repository.claim(tx, sourceId, now()))) {
      return { state: 'busy' as const };
    }
    const [settings] = await tx
      .select({ injectionFilter: aiSettings.injectionFilter })
      .from(aiSettings)
      .where(eq(aiSettings.brandId, brandId))
      .limit(1);
    return {
      state: 'claimed' as const,
      source,
      injectionFilter: settings?.injectionFilter ?? true,
    };
  });
  if (claimed.state !== 'claimed') {
    deps.log.info({ jobId, brandId, sourceId, state: claimed.state }, 'knowledge sync skipped');
    return claimed.state;
  }
  const { source, injectionFilter } = claimed;
  await log('info', 'sync.started', {
    trigger: payload.trigger,
    ...(payload.actorId === undefined ? {} : { actorId: payload.actorId }),
  });

  let documents = 0;
  let changed = 0;
  let chunks = 0;
  let removed = 0;
  try {
    if (source.kind === 'article') {
      const counts = await inBrand((tx) =>
        syncArticleKnowledge(tx, brandId, undefined, repository),
      );
      changed = counts.written;
      removed = counts.removed;
    } else {
      const seen: string[] = [];
      const loader = loadSource(source, deps.loaders);
      let step = await loader.next();
      while (step.done !== true) {
        const event = step.value;
        if (event.type === 'log') {
          await log(event.level, event.code, event.params);
        } else if (event.type === 'progress') {
          await inBrand((tx) =>
            repository.update(tx, sourceId, {
              progressDone: event.done,
              progressTotal: event.total,
            }),
          );
        } else {
          const prepared = prepareDocument(event.document, { injectionFilter });
          const outcome = await inBrand((tx) =>
            repository.writeDocument(tx, {
              brandId,
              sourceId,
              externalId: event.externalId,
              title: event.document.title,
              url: event.url,
              articleId: null,
              contentHash: prepared.contentHash,
              visibility: source.visibility,
              chunks: prepared.chunks,
            }),
          );
          seen.push(event.externalId);
          documents += 1;
          chunks += prepared.chunks.length;
          if (outcome === 'written') {
            changed += 1;
          }
          await log('info', event.code, {
            url: event.url,
            title: event.document.title,
            chunks: prepared.chunks.length,
            changed: outcome === 'written',
          });
          if (prepared.findings.length > 0) {
            await log('warn', 'injection.stripped', {
              url: event.url,
              title: event.document.title,
              chunks: prepared.suspiciousChunks,
              rules: prepared.findings,
            });
          }
        }
        step = await loader.next();
      }
      if ((step.value as LoadOutcome).complete) {
        removed = await inBrand((tx) => repository.removeDocumentsExcept(tx, sourceId, seen));
        if (removed > 0) {
          await log('info', 'documents.removed', { count: removed });
        }
      }
    }
  } catch (error) {
    const auth = error instanceof ConnectorAuthError;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    await inBrand((tx) =>
      repository.update(tx, sourceId, {
        syncStatus: 'failed',
        syncStartedAt: null,
        lastError: errorText(error),
        lastErrorCode: auth ? 'auth' : null,
      }),
    );
    await log('error', code === 'file.rejected' ? 'file.rejected' : 'sync.failed', {
      reason: errorText(error),
      auth,
    });
    deps.log.warn({ jobId, brandId, sourceId, err: error }, 'knowledge sync failed');
    return 'failed';
  }

  const embedding = await embedQuietly(deps, brandId, jobId);
  if (embedding.error !== null) {
    await log('warn', 'embedding.deferred', { reason: embedding.error });
  }
  await inBrand((tx) =>
    repository.update(tx, sourceId, {
      syncStatus: 'ok',
      syncStartedAt: null,
      lastSyncedAt: now(),
      lastError: null,
      lastErrorCode: null,
    }),
  );
  await log('done', 'sync.finished', {
    documents,
    changed,
    chunks,
    removed,
    embedded: embedding.embedded,
  });
  return 'synced';
};

const payloadOf = <TName extends string, T>(definition: JobDefinition<TName, T>, job: Job): T => {
  try {
    return parseJobPayload(definition, job.data);
  } catch (error) {
    throw new UnrecoverableError(errorText(error));
  }
};

/** The two jobs' share of the `knowledge` queue's processor; null for any other job. */
export const createKnowledgeSyncProcessor = (
  deps: SyncDeps,
): ((job: Job) => Promise<void> | null) => {
  return (job) => {
    const jobId = job.id ?? job.name;
    switch (job.name) {
      case knowledgeSyncJob.name:
        return runSourceSync(deps, payloadOf(knowledgeSyncJob, job), jobId).then(() => undefined);
      case knowledgeEmbedJob.name: {
        const { brandId } = payloadOf(knowledgeEmbedJob, job);
        return embedPending({ db: deps.db, ai: deps.ai, brandId, jobId }).then((embedded) => {
          deps.log.info({ job: job.name, brandId, embedded }, 'knowledge chunks embedded');
        });
      }
      default:
        return null;
    }
  };
};
