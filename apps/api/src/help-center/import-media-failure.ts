import { type Db, hcMedia } from '@helpdock/db';
import type { HelpCenterMediaProcessPayload } from '@helpdock/jobs';
import { and, eq, isNotNull } from 'drizzle-orm';
import { withSystemJob } from '../tenant/system-job.js';

/** The failed processing transaction rolled back; record exhaustion separately for import recovery. */
export async function markImportedHcMediaFailed(
  db: Db,
  payload: HelpCenterMediaProcessPayload,
): Promise<void> {
  await withSystemJob(db, payload.brandId, 'help_center.import_media_failed', (tx) =>
    tx
      .update(hcMedia)
      .set({ status: 'rejected', rejectReason: 'processing_failed', processedAt: new Date() })
      .where(
        and(
          eq(hcMedia.brandId, payload.brandId),
          eq(hcMedia.id, payload.mediaId),
          eq(hcMedia.status, 'processing'),
          isNotNull(hcMedia.importedByRunId),
        ),
      ),
  );
}
