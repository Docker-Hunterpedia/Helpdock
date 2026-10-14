import { type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  renewImportClaim,
} from './claims.js';
import { loadPreparedStagedRecord } from './load-prepared-record.js';

const selectedSchema = z.array(z.object({ id: z.uuid() })).max(1);

/** Select a ready pre-media record in SQL, so blocked rows do not hide later ready parents. */
async function readyMetadata(tx: DbTransaction, claim: ImportClaim, source: string) {
  const rows = await tx.execute(sql`
    SELECT r.id FROM import_records r
    WHERE r.brand_id = ${claim.brandId}::uuid AND r.run_id = ${claim.runId}::uuid
      AND r.status = 'staged'
      AND (r.entity IN ('field','organization','contact','category','section')
        OR (r.entity = 'user' AND r.payload->>'kind' = 'agent'))
      AND (r.entity = 'field' OR NOT EXISTS (
        SELECT 1 FROM import_records f WHERE f.brand_id = r.brand_id
          AND f.run_id = r.run_id AND f.entity = 'field' AND f.status NOT IN ('loaded','skipped')))
      AND NOT EXISTS (
        SELECT 1 FROM (VALUES
          (CASE WHEN r.entity = 'contact' THEN 'organization' WHEN r.entity IN ('category','section') THEN 'category' END,
           CASE WHEN r.entity = 'contact' THEN r.payload->>'organizationExternalId' ELSE r.payload->>'parentExternalId' END),
          (CASE WHEN r.entity = 'section' THEN 'section' END, r.payload->>'parentSectionExternalId')
        ) AS dependency(entity, external_id)
        WHERE dependency.entity IS NOT NULL AND dependency.external_id IS NOT NULL
          AND (
            EXISTS (SELECT 1 FROM import_records parent WHERE parent.brand_id = r.brand_id
              AND parent.run_id = r.run_id AND parent.entity::text = dependency.entity
              AND parent.external_id = dependency.external_id AND parent.status <> 'loaded')
            OR NOT (
              EXISTS (SELECT 1 FROM import_records parent WHERE parent.brand_id = r.brand_id
                AND parent.run_id = r.run_id AND parent.entity::text = dependency.entity
                AND parent.external_id = dependency.external_id AND parent.status = 'loaded')
              OR EXISTS (SELECT 1 FROM import_external_ids pointer WHERE pointer.brand_id = r.brand_id
                AND pointer.source::text = ${source} AND pointer.entity::text = dependency.entity
                AND pointer.external_id = dependency.external_id)
            )
          )
      )
    ORDER BY CASE r.entity WHEN 'field' THEN 0 WHEN 'user' THEN 1 WHEN 'organization' THEN 2
      WHEN 'contact' THEN 3 WHEN 'category' THEN 4 WHEN 'section' THEN 5 END, r.id
    LIMIT 1 FOR UPDATE OF r
  `);
  return selectedSchema.parse(rows)[0];
}

/** Metadata is a phase boundary, not completion of media, tickets or reference-only records. */
export async function loadNextStagedMetadata(
  tx: DbTransaction,
  request: { claim: ImportClaim; defaultCallingCode?: string },
) {
  const parsed = z
    .strictObject({
      claim: importClaimSchema,
      defaultCallingCode: z
        .string()
        .regex(/^\d{0,4}$/)
        .default(''),
    })
    .parse(request);
  const { claim } = parsed;
  if (claim.phase !== 'loading') throw new ImportClaimLost();
  await renewImportClaim(tx, claim);
  const predicate = and(eq(importRuns.id, claim.runId), eq(importRuns.brandId, claim.brandId));
  const [run] = await tx.select({ source: importRuns.source }).from(importRuns).where(predicate);
  if (!run) throw new ImportClaimLost();
  const failed = await tx
    .select({ id: importRecords.id })
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, claim.brandId),
        eq(importRecords.runId, claim.runId),
        eq(importRecords.status, 'failed'),
      ),
    )
    .limit(1);
  if (failed.length) throw new ImportLoadError('mapping-invalid');
  const selected = await readyMetadata(tx, claim, run.source);
  if (selected) {
    const loaded = await loadPreparedStagedRecord(tx, { ...parsed, recordId: selected.id });
    return { state: 'loaded' as const, recordId: selected.id, id: loaded.id };
  }
  const pending =
    await tx.execute(sql`SELECT id FROM import_records WHERE brand_id = ${claim.brandId}::uuid
    AND run_id = ${claim.runId}::uuid AND status = 'staged'
    AND (entity IN ('field','organization','contact','category','section') OR (entity = 'user' AND payload->>'kind' = 'agent')) LIMIT 1`);
  if (pending.length) throw new ImportLoadError('mapping-invalid');
  return { state: 'metadata_done' as const };
}
