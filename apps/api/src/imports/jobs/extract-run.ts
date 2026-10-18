import { type Db, type DbTransaction, importLog, importRuns } from '@helpdock/db';
import {
  type Connector,
  type ConnectorContext,
  ConnectorError,
  type ImportCursor,
  type ImportPage,
  RateLimited,
} from '@helpdock/importers';
import { importEntitySchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import {
  claimImportRun,
  type ImportClaim,
  ImportClaimLost,
  type ImportRunRef,
  importRunRefSchema,
  renewImportClaim,
} from './claims.js';
import { importConnectorLogSchema } from './connector-log.js';
import {
  discardUnavailableTicket,
  extractionCheckpointsSchema,
  storeImportPage,
} from './extract-page.js';
import {
  completeExtraction,
  deferExtraction,
  extractionRun,
  failExtraction,
  releaseExtraction,
} from './extract-state.js';
import { importExtractionPageCache } from './page-cache.js';
import { extractionRetry } from './retry-state.js';

type ExtractionOutcome =
  | { state: 'stopped' | 'awaiting_mapping' | 'failed' }
  | { state: 'deferred'; retryAfterMs: number };
type ExtractionDependencies<Credentials> = {
  db: Db;
  connector: Connector<Credentials>;
  context: ConnectorContext<Credentials>;
  scope: ImportRunRef;
  jobId: string;
  claim?: ImportClaim;
};

class ExtractionSession<Credentials> {
  readonly scope: ImportRunRef;
  constructor(readonly deps: ExtractionDependencies<Credentials>) {
    this.scope = importRunRefSchema.parse(deps.scope);
  }
  inRun<T>(work: (tx: DbTransaction) => Promise<T>) {
    return withSystemJob(this.deps.db, this.scope.brandId, this.deps.jobId, work);
  }
  context(claim: ImportClaim): ConnectorContext<Credentials> {
    return {
      ...this.deps.context,
      http: this.deps.context.http.withPageCache(
        importExtractionPageCache(this.deps.db, claim, this.deps.jobId),
      ),
      credentials: this.deps.connector.credentialsSchema.parse(this.deps.context.credentials),
      log: async (entry) => {
        const parsed = importConnectorLogSchema.parse(entry);
        await this.inRun(async (tx) => {
          await renewImportClaim(tx, claim);
          await tx.insert(importLog).values({ ...parsed, ...this.scope });
          if (
            parsed.entity === 'ticket' &&
            parsed.externalId &&
            parsed.message === 'import.record-unavailable'
          )
            await discardUnavailableTicket(tx, claim, parsed.externalId);
        });
      },
    };
  }
  async delta(run: typeof importRuns.$inferSelect): Promise<{
    since: Date | undefined;
    cursors: z.infer<typeof extractionCheckpointsSchema>;
  }> {
    if (run.mode !== 'delta') return { since: undefined, cursors: {} };
    const [parent] = await this.inRun((tx) =>
      tx
        .select({ startedAt: importRuns.startedAt, cursors: importRuns.cursors })
        .from(importRuns)
        .where(
          and(
            eq(importRuns.id, run.parentRunId ?? ''),
            eq(importRuns.brandId, run.brandId),
            eq(importRuns.source, run.source),
            eq(importRuns.sourceAccountKey, run.sourceAccountKey),
            eq(importRuns.status, 'completed'),
          ),
        ),
    );
    if (!parent?.startedAt) throw new ConnectorError('invalid-response');
    return {
      since: new Date(parent.startedAt.getTime() - 3600000),
      cursors: extractionCheckpointsSchema.parse(parent.cursors),
    };
  }
  async *pages(
    claim: ImportClaim,
    context: ConnectorContext<Credentials>,
    scope: {
      entity: z.infer<typeof importEntitySchema>;
      cursor: ImportCursor | null;
      since: Date | undefined;
    },
  ): AsyncGenerator<ImportPage> {
    const iterator = this.deps.connector
      .extract(context, scope.entity, scope.cursor, scope.since)
      [Symbol.asyncIterator]();
    try {
      while (true) {
        context.signal.throwIfAborted();
        await this.inRun((tx) => renewImportClaim(tx, claim));
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  }
  async entity(
    claim: ImportClaim,
    context: ConnectorContext<Credentials>,
    entity: z.infer<typeof importEntitySchema>,
    delta: { since: Date | undefined; deltaCursor: ImportCursor | undefined },
  ): Promise<void> {
    const run = await this.inRun(async (tx) => {
      await renewImportClaim(tx, claim);
      return extractionRun(tx, this.scope);
    });
    if (!run) throw new ImportClaimLost();
    const previous = extractionCheckpointsSchema.parse(run.cursors)[entity];
    if (previous?.done) return;
    context.signal.throwIfAborted();
    let done = false;
    for await (const page of this.pages(claim, context, {
      entity,
      cursor: previous?.cursor ?? delta.deltaCursor ?? null,
      since: delta.since,
    })) {
      context.signal.throwIfAborted();
      if (done) throw new ConnectorError('invalid-response');
      await this.inRun((tx) => storeImportPage(tx, claim, entity, page));
      if (page.cursor === null) {
        done = true;
        break;
      }
    }
    if (!done) throw new ConnectorError('invalid-response');
  }
  async delayFailure(
    claim: ImportClaim,
    error: RateLimited | ConnectorError,
  ): Promise<ExtractionOutcome> {
    const delay = error instanceof RateLimited ? error.retryAfterMs : 5000;
    const deadline = new Date(Date.now() + delay);
    if (
      !Number.isFinite(deadline.getTime()) ||
      !z.iso.datetime().safeParse(deadline.toISOString()).success
    ) {
      await this.inRun((tx) => failExtraction(tx, { claim, code: 'invalid-response' }));
      return { state: 'failed' };
    }
    const failed = await this.inRun((tx) =>
      deferExtraction(tx, {
        claim,
        delayMs: delay,
        code: error instanceof RateLimited ? 'import.rate-limited' : 'import.vendor-unavailable',
      }),
    );
    return failed ? { state: 'failed' } : { state: 'deferred', retryAfterMs: delay };
  }
  async failure(claim: ImportClaim, error: unknown): Promise<ExtractionOutcome> {
    if (error instanceof ImportClaimLost) return { state: 'stopped' };
    if (this.deps.context.signal.aborted) {
      await this.inRun((tx) => releaseExtraction(tx, claim));
      return { state: 'deferred', retryAfterMs: 1000 };
    }
    if (
      error instanceof RateLimited ||
      (error instanceof ConnectorError && error.code === 'vendor-unavailable')
    ) {
      return this.delayFailure(claim, error);
    }
    if (error instanceof ConnectorError || error instanceof z.ZodError) {
      await this.inRun((tx) =>
        failExtraction(tx, {
          claim,
          code: error instanceof z.ZodError ? 'invalid-response' : error.code,
        }),
      );
      return { state: 'failed' };
    }
    // The adapter is a trust boundary: opaque failures end the run without exposing its error text.
    await this.inRun((tx) => failExtraction(tx, { claim, code: 'execution-failed' }));
    return { state: 'failed' };
  }
}

/** Vendor HTTP runs outside transactions; every yielded page commits under the current claim. */
export async function runImportExtraction<Credentials>(
  deps: ExtractionDependencies<Credentials>,
): Promise<ExtractionOutcome> {
  const session = new ExtractionSession(deps);
  const run = await session.inRun((tx) => extractionRun(tx, session.scope));
  if (run?.status !== 'extracting') return { state: 'stopped' };
  const retryAt = extractionRetry(run.counts).retryAt;
  const delay = retryAt ? Date.parse(retryAt) - Date.now() : 0;
  if (delay > 0) return { state: 'deferred', retryAfterMs: delay };
  const claim =
    deps.claim ??
    (await session.inRun((tx) => claimImportRun(tx, { ...session.scope, phase: 'extracting' })));
  if (
    claim &&
    (claim.phase !== 'extracting' ||
      claim.brandId !== session.scope.brandId ||
      claim.runId !== session.scope.runId)
  )
    throw new ImportClaimLost();
  if (!claim) return { state: 'deferred', retryAfterMs: 30000 };
  try {
    if (run.source !== deps.connector.source) throw new ConnectorError('invalid-response');
    const available = z
      .array(importEntitySchema)
      .min(1)
      .max(importEntitySchema.options.length)
      .parse(deps.connector.entities);
    const selected = z
      .array(importEntitySchema)
      .min(1)
      .max(importEntitySchema.options.length)
      .parse(run.options.entities ?? available);
    if (
      new Set(selected).size !== selected.length ||
      selected.some((entity) => !available.includes(entity))
    )
      throw new ConnectorError('invalid-response');
    const context = session.context(claim);
    const delta = await session.delta(run);
    for (const entity of selected)
      await session.entity(claim, context, entity, {
        since: delta.since,
        deltaCursor: delta.cursors[entity]?.deltaCursor,
      });
    await session.inRun((tx) => completeExtraction(tx, claim));
    return { state: 'awaiting_mapping' };
  } catch (error) {
    try {
      return await session.failure(claim, error);
    } catch (failure) {
      if (failure instanceof ImportClaimLost) return { state: 'stopped' };
      throw failure;
    }
  }
}
