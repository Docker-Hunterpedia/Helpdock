import { type Db, type DbTransaction, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import { ImportLoadError } from '../loader/contracts.js';
import {
  importMappingPlanIssueSchema,
  validateImportMappingPlan,
} from '../preflight/mapping-plan.js';
import {
  importRecordCursorSchema,
  importRecordIssueSchema,
  validateImportRecordPage,
} from '../preflight/record-page.js';
import { ImportClaimLost, importClaimSchema, renewImportClaim } from './claims.js';
import { importInputFingerprint } from './input-fingerprint.js';

const callingCodeSchema = z.string().regex(/^\d{0,4}$/);
const requestSchema = z.strictObject({
  claim: importClaimSchema,
  batchSize: z.int().min(1).max(50).default(25),
  defaultCallingCode: callingCodeSchema.default(''),
});
const checkpointSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(['records', 'records_checked', 'plans_checked', 'invalidated']),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  defaultCallingCode: callingCodeSchema,
  after: importRecordCursorSchema.nullable(),
  checked: z.int().nonnegative(),
  issueCount: z.int().nonnegative(),
  issues: z.array(importRecordIssueSchema).max(100),
  mappingsChecked: z.int().nonnegative().default(0),
  planIssueCount: z.int().nonnegative().default(0),
  planIssues: z.array(importMappingPlanIssueSchema).max(100).default([]),
});
const resultSchema = z.strictObject({
  state: z.enum(['more', 'records_checked', 'plans_checked', 'invalidated', 'stopped']),
});

async function storeCheckpoint(
  tx: DbTransaction,
  claim: z.infer<typeof importClaimSchema>,
  checkpoint: z.infer<typeof checkpointSchema>,
) {
  await tx
    .update(importRuns)
    .set({
      dryRunReport: checkpoint,
      ...(checkpoint.phase === 'invalidated'
        ? { status: 'awaiting_mapping' as const, claimToken: null, claimedAt: null }
        : {}),
    })
    .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
}

/** Atomic scan/checkpoint commits; plans_checked still requires identity/media validation and approval. */
export async function runImportDryRunRecordBatch(
  deps: { db: Db; jobId: string },
  raw: z.input<typeof requestSchema>,
) {
  const request = requestSchema.parse(raw);
  const { claim } = request;
  const scope = { brandId: claim.brandId, runId: claim.runId };
  if (claim.phase !== 'dry_run') throw new ImportClaimLost();
  try {
    return await withSystemJob(deps.db, claim.brandId, deps.jobId, async (tx) => {
      await renewImportClaim(tx, claim);
      const predicate = and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId));
      const [run] = await tx.select().from(importRuns).where(predicate);
      if (!run) throw new ImportClaimLost();
      const prior = checkpointSchema.parse(
        run.dryRunReport ?? {
          version: 1,
          phase: 'records',
          fingerprint: await importInputFingerprint(tx, scope),
          defaultCallingCode: request.defaultCallingCode,
          after: null,
          checked: 0,
          issueCount: 0,
          issues: [],
        },
      );
      if (prior.defaultCallingCode !== request.defaultCallingCode)
        throw new ImportLoadError('mapping-invalid');
      if (prior.phase === 'records_checked') {
        const plan = await validateImportMappingPlan(tx, { ...scope, source: run.source });
        const phase =
          (await importInputFingerprint(tx, scope)) === prior.fingerprint
            ? 'plans_checked'
            : 'invalidated';
        const checkpoint = checkpointSchema.parse({
          ...prior,
          phase,
          mappingsChecked: plan.checked,
          planIssueCount: plan.issueCount,
          planIssues: plan.issues,
        });
        await storeCheckpoint(tx, claim, checkpoint);
        return resultSchema.parse({ state: phase });
      }
      if (prior.phase !== 'records') return resultSchema.parse({ state: prior.phase });
      const page = await validateImportRecordPage(tx, {
        brandId: claim.brandId,
        runId: claim.runId,
        source: run.source,
        after: prior.after,
        batchSize: request.batchSize,
        defaultCallingCode: prior.defaultCallingCode,
      });
      const phase = page.next
        ? 'records'
        : (await importInputFingerprint(tx, scope)) === prior.fingerprint
          ? 'records_checked'
          : 'invalidated';
      const checkpoint = checkpointSchema.parse({
        ...prior,
        phase,
        after: page.next,
        checked: prior.checked + page.checked,
        issueCount: prior.issueCount + page.issueCount,
        issues: [...prior.issues, ...page.issues].slice(0, 100),
      });
      await storeCheckpoint(tx, claim, checkpoint);
      return resultSchema.parse({ state: phase === 'records' ? 'more' : phase });
    });
  } catch (error) {
    if (!(error instanceof ImportClaimLost)) throw error;
    return resultSchema.parse({ state: 'stopped' });
  }
}
