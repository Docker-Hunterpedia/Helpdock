import { brands, type DbTransaction, importRuns } from '@helpdock/db';
import {
  enqueueOutbox,
  type ImportWorkPayload,
  importAttachmentsJob,
  importDryRunJob,
  importExtractJob,
  importFinishJob,
  importLoadJob,
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
} from '@helpdock/jobs';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isPendingImportWork, markPendingImportWork } from './jobs/pending-work.js';
import { ImportLoadError } from './loader/contracts.js';

export const IMPORT_WORK_REQUESTED_EVENT = 'import.work_requested';
const stepSchema = z.enum(['extract', 'dry_run', 'load', 'attachments', 'finish']);
const payloadSchema = z.strictObject({
  runId: z.uuid(),
  step: stepSchema,
  notBefore: z.iso.datetime().optional(),
});
const requestSchema = payloadSchema.extend({ brandId: z.uuid() });
const definitions = {
  extract: importExtractJob,
  dry_run: importDryRunJob,
  load: importLoadJob,
  attachments: importAttachmentsJob,
  finish: importFinishJob,
} as const;
const phases = {
  extract: 'extracting',
  dry_run: 'dry_run',
  load: 'loading',
  attachments: 'loading',
  finish: 'finishing',
} as const;
export type ImportWorkStep = z.infer<typeof stepSchema>;
type Step = ImportWorkStep;

/** With `workId`, the run must also still be waiting for that exact request. */
export async function importWorkRunnable(
  tx: DbTransaction,
  brandId: string,
  runId: string,
  step: Step,
  workId?: string,
) {
  const [run] = await tx
    .select({ id: importRuns.id })
    .from(importRuns)
    .innerJoin(brands, eq(brands.id, importRuns.brandId))
    .where(
      and(
        eq(importRuns.brandId, brandId),
        eq(importRuns.id, runId),
        eq(importRuns.status, phases[step]),
        eq(brands.status, 'active'),
        ne(importRuns.sourceAccountKey, '0'.repeat(64)),
        sql`(${importRuns.mode} <> 'delta' OR EXISTS (SELECT 1 FROM import_runs parent
          WHERE parent.id = ${importRuns.parentRunId} AND parent.brand_id = ${importRuns.brandId}
            AND parent.source = ${importRuns.source} AND parent.source_account_key = ${importRuns.sourceAccountKey}
            AND parent.status = 'completed'))`,
        workId === undefined ? undefined : isPendingImportWork(workId),
      ),
    );
  return run !== undefined;
}

/**
 * Start/resume/continuation callers enqueue in the same transaction as their phase checkpoint.
 * The new request supersedes any earlier one still queued for the run.
 */
export async function enqueueImportWork(tx: DbTransaction, request: z.infer<typeof requestSchema>) {
  const { brandId, ...payload } = requestSchema.parse(request);
  if (!(await importWorkRunnable(tx, brandId, payload.runId, payload.step)))
    throw new ImportLoadError('mapping-invalid');
  const workId = await enqueueOutbox(tx, { brandId, event: IMPORT_WORK_REQUESTED_EVENT, payload });
  await markPendingImportWork(tx, {
    brandId,
    runId: payload.runId,
    workId,
    dueAt: payload.notBefore ?? new Date().toISOString(),
  });
  return workId;
}

export interface ImportWorkQueue {
  add(step: Step, payload: ImportWorkPayload, jobId: string, delayMs: number): Promise<void>;
}

/** Outbox redelivery keeps the same BullMQ ID; stale, superseded or paused requests add no work. */
export const createImportWorkHandler =
  (queue: ImportWorkQueue, now = () => new Date()): OutboxEventHandler =>
  async ({ tx, brandId, payload, outboxId }) => {
    const work = payloadSchema.parse(payload);
    if (!(await importWorkRunnable(tx, brandId, work.runId, work.step, outboxId))) return;
    const definition = definitions[work.step];
    const job = definition.schema.parse({ brandId, runId: work.runId, workId: outboxId });
    const delay = work.notBefore ? Math.max(0, Date.parse(work.notBefore) - now().getTime()) : 0;
    await queue.add(work.step, job, `${definition.name}.${work.runId}.${outboxId}`, delay);
  };

export function registerImportEventHandlers(
  queue: ImportWorkQueue,
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
) {
  dispatcher.register(IMPORT_WORK_REQUESTED_EVENT, createImportWorkHandler(queue));
}
