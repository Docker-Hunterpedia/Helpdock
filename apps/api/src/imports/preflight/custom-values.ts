import { customFieldDefs, type DbTransaction, importMappings, importRecords } from '@helpdock/db';
import {
  type CustomFieldRule,
  type CustomFieldTarget,
  importMappingSchema,
} from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportScope, importedIdentity } from '../loader/external-ids.js';
import { fieldLoadSchema } from '../loader/field-contracts.js';
import { type ImportedFieldBinding, mappedImportedCustom } from '../loader/mapped-custom-values.js';
import { validatedStagedRecord } from './staged-record.js';

/** Use the loader's value rules against existing and proposed definitions without creating either. */
export async function previewImportedCustom(
  tx: DbTransaction,
  request: ImportScope & {
    target: CustomFieldTarget;
    custom: Record<string, unknown>;
    operation: 'create' | 'patch';
  },
) {
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
    .select({
      kind: importMappings.kind,
      externalValue: importMappings.externalValue,
      target: importMappings.target,
    })
    .from(importMappings)
    .where(
      and(
        eq(importMappings.brandId, request.brandId),
        eq(importMappings.runId, request.runId),
        eq(importMappings.kind, 'field'),
      ),
    );
  const existing = await tx
    .select()
    .from(customFieldDefs)
    .where(
      and(eq(customFieldDefs.brandId, request.brandId), eq(customFieldDefs.target, request.target)),
    );
  const definitions: CustomFieldRule[] = [...existing];
  const bySource = new Map(
    mappings.map((row) => [row.externalValue, importMappingSchema.parse(row)]),
  );
  const bindings: ImportedFieldBinding[] = [];
  for (const row of fields) {
    const native = validatedStagedRecord(row);
    if (native.entity !== 'field') throw new ImportLoadError('mapping-invalid');
    const source = native.payload;
    if ((source.target === 'organization' ? 'account' : source.target) !== request.target) continue;
    const mapping = bySource.get(source.externalId);
    if (
      mapping?.kind !== 'field' ||
      !fieldLoadSchema.safeParse({
        brandId: request.brandId,
        runId: request.runId,
        source: request.source,
        record: source,
        mapping: mapping.target,
      }).success
    )
      throw new ImportLoadError('mapping-invalid');
    if (mapping.target.kind === 'skip') {
      bindings.push({ source, destination: null });
      continue;
    }
    const known = await importedIdentity(tx, request, 'field', source.externalId);
    const explicit = mapping.target.kind === 'existing' ? mapping.target.fieldId : undefined;
    if (known && explicit && known.helpdockId !== explicit)
      throw new ImportLoadError('mapping-invalid');
    const id = known?.helpdockId ?? explicit;
    let destination: CustomFieldRule;
    if (id) {
      const field = existing.find((field) => field.id === id);
      if (!field) throw new ImportLoadError('mapping-invalid');
      destination = field;
    } else {
      if (mapping.target.kind !== 'create') throw new ImportLoadError('mapping-invalid');
      destination = mapping.target.definition;
      if (definitions.some((field) => field.key === destination.key))
        throw new ImportLoadError('mapping-invalid');
      definitions.push(destination);
    }
    bindings.push({ source, destination });
  }
  return mappedImportedCustom({
    custom: request.custom,
    bindings,
    definitions,
    operation: request.operation,
  });
}
