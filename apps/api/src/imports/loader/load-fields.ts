import { auditLog, customFieldDefs, type DbTransaction, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { MAX_CUSTOM_FIELDS_PER_TARGET } from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { ImportLoadError } from './contracts.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import { type FieldLoad, fieldLoadSchema } from './field-contracts.js';
import { requireLoadingRun } from './run-scope.js';

async function mappedField(tx: DbTransaction, input: FieldLoad, id: string) {
  const target = input.record.target === 'organization' ? 'account' : input.record.target;
  const [field] = await tx
    .select()
    .from(customFieldDefs)
    .where(
      and(
        eq(customFieldDefs.id, id),
        eq(customFieldDefs.brandId, input.brandId),
        eq(customFieldDefs.target, target),
      ),
    );
  if (!field) throw new ImportLoadError('mapping-invalid');
  return field;
}

async function fieldPosition(
  tx: DbTransaction,
  scope: { brandId: string; target: 'ticket' | 'contact' | 'account' },
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.brandId}:fields:${scope.target}`}, 24))`,
  );
  const [position] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      next: sql<number>`coalesce(max(${customFieldDefs.sortOrder}), -1) + 1`,
    })
    .from(customFieldDefs)
    .where(
      and(eq(customFieldDefs.brandId, scope.brandId), eq(customFieldDefs.target, scope.target)),
    );
  if (!position || position.count >= MAX_CUSTOM_FIELDS_PER_TARGET)
    throw new ImportLoadError('mapping-invalid');
  return position.next;
}

async function recordFieldCreation(tx: DbTransaction, input: FieldLoad, id: string): Promise<void> {
  await tx.insert(auditLog).values({
    brandId: input.brandId,
    actorType: 'system',
    actorId: `import:${input.runId}`,
    action: 'import.field.created',
    targetType: 'custom_field',
    targetId: id,
    meta: { source: input.source, externalId: input.record.externalId },
  });
}

/** Source changes cannot rewrite the brand's field definition or choices under existing values. */
async function createImportedField(tx: DbTransaction, input: FieldLoad): Promise<string> {
  if (input.mapping.kind !== 'create') throw new ImportLoadError('mapping-invalid');
  const definition = input.mapping.definition;
  const sortOrder = await fieldPosition(tx, { brandId: input.brandId, target: definition.target });
  const id = uuidv7();
  const created = await tx
    .insert(customFieldDefs)
    .values({
      ...definition,
      labelAr: definition.labelAr ?? null,
      id,
      brandId: input.brandId,
      sortOrder,
    })
    .onConflictDoNothing()
    .returning({ id: customFieldDefs.id });
  if (!created.length) throw new ImportLoadError('mapping-invalid');
  await recordFieldCreation(tx, input, id);
  return id;
}

export async function loadImportedField(tx: DbTransaction, request: FieldLoad) {
  const input = fieldLoadSchema.parse(request);
  await requireLoadingRun(tx, input);
  if (input.mapping.kind === 'skip') return { id: null, outcome: 'skipped' as const };
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.brandId}:${input.source}:field:${input.record.externalId}`}, 23))`,
  );
  const known = await importedIdentity(tx, input, 'field', input.record.externalId);
  const explicitId = input.mapping.kind === 'existing' ? input.mapping.fieldId : undefined;
  if (known && explicitId && known.helpdockId !== explicitId)
    throw new ImportLoadError('mapping-invalid');
  const targetId = known?.helpdockId ?? explicitId;
  if (targetId) await mappedField(tx, input, targetId);
  const payloadHash = hashImportValue({ record: input.record, mapping: input.mapping });
  if (known?.payloadHash === payloadHash)
    return { id: known.helpdockId, outcome: 'unchanged' as const };
  const id = targetId ?? (await createImportedField(tx, input));
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    runId: input.runId,
    entity: 'field',
    externalId: input.record.externalId,
    helpdockId: id,
    payloadHash,
  });
  return { id, outcome: targetId ? ('linked' as const) : ('created' as const) };
}
