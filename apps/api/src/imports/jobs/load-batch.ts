import { type Db, type DbTransaction, importRecords } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { HC_BODY_MAX, type importArticleSchema, importRecordSchema } from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportClaim, ImportClaimLost, importClaimSchema } from './claims.js';
import { prepareApprovedImportLoad } from './load-approval.js';
import { loadAssembledStagedTicket } from './load-assembled-ticket.js';
import { loadNextStagedMetadata } from './load-next-metadata.js';
import { loadPreparedStagedRecord } from './load-prepared-record.js';
import { loadStagedReference } from './load-reference.js';
import { loadStagedCsat } from './load-staged-csat.js';

const requestSchema = z.strictObject({
  claim: importClaimSchema,
  batchSize: z.int().min(1).max(50).default(25),
  defaultCallingCode: z
    .string()
    .regex(/^\d{0,4}$/)
    .default(''),
});
const selectedSchema = z
  .array(
    z.object({
      id: z.uuid(),
      external_id: z.string(),
      payload: z.unknown(),
      payload_hash: z.string(),
    }),
  )
  .max(1);
const resultSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.enum(['more', 'records_loaded', 'stopped']),
    processed: z.int().nonnegative(),
  }),
  z.strictObject({
    state: z.literal('article_required'),
    processed: z.int().nonnegative(),
    recordId: z.uuid(),
  }),
]);
type ImportArticle = z.infer<typeof importArticleSchema>;
type Dependencies = {
  db: Db;
  jobId: string;
  prepareArticle?: (input: {
    claim: ImportClaim;
    recordId: string;
    record: ImportArticle;
  }) => Promise<string>;
};

async function nextRecord(tx: DbTransaction, request: z.infer<typeof requestSchema>) {
  const { claim } = request;
  if (!(await prepareApprovedImportLoad(tx, claim, request.defaultCallingCode)))
    return { state: 'stopped' as const };
  const metadata = await loadNextStagedMetadata(tx, {
    claim,
    defaultCallingCode: request.defaultCallingCode,
  });
  if (metadata.state !== 'metadata_done') return { state: 'processed' as const };
  // A translation cannot hide a later staged primary article in a reverse-ordered bundle.
  const articles = selectedSchema.parse(
    await tx.execute(sql`
    SELECT r.id, r.external_id, r.payload, r.payload_hash FROM import_records r
    WHERE r.brand_id = ${claim.brandId}::uuid AND r.run_id = ${claim.runId}::uuid
      AND r.entity = 'article' AND r.status = 'staged'
      AND (r.payload->>'translationOf' IS NULL OR (
        NOT EXISTS (SELECT 1 FROM import_records parent WHERE parent.brand_id = r.brand_id
          AND parent.run_id = r.run_id AND parent.entity = 'article'
          AND parent.external_id = r.payload->>'translationOf' AND parent.status <> 'loaded')
        AND (EXISTS (SELECT 1 FROM import_records parent WHERE parent.brand_id = r.brand_id
          AND parent.run_id = r.run_id AND parent.entity = 'article'
          AND parent.external_id = r.payload->>'translationOf' AND parent.status = 'loaded')
          OR EXISTS (SELECT 1 FROM import_external_ids pointer JOIN import_runs run ON run.id = r.run_id
            AND run.brand_id = r.brand_id WHERE pointer.brand_id = r.brand_id AND pointer.source = run.source
            AND pointer.source_account_key = run.source_account_key
            AND pointer.entity = 'article' AND pointer.external_id = r.payload->>'translationOf'))
      ))
    ORDER BY r.id LIMIT 1
  `),
  );
  if (articles[0]) {
    const article = importRecordSchema.parse({ entity: 'article', payload: articles[0].payload });
    if (
      article.entity !== 'article' ||
      article.payload.externalId !== articles[0].external_id ||
      hashImportValue(article.payload) !== articles[0].payload_hash
    )
      throw new ImportLoadError('mapping-invalid');
    return { state: 'article' as const, recordId: articles[0].id, record: article.payload };
  }
  const predicate = and(
    eq(importRecords.brandId, claim.brandId),
    eq(importRecords.runId, claim.runId),
    eq(importRecords.status, 'staged'),
  );
  const [blockedArticle] = await tx
    .select({ id: importRecords.id })
    .from(importRecords)
    .where(and(predicate, eq(importRecords.entity, 'article')))
    .limit(1);
  if (blockedArticle) throw new ImportLoadError('mapping-invalid');
  const [ticket] = await tx
    .select({ id: importRecords.id })
    .from(importRecords)
    .where(and(predicate, eq(importRecords.entity, 'ticket')))
    .orderBy(importRecords.id)
    .limit(1);
  if (ticket) {
    await loadAssembledStagedTicket(tx, { claim, recordId: ticket.id });
    return { state: 'processed' as const };
  }
  const [remaining] = await tx
    .select({ id: importRecords.id, entity: importRecords.entity })
    .from(importRecords)
    .where(predicate)
    .orderBy(importRecords.id)
    .limit(1);
  if (!remaining) return { state: 'records_loaded' as const };
  if (remaining.entity === 'csat') {
    await loadStagedCsat(tx, { claim, recordId: remaining.id });
    return { state: 'processed' as const };
  }
  if (!['group', 'tag', 'user'].includes(remaining.entity))
    throw new ImportLoadError('mapping-invalid');
  await loadStagedReference(tx, { claim, recordId: remaining.id });
  return { state: 'processed' as const };
}

/** Commits each record separately. Domain rows being loaded does not finish media or the run. */
export async function runImportLoadBatch(
  deps: Dependencies,
  request: z.input<typeof requestSchema>,
) {
  const parsed = requestSchema.parse(request);
  if (parsed.claim.phase !== 'loading') throw new ImportClaimLost();
  const inRun = <T>(work: (tx: DbTransaction) => Promise<T>) =>
    withSystemJob(deps.db, parsed.claim.brandId, deps.jobId, work);
  let processed = 0;
  try {
    while (processed < parsed.batchSize) {
      const next = await inRun((tx) => nextRecord(tx, parsed));
      if (next.state === 'processed') {
        processed++;
        continue;
      }
      if (next.state !== 'article') return resultSchema.parse({ ...next, processed });
      if (!deps.prepareArticle)
        return resultSchema.parse({
          state: 'article_required',
          recordId: next.recordId,
          processed,
        });
      const preparedBodyHtml = z
        .string()
        .max(HC_BODY_MAX)
        .parse(
          await deps.prepareArticle({
            claim: parsed.claim,
            recordId: next.recordId,
            record: next.record,
          }),
        );
      await inRun((tx) =>
        loadPreparedStagedRecord(tx, {
          claim: parsed.claim,
          defaultCallingCode: parsed.defaultCallingCode,
          recordId: next.recordId,
          preparedBodyHtml,
        }),
      );
      processed++;
    }
    return resultSchema.parse({ state: 'more', processed });
  } catch (error) {
    if (!(error instanceof ImportClaimLost)) throw error;
    return resultSchema.parse({ state: 'stopped', processed });
  }
}
