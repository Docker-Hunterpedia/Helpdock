import { customFieldDefs, type DbTransaction, importMappings, importRecords } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { type CustomFieldTarget, importFieldSchema, importMappingSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError } from './contracts.js';
import { importedIdentity } from './external-ids.js';
import { type ImportedFieldBinding, mappedImportedCustom } from './mapped-custom-values.js';
import { type ImportRunScope, requireLoadingRun } from './run-scope.js';

export async function resolveImportedCustom(
  tx: DbTransaction,
  request: ImportRunScope & {
    target: CustomFieldTarget;
    custom: Record<string, unknown>;
    operation: 'create' | 'patch';
  },
) {
  await requireLoadingRun(tx, request);
  const fields = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, request.brandId),
        eq(importRecords.runId, request.runId),
        eq(importRecords.entity, 'field'),
      ),
    );
  const mappings = await tx
    .select()
    .from(importMappings)
    .where(
      and(
        eq(importMappings.brandId, request.brandId),
        eq(importMappings.runId, request.runId),
        eq(importMappings.kind, 'field'),
      ),
    );
  const definitions = await tx
    .select()
    .from(customFieldDefs)
    .where(
      and(eq(customFieldDefs.brandId, request.brandId), eq(customFieldDefs.target, request.target)),
    );
  const byExternalId = new Map(
    mappings.map((row) => [
      row.externalValue,
      importMappingSchema.parse({
        kind: row.kind,
        externalValue: row.externalValue,
        target: row.target,
      }),
    ]),
  );
  const bindings: ImportedFieldBinding[] = [];
  for (const row of fields) {
    const source = importFieldSchema.parse(row.payload);
    if (source.externalId !== row.externalId || hashImportValue(source) !== row.payloadHash)
      throw new ImportLoadError('mapping-invalid');
    if ((source.target === 'organization' ? 'account' : source.target) !== request.target) continue;
    const mapping = byExternalId.get(source.externalId);
    if (mapping?.kind !== 'field') throw new ImportLoadError('mapping-invalid');
    if (mapping.target.kind === 'skip') {
      bindings.push({ source, destination: null });
      continue;
    }
    if (mapping.target.kind === 'create' && mapping.target.definition.target !== request.target)
      throw new ImportLoadError('mapping-invalid');
    const pointer = await importedIdentity(tx, request, 'field', source.externalId);
    if (
      !pointer ||
      (mapping.target.kind === 'existing' && mapping.target.fieldId !== pointer.helpdockId)
    )
      throw new ImportLoadError('mapping-invalid');
    const destination = definitions.find((definition) => definition.id === pointer.helpdockId);
    if (!destination) throw new ImportLoadError('mapping-invalid');
    bindings.push({ source, destination });
  }
  return mappedImportedCustom({
    custom: request.custom,
    bindings,
    definitions,
    operation: request.operation,
  });
}
