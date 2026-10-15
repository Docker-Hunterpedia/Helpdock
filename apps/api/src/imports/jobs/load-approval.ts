import { type DbTransaction, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import { importDryRunReviewToken } from '../preflight/dry-run-report.js';
import { type ImportClaim, renewImportClaim } from './claims.js';
import { importDestinationFingerprint } from './destination-fingerprint.js';
import { importDryRunCheckpointSchema, storeImportDryRunCheckpoint } from './dry-run-state.js';
import { extractionRun } from './extract-state.js';
import { importInputFingerprint } from './input-fingerprint.js';

const receiptSchema = z.object({
  approvedReviewToken: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  loadApprovalChecked: z.boolean().default(false),
});

/** Check queued public approvals before the first domain write; own later writes change the snapshot. */
export async function prepareApprovedImportLoad(
  tx: DbTransaction,
  claim: ImportClaim,
  defaultCallingCode: string,
) {
  await renewImportClaim(tx, claim);
  const run = await extractionRun(tx, claim);
  if (!run) throw new ImportLoadError('target-unavailable');
  const receipt = receiptSchema.parse(run.counts);
  // Internal/system load drivers predate the public approval route. Public starts always carry a receipt.
  if (!receipt.approvedReviewToken) return true;
  const checkpoint = importDryRunCheckpointSchema.parse(run.dryRunReport);
  if (checkpoint.defaultCallingCode !== defaultCallingCode)
    throw new ImportLoadError('mapping-invalid');
  if (receipt.loadApprovalChecked) return true;
  const scope = { brandId: claim.brandId, runId: claim.runId };
  if (
    checkpoint.phase !== 'media_checked' ||
    importDryRunReviewToken(checkpoint) !== receipt.approvedReviewToken ||
    checkpoint.fingerprint !== (await importInputFingerprint(tx, scope)) ||
    checkpoint.destinationFingerprint !== (await importDestinationFingerprint(tx, scope))
  ) {
    await storeImportDryRunCheckpoint(tx, claim, { ...checkpoint, phase: 'invalidated' });
    return false;
  }
  await tx
    .update(importRuns)
    .set({ counts: { ...run.counts, loadApprovalChecked: true } })
    .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
  return true;
}
