import { type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import {
  advanceImportTokenCycle,
  ConnectorError,
  hashImportValue,
  importRecordParent,
  importTokenCycleSchema,
  initialImportTokenCycle,
} from '@helpdock/importers';
import { type ImportEntity, importEntitySchema, importRecordSchema } from '@helpdock/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ImportClaim, ImportClaimLost, renewImportClaim } from './claims.js';

const cursorSchema = z.record(z.string().max(200), z.json());
const pageSchema = z
  .strictObject({
    records: z.array(importRecordSchema).max(1000),
    cursor: cursorSchema.nullable(),
    deltaCursor: cursorSchema.optional(),
  })
  .refine((page) => page.deltaCursor === undefined || page.cursor === null, {
    message: 'A delta watermark belongs only to the final page',
  });
const checkpointSchema = z
  .strictObject({
    cursor: cursorSchema.nullable(),
    done: z.boolean(),
    deltaCursor: cursorSchema.optional(),
    cycle: importTokenCycleSchema.optional(),
  })
  .refine(
    (checkpoint) =>
      checkpoint.done === (checkpoint.cursor === null) &&
      (checkpoint.deltaCursor === undefined || checkpoint.done) &&
      (checkpoint.cycle === undefined || !checkpoint.done),
    {
      message: 'Continuation and delta watermark must match the entity completion state',
    },
  );
export const extractionCheckpointsSchema = z.partialRecord(importEntitySchema, checkpointSchema);
const extractedCountsSchema = z.partialRecord(importEntitySchema, z.int().nonnegative());

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
  input: { entity: ImportEntity; page: z.infer<typeof pageSchema>; rejectConflicts: boolean },
): Promise<number> {
  const { entity, page } = input;
  if (!page.records.length) return 0;
  const known = await tx
    .select({ externalId: importRecords.externalId, hash: importRecords.payloadHash })
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
  if (input.rejectConflicts) {
    const hashes = new Map(known.map((row) => [row.externalId, row.hash]));
    if (
      page.records.some(
        (record) =>
          hashes.has(record.payload.externalId) &&
          hashes.get(record.payload.externalId) !== hashImportValue(record.payload),
      )
    )
      throw new ConnectorError('invalid-response');
  }
  await tx
    .insert(importRecords)
    .values(
      page.records.map((record) => ({
        brandId: claim.brandId,
        runId: claim.runId,
        entity: record.entity,
        externalId: record.payload.externalId,
        parentExternalId: importRecordParent(record),
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
    .select({ source: importRuns.source, cursors: importRuns.cursors, counts: importRuns.counts })
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
  let cycle = previous?.cycle ?? initialImportTokenCycle();
  if (!previous?.cycle && previous?.cursor)
    cycle = advanceImportTokenCycle(cycle, hashImportValue(previous.cursor));
  if (page.cursor !== null) cycle = advanceImportTokenCycle(cycle, hashImportValue(page.cursor));
  const added = await upsertExtractedRecords(tx, claim, {
    entity,
    page,
    rejectConflicts: run.source === 'file',
  });
  const extracted = extractedCountsSchema.parse(
    run.counts.extracted === undefined ? {} : run.counts.extracted,
  );
  extracted[entity] = (extracted[entity] ?? 0) + added;
  checkpoints[entity] = {
    cursor: page.cursor,
    done: page.cursor === null,
    ...(page.deltaCursor === undefined ? {} : { deltaCursor: page.deltaCursor }),
    ...(page.cursor === null ? {} : { cycle }),
  };
  const { retryAt: _retryAt, retryFailures: _retryFailures, ...counts } = run.counts;
  await tx
    .update(importRuns)
    .set({ cursors: checkpoints, counts: { ...counts, extracted } })
    .where(eq(importRuns.id, claim.runId));
}
