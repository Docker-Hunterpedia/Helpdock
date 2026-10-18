import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import {
  OBJECT_PURGE_CHUNK,
  OBJECT_PURGE_EVENT,
  objectPurgePayloadSchema,
} from '../media/object-purge.js';

export async function purgeImportFileKeys(
  tx: DbTransaction,
  brandId: string,
  keys: (string | null)[],
) {
  const present = [...new Set(keys.filter((key): key is string => key !== null))];
  for (let offset = 0; offset < present.length; offset += OBJECT_PURGE_CHUNK) {
    await enqueueOutbox(tx, {
      brandId,
      event: OBJECT_PURGE_EVENT,
      payload: objectPurgePayloadSchema.parse({
        keys: present.slice(offset, offset + OBJECT_PURGE_CHUNK),
      }),
    });
  }
}
