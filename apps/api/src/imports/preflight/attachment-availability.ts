import { brands, type DbTransaction, type importRecords, importRuns } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { type ImportAttachmentRef, importAttachmentSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { readContentPolicy } from '../../media/content-policy.js';
import type { ImportRunRef } from '../jobs/claims.js';
import { importDryRunCheckpointSchema } from '../jobs/dry-run-state.js';
import { inspectedAttachmentAvailability } from '../jobs/media-inspection.js';
import { importAttachmentHash } from '../loader/load-attachments.js';

export async function attachmentReviewBinding(tx: DbTransaction, scope: ImportRunRef) {
  const [row] = await tx
    .select({ report: importRuns.dryRunReport, settings: brands.settings })
    .from(importRuns)
    .innerJoin(brands, eq(brands.id, importRuns.brandId))
    .where(and(eq(importRuns.id, scope.runId), eq(importRuns.brandId, scope.brandId)));
  const checkpoint = importDryRunCheckpointSchema.safeParse(row?.report);
  if (
    !row ||
    !checkpoint.success ||
    !['identities_checked', 'media_checked'].includes(checkpoint.data.phase) ||
    checkpoint.data.mediaAfter === null
  )
    return null;
  const policyHash = hashImportValue(readContentPolicy(row.settings.contentPolicy));
  return checkpoint.data.mediaPolicyHash === policyHash
    ? {
        fingerprint: checkpoint.data.fingerprint,
        policyHash,
        through: checkpoint.data.mediaAfter,
      }
    : null;
}

/** Project named metadata only; native page hints and signed URLs stay private. */
export function attachmentPreview(
  ref: ImportAttachmentRef,
  row: typeof importRecords.$inferSelect | undefined,
  binding: Awaited<ReturnType<typeof attachmentReviewBinding>>,
) {
  const source = importAttachmentSchema.safeParse(row?.payload);
  const matches = source.success && importAttachmentHash(source.data) === importAttachmentHash(ref);
  return {
    externalId: ref.externalId,
    fileName: ref.fileName,
    ...(ref.contentType === undefined ? {} : { contentType: ref.contentType }),
    ...(ref.size === undefined ? {} : { size: ref.size }),
    availability:
      row && matches && binding && row.id <= binding.through
        ? inspectedAttachmentAvailability(row.dryRunMedia, {
            ...binding,
            payloadHash: row.payloadHash,
          })
        : { state: 'not_checked' as const },
  };
}
