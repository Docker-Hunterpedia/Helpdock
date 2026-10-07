import { type Ai, ConnectorAuthError } from '@helpdock/ai';
import { type Db, type DbTransaction, type KnowledgeSource, uuidv7 } from '@helpdock/db';
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
import { withSystemJob } from '../tenant/system-job.js';
import { injectionFilterOf, syncArticleKnowledge } from './article-knowledge.js';
import { embedPending } from './embed-pending.js';
import { KnowledgeRepository } from './knowledge.repository.js';
import {
  type LoadEvent,
  loadSource,
  SourceLoadError,
  type SourceLoaderDeps,
} from './load-source.js';
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

interface SyncCounts {
  documents: number;
  changed: number;
  chunks: number;
  removed: number;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'the sync failed';

/** One run of one source: where it writes, and its log. */
class SyncRun {
  readonly #deps: SyncDeps;
  readonly #repository: KnowledgeRepository;
  readonly #brandId: string;
  readonly #sourceId: string;
  readonly #jobId: string;
  readonly #runId = uuidv7();

  constructor(deps: SyncDeps, payload: KnowledgeSyncPayload, jobId: string) {
    this.#deps = deps;
    this.#repository = deps.repository ?? new KnowledgeRepository();
    this.#brandId = payload.brandId;
    this.#sourceId = payload.sourceId;
    this.#jobId = jobId;
  }

  inBrand<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withSystemJob(this.#deps.db, this.#brandId, this.#jobId, fn);
  }

