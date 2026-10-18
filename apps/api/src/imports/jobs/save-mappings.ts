import { type DbTransaction, importMappings, importRuns } from '@helpdock/db';
import {
  type ImportMapping,
  type ImportMappingPageRequest,
  importMappingPageRequestSchema,
  importMappingsSchema,
} from '@helpdock/schemas';
import { and, eq, or, sql } from 'drizzle-orm';
import { type ImportRunRef, importRunRefSchema, lockImportBrand } from './claims.js';

export class ImportMappingEditError extends Error {
  constructor(readonly code: 'run-unavailable' | 'run-not-editable' | 'mapping-capacity') {
    super(`import.${code}`);
    this.name = 'ImportMappingEditError';
  }
}

/** A paged editor upserts only submitted keys; mappings outside that page are preserved. */
export async function saveImportMappingPage(
  tx: DbTransaction,
  rawScope: ImportRunRef,
  raw: ImportMappingPageRequest,
) {
  const scope = importRunRefSchema.parse(rawScope);
  const { mappings } = importMappingPageRequestSchema.parse(raw);
  await lockImportBrand(tx, scope.brandId);
  const predicate = and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId));
  const [run] = await tx
    .select({ status: importRuns.status })
    .from(importRuns)
    .where(predicate)
    .for('update');
  if (!run) throw new ImportMappingEditError('run-unavailable');
  if (!['awaiting_mapping', 'ready'].includes(run.status))
    throw new ImportMappingEditError('run-not-editable');
  const ownMappings = and(
    eq(importMappings.brandId, scope.brandId),
    eq(importMappings.runId, scope.runId),
  );
  const [total] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(importMappings)
    .where(ownMappings);
  const submittedKeys = mappings.map((mapping) =>
    and(
      eq(importMappings.kind, mapping.kind),
      eq(importMappings.externalValue, mapping.externalValue),
    ),
  );
  const existing = await tx
    .select({ id: importMappings.id })
    .from(importMappings)
    .where(and(ownMappings, or(...submittedKeys)));
  if ((total?.count ?? 0) + mappings.length - existing.length > 50000)
    throw new ImportMappingEditError('mapping-capacity');
  await tx
    .insert(importMappings)
    .values(
      mappings.map((mapping) => ({
        ...scope,
        kind: mapping.kind,
        externalValue: mapping.externalValue,
        target: mapping.target,
      })),
    )
    .onConflictDoUpdate({
      target: [importMappings.runId, importMappings.kind, importMappings.externalValue],
      set: { target: sql`excluded.target` },
    });
  await tx
    .update(importRuns)
    .set({ status: 'awaiting_mapping', dryRunReport: null })
    .where(predicate);
  return { saved: mappings.length };
}

/** Caller authorizes brand administration; semantic target validation belongs to the dry run and loader. */
export async function saveImportMappings(
  tx: DbTransaction,
  request: ImportRunRef,
  proposed: ImportMapping[],
): Promise<void> {
  const scope = importRunRefSchema.parse(request);
  const mappings = importMappingsSchema.parse(proposed);
  await lockImportBrand(tx, scope.brandId);
  const predicate = and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId));
  const [run] = await tx.select().from(importRuns).where(predicate).for('update');
  if (!run) throw new ImportMappingEditError('run-unavailable');
  if (!['awaiting_mapping', 'ready'].includes(run.status))
    throw new ImportMappingEditError('run-not-editable');

  await tx
    .delete(importMappings)
    .where(and(eq(importMappings.brandId, scope.brandId), eq(importMappings.runId, scope.runId)));
  await insertMappings(tx, scope, mappings);
  // A report approves its mapping snapshot, never a later edited configuration.
  await tx
    .update(importRuns)
    .set({ status: 'awaiting_mapping', dryRunReport: null })
    .where(predicate);
}

async function insertMappings(
  tx: DbTransaction,
  scope: ImportRunRef,
  mappings: ImportMapping[],
): Promise<void> {
  for (let offset = 0; offset < mappings.length; offset += 1000) {
    await tx.insert(importMappings).values(
      mappings.slice(offset, offset + 1000).map((mapping) => ({
        ...scope,
        kind: mapping.kind,
        externalValue: mapping.externalValue,
        target: mapping.target,
      })),
    );
  }
}
