import type { importRuns } from '@helpdock/db';
import {
  importProgressCountsSchema,
  importRunViewSchema,
  importScopeSchema,
} from '@helpdock/schemas';

/** Only public counters are serialized; worker leases, errors and credential envelopes stay internal. */
export function importRunView(run: typeof importRuns.$inferSelect) {
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
    hasCredentials: run.credentialsEncrypted !== null,
    scope: importScopeSchema.parse({
      entities: run.options.entities,
      rebuildAllReports: run.options.rebuildAllReports,
    }),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    counts,
  });
}
