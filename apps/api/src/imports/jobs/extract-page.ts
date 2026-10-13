import { type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import { ConnectorError, hashImportValue } from '@helpdock/importers';
import {
  type ImportEntity,
  type ImportRecord,
  importEntitySchema,
  importRecordSchema,
} from '@helpdock/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ImportClaim, ImportClaimLost, renewImportClaim } from './claims.js';

const pageSchema = z.strictObject({
  records: z.array(importRecordSchema).max(1000),
  cursor: z.record(z.string().max(200), z.json()).nullable(),
});
const checkpointSchema = z.strictObject({ cursor: pageSchema.shape.cursor, done: z.boolean() });
export const extractionCheckpointsSchema = z.partialRecord(importEntitySchema, checkpointSchema);
const extractedCountsSchema = z.partialRecord(importEntitySchema, z.int().nonnegative());

function parentExternalId(record: ImportRecord): string | null {
  switch (record.entity) {
    case 'message':
    case 'attachment':
    case 'csat':
      return record.payload.ticketExternalId;
    case 'article':
      return record.payload.sectionExternalId;
    case 'section':
      return record.payload.parentExternalId;
    case 'category':
      return record.payload.parentExternalId ?? null;
    default:
      return null;
  }
}

function validatedPage(entity: ImportEntity, request: unknown) {
  const page = pageSchema.parse(z.json().parse(request));
  if (
    page.records.some((record) => record.entity !== entity) ||
    new Set(page.records.map((record) => record.payload.externalId)).size !== page.records.length
  )
    throw new ConnectorError('invalid-response');
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > 50 * 1024 * 1024)
    throw new ConnectorError('invalid-response');
  return page;
}

async function upsertExtractedRecords(
  tx: DbTransaction,
  claim: ImportClaim,
  entity: ImportEntity,
  page: z.infer<typeof pageSchema>,
): Promise<number> {
  if (!page.records.length) return 0;
  const known = await tx
    .select({ externalId: importRecords.externalId })
    .from(importRecords)
    .where(
      and(
        eq(importRecords.runId, claim.runId),
        eq(importRecords.brandId, claim.brandId),
        eq(importRecords.entity, entity),
        inArray(
          importRecords.externalId,
          page.records.map((record) => record.payload.externalId),
        ),
      ),
    );
  await tx
    .insert(importRecords)
    .values(
      page.records.map((record) => ({
        brandId: claim.brandId,
        runId: claim.runId,
        entity: record.entity,
        externalId: record.payload.externalId,
        parentExternalId: parentExternalId(record),
        payload: record.payload,
        payloadHash: hashImportValue(record.payload),
      })),
    )
    .onConflictDoUpdate({
      target: [importRecords.runId, importRecords.entity, importRecords.externalId],
      set: {
        payload: sql`excluded.payload`,
        payloadHash: sql`excluded.payload_hash`,
        parentExternalId: sql`excluded.parent_external_id`,
      },
    });
  return page.records.length - known.length;
}

/** The caller commits one page: records, progress and cursor either all survive or all roll back. */
export async function storeImportPage(
  tx: DbTransaction,
  claim: ImportClaim,
  entity: ImportEntity,
  request: unknown,
): Promise<void> {
  if (claim.phase !== 'extracting') throw new ImportClaimLost();
  importEntitySchema.parse(entity);
  const page = validatedPage(entity, request);
  await renewImportClaim(tx, claim);
  const [run] = await tx
    .select({ cursors: importRuns.cursors, counts: importRuns.counts })
    .from(importRuns)
    .where(eq(importRuns.id, claim.runId));
  if (!run) throw new ImportClaimLost();
  const checkpoints = extractionCheckpointsSchema.parse(run.cursors);
  const previous = checkpoints[entity];
  if (
    previous?.done ||
    (previous &&
      page.cursor !== null &&
      hashImportValue(previous.cursor) === hashImportValue(page.cursor))
  )
    throw new ConnectorError('invalid-response');
  const added = await upsertExtractedRecords(tx, claim, entity, page);
  const extracted = extractedCountsSchema.parse(
    run.counts.extracted === undefined ? {} : run.counts.extracted,
  );
  extracted[entity] = (extracted[entity] ?? 0) + added;
  checkpoints[entity] = { cursor: page.cursor, done: page.cursor === null };
  const { retryAt: _retryAt, retryFailures: _retryFailures, ...counts } = run.counts;
  await tx
    .update(importRuns)
    .set({ cursors: checkpoints, counts: { ...counts, extracted } })
    .where(eq(importRuns.id, claim.runId));
}
