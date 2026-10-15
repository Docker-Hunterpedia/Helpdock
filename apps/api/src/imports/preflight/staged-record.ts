import type { importRecords } from '@helpdock/db';
import { hashImportValue, importRecordParent } from '@helpdock/importers';
import { importRecordSchema } from '@helpdock/schemas';
import { ImportLoadError } from '../loader/contracts.js';

type StagedRecord = Pick<
  typeof importRecords.$inferSelect,
  'entity' | 'externalId' | 'payload' | 'payloadHash' | 'status' | 'parentExternalId'
>;

/** Pure validation shared by preflight reads and loading; failures carry only a safe code. */
export function validatedStagedRecord(row: StagedRecord) {
  const parsed = importRecordSchema.safeParse({ entity: row.entity, payload: row.payload });
  if (
    !parsed.success ||
    !['staged', 'loaded', 'skipped'].includes(row.status) ||
    parsed.data.payload.externalId !== row.externalId ||
    importRecordParent(parsed.data) !== row.parentExternalId ||
    hashImportValue(parsed.data.payload) !== row.payloadHash
  )
    throw new ImportLoadError('mapping-invalid');
  return parsed.data;
}