  log(
    level: KnowledgeLogLevel,
    code: KnowledgeLogCode,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    return this.inBrand((tx) =>
      this.#repository.log(tx, {
        brandId: this.#brandId,
        sourceId: this.#sourceId,
        runId: this.#runId,
        level,
        code,
        params,
      }),
    );
  }

  setStatus(changes: Parameters<KnowledgeRepository['update']>[2]): Promise<void> {
    return this.inBrand((tx) => this.#repository.update(tx, this.#sourceId, changes));
  }

  /** The source, claimed for this run, with the brand's injection filter; or why not. */
  claim(
    now: Date,
  ): Promise<
    | { readonly state: 'missing' | 'busy' }
    | { readonly state: 'claimed'; readonly source: KnowledgeSource; readonly filter: boolean }
  > {
    return this.inBrand(async (tx) => {
      const source = await this.#repository.find(tx, this.#sourceId);
      if (source === undefined) {
        return { state: 'missing' };
      }
      if (!(await this.#repository.claim(tx, this.#sourceId, now))) {
        return { state: 'busy' };
      }
      return { state: 'claimed', source, filter: await injectionFilterOf(tx, this.#brandId) };
    });
  }

  async #store(
    source: KnowledgeSource,
    event: Extract<LoadEvent, { type: 'document' }>,
    injectionFilter: boolean,
  ): Promise<{ chunks: number; changed: boolean }> {
    const prepared = prepareDocument(event.document, { injectionFilter });
    const outcome = await this.inBrand((tx) =>
      this.#repository.writeDocument(tx, {
        brandId: this.#brandId,
        sourceId: this.#sourceId,
        externalId: event.externalId,
        title: event.document.title,
        url: event.url,
        articleId: null,
        contentHash: prepared.contentHash,
        visibility: source.visibility,
        chunks: prepared.chunks,
      }),
    );
    const where = { url: event.url, title: event.document.title };
    await this.log('info', event.code, {
      ...where,
      chunks: prepared.chunks.length,
      changed: outcome === 'written',
    });
    if (prepared.findings.length > 0) {
      await this.log('warn', 'injection.stripped', {
        ...where,
        chunks: prepared.suspiciousChunks,
        rules: prepared.findings,
      });
    }
    return { chunks: prepared.chunks.length, changed: outcome === 'written' };
  }

  /** Every document of a file, crawl or connector source, then what it no longer has. */
  async ingest(source: KnowledgeSource, injectionFilter: boolean): Promise<SyncCounts> {
    const counts: SyncCounts = { documents: 0, changed: 0, chunks: 0, removed: 0 };
    const seen: string[] = [];
    const loader = loadSource(source, this.#deps.loaders);
    let step = await loader.next();
    while (step.done !== true) {
      const event = step.value;
      if (event.type === 'log') {
        await this.log(event.level, event.code, event.params);
      } else if (event.type === 'progress') {
        await this.setStatus({ progressDone: event.done, progressTotal: event.total });
      } else {
        const stored = await this.#store(source, event, injectionFilter);
        seen.push(event.externalId);
        counts.documents += 1;
        counts.chunks += stored.chunks;
        counts.changed += stored.changed ? 1 : 0;
      }
      step = await loader.next();
    }
    if (step.value.complete) {
      counts.removed = await this.inBrand((tx) =>
        this.#repository.removeDocumentsExcept(tx, this.#sourceId, seen),
      );
      if (counts.removed > 0) {
        await this.log('info', 'documents.removed', { count: counts.removed });
      }
    }
    return counts;
  }

  /** The help center source: every published article of the brand, reconciled. */
  async ingestArticles(): Promise<SyncCounts> {
    const counts = await this.inBrand((tx) =>
      syncArticleKnowledge(tx, this.#brandId, undefined, this.#repository),
    );
    return {
      documents: counts.written,
      changed: counts.written,
      chunks: 0,
      removed: counts.removed,
    };
  }

  /** New chunks into the target model; a failure leaves them for the next run, logged. */
  async embed(): Promise<number> {
    try {
      return await embedPending({
        db: this.#deps.db,
        ai: this.#deps.ai,
        brandId: this.#brandId,
        jobId: this.#jobId,
      });
    } catch (error) {
      this.#deps.log.warn({ err: error, brandId: this.#brandId }, 'knowledge chunks not embedded');
      await this.log('warn', 'embedding.deferred', { reason: errorText(error) });
      return 0;
    }
  }

  async fail(error: unknown): Promise<void> {
    const auth = error instanceof ConnectorAuthError;
    await this.setStatus({
      syncStatus: 'failed',
      syncStartedAt: null,
      lastError: errorText(error),
      lastErrorCode: auth ? 'auth' : null,
    });
    await this.log('error', error instanceof SourceLoadError ? error.code : 'sync.failed', {
      reason: errorText(error),
      auth,
    });
    this.#deps.log.warn(
      { jobId: this.#jobId, brandId: this.#brandId, sourceId: this.#sourceId, err: error },
      'knowledge sync failed',
    );
  }
}

export const runSourceSync = async (
  deps: SyncDeps,
  payload: KnowledgeSyncPayload,
  jobId: string,
): Promise<'synced' | 'busy' | 'missing' | 'failed'> => {
  const now = deps.now ?? (() => new Date());
  const run = new SyncRun(deps, payload, jobId);
  const claimed = await run.claim(now());
  if (claimed.state !== 'claimed') {
    deps.log.info({ jobId, ...payload, state: claimed.state }, 'knowledge sync skipped');
    return claimed.state;
  }
  await run.log('info', 'sync.started', {
    trigger: payload.trigger,
    ...(payload.actorId === undefined ? {} : { actorId: payload.actorId }),
  });

  let counts: SyncCounts;
  try {
    counts =
      claimed.source.kind === 'article'
        ? await run.ingestArticles()
        : await run.ingest(claimed.source, claimed.filter);
  } catch (error) {
    await run.fail(error);
    return 'failed';
  }

  const embedded = await run.embed();
  await run.setStatus({
    syncStatus: 'ok',
    syncStartedAt: null,
    lastSyncedAt: now(),
    lastError: null,
    lastErrorCode: null,
  });
  await run.log('done', 'sync.finished', { ...counts, embedded });
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
