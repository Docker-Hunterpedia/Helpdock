import { type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { importEntitySchema, importRecordSchema } from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { importedContactTarget } from '../loader/contact-target.js';
import { ImportLoadError } from '../loader/contracts.js';
import { importedIdentity } from '../loader/external-ids.js';
import { fieldLoadSchema } from '../loader/field-contracts.js';
import { ImportWriter } from '../loader/import-writer.js';
import {
  articleLoadSchema,
  categoryLoadSchema,
  sectionLoadSchema,
} from '../loader/knowledge-contracts.js';
import { contactLoadSchema, organizationLoadSchema } from '../loader/profile-contracts.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  renewImportClaim,
} from './claims.js';

const operationSchema = z.discriminatedUnion('entity', [
  z.strictObject({ entity: z.literal('field'), input: fieldLoadSchema }),
  z.strictObject({ entity: z.literal('organization'), input: organizationLoadSchema }),
  z.strictObject({ entity: z.literal('contact'), input: contactLoadSchema }),
  z.strictObject({ entity: z.literal('category'), input: categoryLoadSchema }),
  z.strictObject({ entity: z.literal('section'), input: sectionLoadSchema }),
  z.strictObject({ entity: z.literal('article'), input: articleLoadSchema }),
]);
const requestSchema = z.strictObject({
  claim: importClaimSchema,
  recordId: z.uuid(),
  operation: operationSchema,
});
export type RecordCheckpointRequest = z.infer<typeof requestSchema>;
type Operation = z.infer<typeof operationSchema>;
const writer = new ImportWriter();
const tables = {
  field: 'custom_field_defs',
  organization: 'accounts',
  category: 'hc_categories',
  section: 'hc_sections',
  article: 'hc_articles',
} as const;

function writeRecord(tx: DbTransaction, operation: Operation) {
  switch (operation.entity) {
    case 'field':
      return writer.field(tx, operation.input);
    case 'organization':
      return writer.organization(tx, operation.input);
    case 'contact':
      return writer.contact(tx, operation.input);
    case 'category':
      return writer.category(tx, operation.input);
    case 'section':
      return writer.section(tx, operation.input);
    case 'article':
      return writer.article(tx, operation.input);
  }
}

async function requireLoadedTarget(tx: DbTransaction, operation: Operation, id: string | null) {
  if (id === null) {
    if (operation.entity !== 'field' || operation.input.mapping.kind !== 'skip')
      throw new ImportLoadError('target-unavailable');
    return null;
  }
  const { input, entity } = operation;
  const pointer = await importedIdentity(tx, input, entity, input.record.externalId);
  if (!pointer) throw new ImportLoadError('target-unavailable');
  if (entity === 'contact') {
    const sourceTarget = await importedContactTarget(tx, {
      brandId: input.brandId,
      contactId: pointer.helpdockId,
    });
    const loadedTarget = await importedContactTarget(tx, { brandId: input.brandId, contactId: id });
    if (sourceTarget.id !== loadedTarget.id) throw new ImportLoadError('target-unavailable');
    return sourceTarget.id;
  }
  if (pointer.helpdockId !== id) throw new ImportLoadError('target-unavailable');
  const rows = await tx.execute(
    sql`SELECT id FROM ${sql.identifier(tables[entity])} WHERE id = ${id}::uuid AND brand_id = ${input.brandId}::uuid`,
  );
  if (!rows.length) throw new ImportLoadError('target-unavailable');
  if (operation.entity === 'article') {
    const versions = await tx.execute(
      sql`SELECT id FROM hc_article_versions WHERE article_id = ${id}::uuid AND brand_id = ${input.brandId}::uuid AND locale = ${operation.input.record.locale}`,
    );
    if (!versions.length) throw new ImportLoadError('target-unavailable');
  }
  return id;
}

async function recordProgress(
  tx: DbTransaction,
  claim: ImportClaim,
  entity: Operation['entity'],
  status: 'loaded' | 'skipped',
) {
  const predicate = and(eq(importRuns.id, claim.runId), eq(importRuns.brandId, claim.brandId));
  const [run] = await tx.select({ counts: importRuns.counts }).from(importRuns).where(predicate);
  if (!run) throw new ImportClaimLost();
  const counts = z
    .partialRecord(importEntitySchema, z.int().nonnegative())
    .parse(run.counts[status] ?? {});
  counts[entity] = (counts[entity] ?? 0) + 1;
  await tx
    .update(importRuns)
    .set({ counts: { ...run.counts, [status]: counts } })
    .where(predicate);
}

/** Source validation, domain writes, mapping receipt and progress commit under one worker claim. */
export async function loadStagedRecord(tx: DbTransaction, request: RecordCheckpointRequest) {
  const { claim, recordId, operation } = requestSchema.parse(request);
  if (claim.phase !== 'loading') throw new ImportClaimLost();
  await renewImportClaim(tx, claim);
  const predicate = and(
    eq(importRecords.id, recordId),
    eq(importRecords.brandId, claim.brandId),
    eq(importRecords.runId, claim.runId),
    eq(importRecords.entity, operation.entity),
  );
  const [row] = await tx.select().from(importRecords).where(predicate).for('update');
  if (!row) throw new ImportLoadError('target-unavailable');
  const [run] = await tx
    .select({ source: importRuns.source })
    .from(importRuns)
    .where(and(eq(importRuns.id, claim.runId), eq(importRuns.brandId, claim.brandId)));
  const input = operation.input;
  const native = importRecordSchema.parse({ entity: operation.entity, payload: row.payload });
  if (
    input.brandId !== claim.brandId ||
    input.runId !== claim.runId ||
    input.source !== run?.source ||
    input.record.externalId !== row.externalId ||
    hashImportValue(native.payload) !== row.payloadHash ||
    hashImportValue(input.record) !== row.payloadHash
  )
    throw new ImportLoadError('mapping-invalid');
  const loadHash = hashImportValue(operation);
  if (row.status === 'loaded' || row.status === 'skipped') {
    if (row.loadHash !== loadHash) throw new ImportLoadError('mapping-invalid');
    const id = await requireLoadedTarget(tx, operation, row.helpdockId);
    return { state: 'already_done' as const, id };
  }
  if (row.status !== 'staged') throw new ImportLoadError('mapping-invalid');
  const loaded = await writeRecord(tx, operation);
  const status = loaded.id === null ? ('skipped' as const) : ('loaded' as const);
  await tx
    .update(importRecords)
    .set({ status, helpdockId: loaded.id, loadHash, error: null })
    .where(predicate);
  await recordProgress(tx, claim, operation.entity, status);
  return { state: status, ...loaded };
}
