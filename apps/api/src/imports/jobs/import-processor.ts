import { type Db, type DbTransaction, importLog } from '@helpdock/db';
import type { Connector, ConnectorContext } from '@helpdock/importers';
import { ConnectorError, RateLimited } from '@helpdock/importers';
import {
  importAttachmentsJob,
  importDryRunJob,
  importExtractJob,
  importFinishJob,
  importLoadJob,
  parseJobPayloadOrFail,
} from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { z } from 'zod';
import type { ObjectStorage } from '../../media/storage.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { enqueueImportWork, type ImportWorkStep, importWorkRunnable } from '../import-events.js';
import { ImportLoadError } from '../loader/contracts.js';
import { runImportAttachmentBatch } from './attachment-batch.js';
import {
  claimImportRun,
  type ImportClaim,
  ImportClaimLost,
  type ImportRunRef,
  renewImportClaim,
} from './claims.js';
import { continueImportWork, deferImportVendorFailure, failImportWork } from './continuation.js';
import { runImportDryRunBatch } from './dry-run-batch.js';
import { importDryRunCheckpointSchema } from './dry-run-state.js';
import { runImportExtraction } from './extract-run.js';
import { extractionRun } from './extract-state.js';
import { runImportFinishBatch } from './finish-batch.js';
import { runImportLoadBatch } from './load-batch.js';

type Dependencies<C> = {
  db: Db;
  storage: ObjectStorage;
  resolve(scope: ImportRunRef): Promise<{ connector: Connector<C>; context: ConnectorContext<C> }>;
  prepareArticle?: NonNullable<Parameters<typeof runImportLoadBatch>[0]['prepareArticle']>;
};
const definitions = {
  'import.extract': importExtractJob,
  'import.dry_run': importDryRunJob,
  'import.load': importLoadJob,
  'import.attachments': importAttachmentsJob,
  'import.finish': importFinishJob,
} as const;

class ImportExecution<C> {
  constructor(
    readonly deps: Dependencies<C>,
    readonly scope: ImportRunRef,
    readonly jobId: string,
  ) {}
  inRun<T>(work: (tx: DbTransaction) => Promise<T>) {
    return withSystemJob(this.deps.db, this.scope.brandId, this.jobId, work);
  }
  async request(step: ImportWorkStep, delayMs: number) {
    await this.inRun(async (tx) => {
      const run = await extractionRun(tx, this.scope);
      const phase =
        step === 'extract'
          ? 'extracting'
          : step === 'dry_run'
            ? 'dry_run'
            : step === 'finish'
              ? 'finishing'
              : 'loading';
      if (run?.status !== phase) return;
      await enqueueImportWork(tx, {
        ...this.scope,
        step,
        notBefore: new Date(Date.now() + delayMs).toISOString(),
      });
    });
  }
  async execute(name: keyof typeof definitions, claim: ImportClaim) {
    const base = { db: this.deps.db, jobId: this.jobId };
    if (name === 'import.extract') {
      const resolved = await this.deps.resolve(this.scope);
      const result = await runImportExtraction({ ...base, ...resolved, scope: this.scope, claim });
      if (result.state === 'deferred') await this.request('extract', result.retryAfterMs);
      return;
    }
    if (name === 'import.dry_run') {
      const result = await runImportDryRunBatch({ ...base, resolve: this.deps.resolve }, claim);
      if (result.state === 'more')
        await this.inRun((tx) => continueImportWork(tx, { claim, step: 'dry_run' }));
      return;
    }
    if (name === 'import.load') {
      const defaultCallingCode = await this.inRun(async (tx) => {
        await renewImportClaim(tx, claim);
        const run = await extractionRun(tx, this.scope);
        return run?.dryRunReport
          ? importDryRunCheckpointSchema.parse(run.dryRunReport).defaultCallingCode
          : '';
      });
      const result = await runImportLoadBatch(
        {
          ...base,
          ...(this.deps.prepareArticle ? { prepareArticle: this.deps.prepareArticle } : {}),
        },
        { claim, defaultCallingCode },
      );
      if (result.state === 'stopped') return;
      if (result.state === 'article_required')
        return this.inRun((tx) => failImportWork(tx, claim, 'article-preparation-required'));
      await this.inRun((tx) =>
        continueImportWork(tx, { claim, step: result.state === 'more' ? 'load' : 'attachments' }),
      );
      return;
    }
    if (name === 'import.attachments') {
      const result = await runImportAttachmentBatch(
        { ...base, storage: this.deps.storage, ...(await this.deps.resolve(this.scope)) },
        { claim },
      );
      if (result.state === 'stopped') return;
      await this.inRun((tx) =>
        continueImportWork(
          tx,
          result.state === 'finishing'
            ? { claim: result.claim, step: 'finish' }
            : { claim, step: 'attachments', delayMs: 1000 },
        ),
      );
      return;
    }
    const result = await runImportFinishBatch(base, claim);
    if (result.state === 'more')
      await this.inRun((tx) => continueImportWork(tx, { claim, step: 'finish' }));
  }
  async failure(claim: ImportClaim, error: unknown, step: ImportWorkStep) {
    if (error instanceof ImportClaimLost) return;
    if (error instanceof RateLimited) {
      const deadline = new Date(Date.now() + error.retryAfterMs);
      if (!Number.isFinite(deadline.getTime()) || deadline.getUTCFullYear() > 9999)
        return this.inRun((tx) => failImportWork(tx, claim, 'invalid-response'));
      return this.inRun(async (tx) => {
        await continueImportWork(tx, {
          claim,
          step,
          delayMs: error.retryAfterMs,
          preserveFailures: true,
        });
        await tx.insert(importLog).values({
          brandId: claim.brandId,
          runId: claim.runId,
          level: 'warning',
          message: 'import.rate-limited',
        });
      });
    }
    if (error instanceof ConnectorError && error.code === 'vendor-unavailable')
      return this.inRun((tx) => deferImportVendorFailure(tx, { claim, step }));
    const code =
      error instanceof ImportLoadError
        ? error.code
        : error instanceof ConnectorError && error.code === 'credentials-refused'
          ? error.code
          : error instanceof z.ZodError
            ? 'invalid-response'
            : 'execution-failed';
    await this.inRun((tx) => failImportWork(tx, claim, code));
  }
}

/** Queue boundary only: all I/O drivers retain their own fenced transactions. */
export function createImportProcessor<C>(deps: Dependencies<C>) {
  return async (job: Pick<Job, 'name' | 'data' | 'id'>) => {
    if (!Object.hasOwn(definitions, job.name)) throw new Error('import.unknown-job');
    const name = job.name as keyof typeof definitions;
    const scope = parseJobPayloadOrFail(definitions[name], job.data);
    const step = name.slice('import.'.length) as ImportWorkStep;
    const execution = new ImportExecution(deps, scope, job.id ?? name);
    const phase =
      step === 'extract'
        ? 'extracting'
        : step === 'dry_run'
          ? 'dry_run'
          : step === 'finish'
            ? 'finishing'
            : 'loading';
    if (!(await execution.inRun((tx) => importWorkRunnable(tx, scope.brandId, scope.runId, step))))
      return;
    const claim = await execution.inRun((tx) => claimImportRun(tx, { ...scope, phase }));
    if (!claim) return execution.request(step, 30000);
    try {
      await execution.execute(name, claim);
    } catch (error) {
      try {
        await execution.failure(claim, error, step);
      } catch (failure) {
        if (!(failure instanceof ImportClaimLost)) throw new Error('import.execution-failed');
      }
    }
  };
}
