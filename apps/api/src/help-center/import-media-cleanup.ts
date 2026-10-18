import type { DbTransaction, hcMedia } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import { OBJECT_PURGE_EVENT, objectPurgePayloadSchema } from '../media/object-purge.js';
import { HcImportIntegrityRefusal } from './import-media-integrity.js';
import { hcMediaKey } from './media.service.js';

/** A failed transaction must keep its source bytes available for the next media attempt. */
export async function enqueueImportedHcOriginalCleanup(
  tx: DbTransaction,
  row: typeof hcMedia.$inferSelect,
): Promise<void> {
  const key = hcMediaKey(row.brandId, row.id, 'original');
  if (!row.importedByRunId || row.s3Key !== key)
    throw new HcImportIntegrityRefusal('unbound_asset');
  await enqueueOutbox(tx, {
    brandId: row.brandId,
    event: OBJECT_PURGE_EVENT,
    payload: objectPurgePayloadSchema.parse({ keys: [key] }),
  });
}
