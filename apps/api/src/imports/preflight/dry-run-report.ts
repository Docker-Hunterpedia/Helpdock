import { type DbTransaction, importRuns } from '@helpdock/db';
import { importDryRunReportSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type ImportRunRef, importRunRefSchema, lockImportBrand } from '../jobs/claims.js';
import { importDryRunCheckpointSchema } from '../jobs/dry-run-state.js';
import { ImportLoadError } from '../loader/contracts.js';

/** Publish safe counters and bounded issue codes, never leases, source payloads or credentials. */
export async function importDryRunReport(tx: DbTransaction, raw: ImportRunRef) {
  const scope = importRunRefSchema.parse(raw);
  await lockImportBrand(tx, scope.brandId);
  const [run] = await tx
    .select({ report: importRuns.dryRunReport, status: importRuns.status })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (!run?.report) throw new ImportLoadError('target-unavailable');
  const report = importDryRunCheckpointSchema.parse(run.report);
  return importDryRunReportView(report, run.status);
}

export function importDryRunReportView(
  report: z.infer<typeof importDryRunCheckpointSchema>,
  status: typeof importRuns.$inferSelect.status,
) {
  return importDryRunReportSchema.parse({
    phase: report.phase,
    complete: report.phase === 'media_checked' && ['awaiting_mapping', 'ready'].includes(status),
    fingerprint: report.fingerprint,
    defaultCallingCode: report.defaultCallingCode,
    recordsChecked: report.checked,
    mappingsChecked: report.mappingsChecked,
    mediaChecked: report.mediaChecked,
    errors:
      report.issueCount + report.planIssueCount + report.identityIssueCount + report.mediaErrors,
    warnings: report.mediaWarnings + report.recordWarningCount,
    refusedPhones: report.refusedPhones,
    issues: [
      ...report.issues.map((issue) => ({ ...issue, area: 'record', level: 'error' })),
      ...report.recordWarnings.map((issue) => ({ ...issue, area: 'record', level: 'warning' })),
      ...report.planIssues.map((issue) => ({ ...issue, level: 'error' })),
      ...report.identityIssues.map((issue) => ({ ...issue, area: 'identity', level: 'error' })),
      ...report.mediaIssues.map((issue) => ({ ...issue, area: 'media' })),
    ],
  });
}
