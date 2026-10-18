import { type DbTransaction, importFiles } from '@helpdock/db';
import {
  type ImportEntity,
  importFileMappingSchema,
  importFileValidationSchema,
} from '@helpdock/schemas';
import { and, eq, ne } from 'drizzle-orm';
import type { ImportRunRef } from './claims.js';

/** Omitted CSV rows remain visible in the review receipt, even though they are never staged. */
export async function importFileSourceWarnings(
  tx: DbTransaction,
  scope: ImportRunRef & { entities: ImportEntity[] },
) {
  const files = await tx
    .select({
      id: importFiles.id,
      mapping: importFiles.mapping,
      validation: importFiles.validation,
      entity: importFiles.entity,
    })
    .from(importFiles)
    .where(
      and(
        eq(importFiles.brandId, scope.brandId),
        eq(importFiles.runId, scope.runId),
        eq(importFiles.format, 'csv'),
        ne(importFiles.status, 'discarded'),
      ),
    )
    .limit(100);
  let sourceWarningCount = 0;
  const sourceWarnings: {
    entity: NonNullable<(typeof files)[number]['entity']>;
    externalId: string;
    code: string;
  }[] = [];
  for (const file of files) {
    if (!file.mapping || !file.validation || !file.entity) continue;
    const mapping = importFileMappingSchema.parse(file.mapping);
    if (
      !scope.entities.includes(file.entity) &&
      !(
        file.entity === 'ticket' &&
        mapping.firstMessageFields &&
        scope.entities.includes('message')
      )
    )
      continue;
    const validation = importFileValidationSchema.parse(file.validation);
    if (!mapping.skipInvalidRows || !validation.invalidRows) continue;
    sourceWarningCount += validation.invalidRows;
    sourceWarnings.push({ entity: file.entity, externalId: file.id, code: 'file-rows-skipped' });
  }
  return { sourceWarningCount, sourceWarnings };
}
