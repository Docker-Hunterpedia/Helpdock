import { type DbTransaction, importRuns } from '@helpdock/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  renewImportClaim,
} from './claims.js';

const readinessSchema = z
  .array(
    z.object({
      records_pending: z.boolean(),
      media_missing: z.boolean(),
      media_pending: z.boolean(),
    }),
  )
  .length(1);

/** Media processing is asynchronous; loaded receipts alone cannot authorize finalization. */
export async function beginImportFinishing(tx: DbTransaction, request: ImportClaim) {
  const claim = importClaimSchema.parse(request);
  if (claim.phase !== 'loading') throw new ImportClaimLost();
  await renewImportClaim(tx, claim);
  const [readiness] = readinessSchema.parse(
    await tx.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM import_records r WHERE r.brand_id = ${claim.brandId}::uuid
        AND r.run_id = ${claim.runId}::uuid AND r.status NOT IN ('loaded', 'skipped')) AS records_pending,
      EXISTS (SELECT 1 FROM import_records r WHERE r.brand_id = ${claim.brandId}::uuid
        AND r.run_id = ${claim.runId}::uuid AND r.entity = 'attachment' AND r.status = 'loaded'
        AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.brand_id = r.brand_id
          AND a.origin = 'import' AND (a.id = r.helpdock_id OR a.copied_from_attachment_id = r.helpdock_id))) AS media_missing,
      EXISTS (SELECT 1 FROM import_records r JOIN attachments a ON a.brand_id = r.brand_id
        AND (a.id = r.helpdock_id OR a.copied_from_attachment_id = r.helpdock_id)
        WHERE r.brand_id = ${claim.brandId}::uuid AND r.run_id = ${claim.runId}::uuid
          AND r.entity = 'attachment' AND r.status = 'loaded' AND a.origin = 'import'
          AND a.status NOT IN ('ready', 'rejected', 'infected')) AS media_pending
  `),
  );
  if (!readiness) throw new ImportClaimLost();
  if (readiness.media_missing) throw new ImportLoadError('target-unavailable');
  if (readiness.records_pending || readiness.media_pending) return null;
  await tx
    .update(importRuns)
    .set({ status: 'finishing' })
    .where(
      and(
        eq(importRuns.brandId, claim.brandId),
        eq(importRuns.id, claim.runId),
        eq(importRuns.claimToken, claim.token),
        eq(importRuns.status, 'loading'),
      ),
    );
  return importClaimSchema.parse({ ...claim, phase: 'finishing' });
}
