import { brands, type DbTransaction, importLog, importRuns } from '@helpdock/db';
import { parseBrandSettings } from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RollupRepository } from '../../reports/rollup.repository.js';
import { localDay } from '../../reports/rollup-window.js';
import { ImportLoadError } from '../loader/contracts.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  renewImportClaim,
} from './claims.js';
import {
  importReportProgressSchema,
  importReportWindow,
  nextImportReportChunk,
} from './report-window.js';

const boundsSchema = z
  .array(z.object({ first_day: z.iso.date().nullable(), missing: z.boolean() }))
  .length(1);
const resultSchema = z.strictObject({
  state: z.enum(['more', 'reports_complete']),
  progress: importReportProgressSchema,
});

async function initialProgress(
  tx: DbTransaction,
  claim: ImportClaim,
  timezone: string,
  countReopens: boolean,
  options: Record<string, unknown>,
  now: Date,
) {
  const [bounds] = boundsSchema.parse(
    await tx.execute(sql`
    SELECT ((min(t.created_at) AT TIME ZONE ${timezone})::date)::text AS first_day,
      coalesce(bool_or(t.id IS NULL), false) AS missing
    FROM import_records r LEFT JOIN tickets t ON t.id = r.helpdock_id AND t.brand_id = r.brand_id
    WHERE r.brand_id = ${claim.brandId}::uuid AND r.run_id = ${claim.runId}::uuid
      AND r.entity = 'ticket' AND r.status = 'loaded'
  `),
  );
  if (!bounds) throw new ImportClaimLost();
  if (bounds.missing) throw new ImportLoadError('target-unavailable');
  const { rebuildAllReports } = z
    .object({ rebuildAllReports: z.boolean().default(false) })
    .parse(options);
  const window = importReportWindow({
    firstDay: bounds.first_day,
    today: localDay(now, timezone),
    rebuildAllReports,
  });
  const progress = importReportProgressSchema.parse({
    ...window,
    next: window.from,
    timezone,
    countReopens,
  });
  if (progress.clipped)
    await tx.insert(importLog).values({
      brandId: claim.brandId,
      runId: claim.runId,
      level: 'warning',
      entity: 'ticket',
      message: 'import.reports.history-clipped',
    });
  return progress;
}

/** One local 31-day range and its cursor commit together; an interrupted chunk is safely rebuilt. */
export async function rebuildImportReportsBatch(
  tx: DbTransaction,
  request: ImportClaim,
  now = new Date(),
) {
  const claim = importClaimSchema.parse(request);
  if (claim.phase !== 'finishing') throw new ImportClaimLost();
  await renewImportClaim(tx, claim, now);
  const [run] = await tx
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
  const [brand] = await tx
    .select({ timezone: brands.timezone, settings: brands.settings })
    .from(brands)
    .where(eq(brands.id, claim.brandId));
  if (!run || !brand) throw new ImportClaimLost();
  const countReopens = parseBrandSettings(brand.settings).slaCountReopens;
  const existing = run.counts.importReports;
  const progress =
    existing === undefined
      ? await initialProgress(tx, claim, brand.timezone, countReopens, run.options, now)
      : importReportProgressSchema.parse(existing);
  // Changing the report grain mid-backfill would mix incompatible local days or SLA metrics.
  if (progress.timezone !== brand.timezone || progress.countReopens !== countReopens)
    throw new ImportLoadError('mapping-invalid');
  const chunk = nextImportReportChunk(progress);
  if (chunk)
    await new RollupRepository().rebuild(tx, {
      brandId: claim.brandId,
      timezone: progress.timezone,
      countReopens: progress.countReopens,
      range: chunk.range,
    });
  const updated = { ...progress, next: chunk?.next ?? null };
  if (existing === undefined || chunk)
    await tx
      .update(importRuns)
      .set({ counts: { ...run.counts, importReports: updated } })
      .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
  return resultSchema.parse({
    state: updated.next === null ? 'reports_complete' : 'more',
    progress: updated,
  });
}
