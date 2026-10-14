import type { Db, DbTransaction } from '@helpdock/db';
import type { Connector, ConnectorContext } from '@helpdock/importers';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ObjectStorage } from '../../media/storage.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { ImportClaimLost, importClaimSchema, renewImportClaim } from './claims.js';
import { downloadStagedImportAttachment } from './download-attachment.js';
import { beginImportFinishing } from './finish-readiness.js';

const requestSchema = z.strictObject({
  claim: importClaimSchema,
  batchSize: z.int().min(1).max(4).default(4),
});
const selectedSchema = z.array(z.object({ id: z.uuid() })).max(4);
const resultSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.enum(['awaiting_media', 'stopped']),
    processed: z.int().nonnegative(),
  }),
  z.strictObject({
    state: z.literal('finishing'),
    processed: z.int().nonnegative(),
    claim: importClaimSchema,
  }),
]);

/** Downloads stay outside transactions; each publication and the phase boundary are fenced. */
export async function runImportAttachmentBatch<Credentials>(
  deps: {
    db: Db;
    jobId: string;
    storage: ObjectStorage;
    connector: Connector<Credentials>;
    context: ConnectorContext<Credentials>;
  },
  request: z.input<typeof requestSchema>,
) {
  const parsed = requestSchema.parse(request);
  if (parsed.claim.phase !== 'loading') throw new ImportClaimLost();
  const inRun = <T>(work: (tx: DbTransaction) => Promise<T>) =>
    withSystemJob(deps.db, parsed.claim.brandId, deps.jobId, work);
  let processed = 0;
  try {
    const selected = await inRun(async (tx) => {
      await renewImportClaim(tx, parsed.claim);
      return selectedSchema.parse(
        await tx.execute(sql`
        SELECT r.id FROM import_records r WHERE r.brand_id = ${parsed.claim.brandId}::uuid
          AND r.run_id = ${parsed.claim.runId}::uuid AND r.entity = 'attachment' AND r.status = 'loaded'
          AND EXISTS (SELECT 1 FROM attachments a WHERE a.brand_id = r.brand_id AND a.origin = 'import'
            AND (a.id = r.helpdock_id OR a.copied_from_attachment_id = r.helpdock_id) AND a.status = 'pending')
        ORDER BY r.id LIMIT ${parsed.batchSize}
      `),
      );
    });
    for (const record of selected) {
      await downloadStagedImportAttachment(deps, { claim: parsed.claim, recordId: record.id });
      processed++;
    }
    const claim = await inRun((tx) => beginImportFinishing(tx, parsed.claim));
    return resultSchema.parse(
      claim ? { state: 'finishing', claim, processed } : { state: 'awaiting_media', processed },
    );
  } catch (error) {
    if (!(error instanceof ImportClaimLost)) throw error;
    return resultSchema.parse({ state: 'stopped', processed });
  }
}
