import { type DbTransaction, importRuns } from '@helpdock/db';
import { type ImportStartRequest, importStartRequestSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { importDryRunReportView } from '../preflight/dry-run-report.js';
import { type ImportRunRef, importRunRefSchema, lockImportBrand } from './claims.js';
import { importDestinationFingerprint } from './destination-fingerprint.js';
import { importDryRunCheckpointSchema } from './dry-run-state.js';
import { importInputFingerprint } from './input-fingerprint.js';

export class ImportApprovalError extends Error {
  constructor(
    readonly code:
      | 'run-not-found'
      | 'phase-invalid'
      | 'dry-run-stale'
      | 'dry-run-errors'
      | 'warnings-not-acknowledged',
  ) {
    super(`import.${code}`);
    this.name = 'ImportApprovalError';
  }
}

export function reviewedImportCheckpoint(
  run: Pick<typeof importRuns.$inferSelect, 'status' | 'credentialsEncrypted' | 'dryRunReport'>,
  request: ImportStartRequest,
) {
  const input = importStartRequestSchema.parse(request);
  const parsed = importDryRunCheckpointSchema.safeParse(run.dryRunReport);
  if (
    !['awaiting_mapping', 'ready'].includes(run.status) ||
    !run.credentialsEncrypted ||
    !parsed.success
  )
    throw new ImportApprovalError('phase-invalid');
  const report = importDryRunReportView(parsed.data, run.status);
  if (
    !report.complete ||
    !parsed.data.destinationFingerprint ||
    report.reviewToken !== input.reviewToken
  )
    throw new ImportApprovalError('dry-run-stale');
  if (report.errors) throw new ImportApprovalError('dry-run-errors');
  if (report.warnings && !input.acknowledgeWarnings)
    throw new ImportApprovalError('warnings-not-acknowledged');
  return parsed.data;
}

/** A completed report is only a snapshot; recheck source and destination before authorizing loading. */
export async function requireCurrentImportApproval(
  tx: DbTransaction,
  raw: ImportRunRef & ImportStartRequest,
) {
  const request = importRunRefSchema.extend(importStartRequestSchema.shape).parse(raw);
  const scope = { brandId: request.brandId, runId: request.runId };
  await lockImportBrand(tx, scope.brandId);
  const [run] = await tx
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (!run) throw new ImportApprovalError('run-not-found');
  const checkpoint = reviewedImportCheckpoint(run, {
    reviewToken: request.reviewToken,
    acknowledgeWarnings: request.acknowledgeWarnings,
  });
  if (
    checkpoint.fingerprint !== (await importInputFingerprint(tx, scope)) ||
    checkpoint.destinationFingerprint !== (await importDestinationFingerprint(tx, scope))
  )
    throw new ImportApprovalError('dry-run-stale');
}
