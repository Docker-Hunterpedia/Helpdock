import { type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { importRecordSchema } from '@helpdock/schemas';
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
import { requireImportedStaffTarget } from '../loader/load-staff.js';
import { contactLoadSchema, organizationLoadSchema } from '../loader/profile-contracts.js';
import { resolveImportedCustom } from '../loader/resolve-custom-fields.js';
import { staffLoadSchema } from '../loader/staff-contracts.js';
import { ImportClaimLost, importClaimSchema, renewImportClaim } from './claims.js';
import { recordLoadProgress } from './record-load-progress.js';

const operationSchema = z.discriminatedUnion('entity', [
  z.strictObject({ entity: z.literal('field'), input: fieldLoadSchema }),
  z.strictObject({ entity: z.literal('organization'), input: organizationLoadSchema }),
  z.strictObject({ entity: z.literal('contact'), input: contactLoadSchema }),
  z.strictObject({ entity: z.literal('category'), input: categoryLoadSchema }),
  z.strictObject({ entity: z.literal('section'), input: sectionLoadSchema }),
  z.strictObject({ entity: z.literal('article'), input: articleLoadSchema }),
  z.strictObject({ entity: z.literal('user'), input: staffLoadSchema }),
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

async function writeRecord(tx: DbTransaction, operation: Operation) {
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
    case 'user': {
      const loaded = await writer.staff(tx, operation.input);
      return {
        id: loaded.author.kind === 'staff' ? loaded.author.id : null,
        outcome: loaded.outcome,
      };
    }
  }
}

async function validateResolvedCustom(tx: DbTransaction, operation: Operation) {
  if (operation.entity !== 'organization' && operation.entity !== 'contact') return;
  const input = operation.input;
  const compiled = await resolveImportedCustom(tx, {
    ...input,
    target: operation.entity === 'organization' ? 'account' : 'contact',
    custom: input.record.custom,
    operation: 'patch',
  });
  if (hashImportValue(compiled) !== hashImportValue(input.custom))
    throw new ImportLoadError('mapping-invalid');
}

async function requireLoadedTarget(tx: DbTransaction, operation: Operation, id: string | null) {
  if (id === null) {
    if (operation.entity === 'user' && operation.input.mapping.kind === 'name') return null;
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
  if (entity === 'user') {
    await requireImportedStaffTarget(tx, input, id);
    return id;
  }
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
  await validateResolvedCustom(tx, operation);
  const loaded = await writeRecord(tx, operation);
  const status =
    operation.entity === 'field' && loaded.id === null ? ('skipped' as const) : ('loaded' as const);
  await tx
    .update(importRecords)
    .set({ status, helpdockId: loaded.id, loadHash, error: null })
    .where(predicate);
  await recordLoadProgress(tx, {
    claim,
    entity: operation.entity,
    status,
    knowledgeChanged: operation.entity === 'article' && loaded.outcome !== 'unchanged',
  });
  return { state: status, ...loaded };
}
