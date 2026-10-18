import type { importRuns } from '@helpdock/db';
import {
  FRESHDESK_IMPORT_ENTITIES,
  importProgressCountsSchema,
  importRunViewSchema,
  importScopeSchema,
  ZOHODESK_IMPORT_ENTITIES,
} from '@helpdock/schemas';

/** Public run state excludes worker leases, errors and credential envelopes. */
export function importRunView(
  run: typeof importRuns.$inferSelect,
  startedBy: { id: string; name: string } | null = null,
) {
  const counts = {
    extracted: importProgressCountsSchema.parse(run.counts.extracted ?? {}),
    loaded: importProgressCountsSchema.parse(run.counts.loaded ?? {}),
    skipped: importProgressCountsSchema.parse(run.counts.skipped ?? {}),
  };
  return importRunViewSchema.parse({
    id: run.id,
    brandId: run.brandId,
    source: run.source,
    mode: run.mode,
    parentRunId: run.parentRunId,
    status: run.status,
    pausedFrom: run.status === 'paused' ? run.pausedFrom : null,
    hasCredentials: run.credentialsEncrypted !== null,
    hasDryRun: run.dryRunReport !== null,
    sourceAccount: run.options.sourceAccountLabel ?? run.options.fileDataset ?? null,
    startedBy,
    scope: importScopeSchema.parse({
      entities:
        run.options.entities ??
        (run.source === 'freshdesk'
          ? [...FRESHDESK_IMPORT_ENTITIES]
          : run.source === 'zohodesk'
            ? [...ZOHODESK_IMPORT_ENTITIES]
            : undefined),
      rebuildAllReports: run.options.rebuildAllReports,
      inventoryMode: run.options.inventoryMode,
      inventoryConfirmed: run.options.inventoryConfirmed,
      useTicketInventory:
        run.source === 'zohodesk'
          ? (run.options.useTicketInventory ?? run.options.inventoryConfirmed === true)
          : undefined,
    }),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    counts,
  });
}
