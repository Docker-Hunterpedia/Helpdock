import {
  attachments,
  brands,
  type Db,
  type DbTransaction,
  importLog,
  importRecords,
  importRuns,
  uuidv7,
} from '@helpdock/db';
import { type Connector, type ConnectorContext, hashImportValue } from '@helpdock/importers';
import { importRecordSchema } from '@helpdock/schemas';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { enqueueAttachmentUploaded } from '../../media/attachment-events.js';
import { PolicyRefusal, readContentPolicy } from '../../media/content-policy.js';
import { attachmentKey } from '../../media/keys.js';
import { enqueueObjectPurge } from '../../media/object-purge.js';
import type { ObjectStorage } from '../../media/storage.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { ImportLoadError } from '../loader/contracts.js';
import { importedIdentity } from '../loader/external-ids.js';
import { importAttachmentHash, lockImportedAttachments } from '../loader/load-attachments.js';
import { ImportClaimLost, importClaimSchema, renewImportClaim } from './claims.js';
import { withPreparedImportFile } from './prepare-file.js';

const requestSchema = z.strictObject({ claim: importClaimSchema, recordId: z.uuid() });
const resultSchema = z.strictObject({
  state: z.enum(['downloaded', 'processing', 'ready', 'rejected']),
  attachmentId: z.uuid(),
});
type Request = z.infer<typeof requestSchema>;
type Dependencies<Credentials> = {
  db: Db;
  jobId: string;
  storage: ObjectStorage;
  connector: Connector<Credentials>;
  context: ConnectorContext<Credentials>;
};

async function reserveDownload(tx: DbTransaction, request: Request, source: string) {
  const { claim } = request;
  await renewImportClaim(tx, claim);
  const [run] = await tx
    .select({ source: importRuns.source })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
  if (!run || run.source !== source) throw new ImportLoadError('mapping-invalid');
  const [staged] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, claim.brandId),
        eq(importRecords.runId, claim.runId),
        eq(importRecords.id, request.recordId),
      ),
    );
  if (staged?.status !== 'loaded') throw new ImportLoadError('mapping-invalid');
  const native = importRecordSchema.parse({ entity: staged.entity, payload: staged.payload });
  if (
    native.entity !== 'attachment' ||
    native.payload.externalId !== staged.externalId ||
    hashImportValue(native.payload) !== staged.payloadHash
  )
    throw new ImportLoadError('mapping-invalid');
  const { ticketExternalId: _ticket, messageExternalId: _message, ...ref } = native.payload;
  const scope = { brandId: claim.brandId, source: run.source };
  const pointer = await importedIdentity(tx, scope, 'attachment', ref.externalId);
  const hash = importAttachmentHash(ref);
  if (!pointer || pointer.payloadHash !== hash) throw new ImportLoadError('mapping-invalid');
  // Use the same shared-asset lock as link reconciliation, without widening tenant scope.
  await lockImportedAttachments(tx, scope);
  const [row] = await tx
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.brandId, claim.brandId),
        eq(attachments.origin, 'import'),
        or(
          eq(attachments.id, pointer.helpdockId),
          eq(attachments.copiedFromAttachmentId, pointer.helpdockId),
        ),
      ),
    )
    .orderBy(attachments.id)
    .limit(1)
    .for('update');
  if (!row) throw new ImportLoadError('target-unavailable');
  if (row.status !== 'pending')
    return resultSchema.parse({
      state: row.status === 'infected' ? 'rejected' : row.status,
      attachmentId: row.id,
    });
  const attempt = uuidv7();
  const key = attachmentKey(
    { brandId: claim.brandId, ticketId: row.ticketId, attachmentId: attempt },
    'original',
  );
  await tx
    .update(attachments)
    .set({ s3Key: key })
    .where(
      and(
        eq(attachments.brandId, claim.brandId),
        eq(attachments.origin, 'import'),
        eq(attachments.s3Key, row.s3Key),
        eq(attachments.status, 'pending'),
      ),
    );
  // Old attempt keys stay in a durable cleanup event; no object deletion occurs in this transaction.
  await enqueueObjectPurge(tx, claim.brandId, [{ ...row, id: attempt }]);
  const [brand] = await tx
    .select({ settings: brands.settings })
    .from(brands)
    .where(eq(brands.id, claim.brandId));
  if (!brand) throw new ImportClaimLost();
  return {
    state: 'reserved' as const,
    row,
    key,
    ref,
    policy: readContentPolicy(brand.settings.contentPolicy),
  };
}

/** Network and storage work run outside transactions; only a live claim may publish processing. */
export async function downloadStagedImportAttachment<Credentials>(
  deps: Dependencies<Credentials>,
  request: Request,
) {
  const parsed = requestSchema.parse(request);
  if (parsed.claim.phase !== 'loading') throw new ImportClaimLost();
  const context = {
    ...deps.context,
    credentials: deps.connector.credentialsSchema.parse(deps.context.credentials),
  };
  const inRun = <T>(work: (tx: DbTransaction) => Promise<T>) =>
    withSystemJob(deps.db, parsed.claim.brandId, deps.jobId, work);
  const snapshot = await inRun((tx) => reserveDownload(tx, parsed, deps.connector.source));
  if (snapshot.state !== 'reserved') return snapshot;
  try {
    const downloaded = await deps.connector.fetchAttachment(context, snapshot.ref);
    return await withPreparedImportFile(
      {
        stream: downloaded.stream,
        policy: snapshot.policy,
        signal: context.signal,
        contentType: snapshot.ref.contentType ?? downloaded.contentType,
        declaredSize: downloaded.size,
      },
      async (file) => {
        await inRun((tx) => renewImportClaim(tx, parsed.claim));
        await deps.storage.upload({ key: snapshot.key, path: file.path, contentType: file.mime });
        await inRun(async (tx) => {
          await renewImportClaim(tx, parsed.claim);
          const changed = await tx
            .update(attachments)
            .set({
              status: 'processing',
              size: file.size,
              mime: file.mime,
              kind: file.kind,
            })
            .where(
              and(
                eq(attachments.brandId, parsed.claim.brandId),
                eq(attachments.origin, 'import'),
                eq(attachments.s3Key, snapshot.key),
                eq(attachments.status, 'pending'),
              ),
            )
            .returning({ id: attachments.id });
          if (!changed.some((row) => row.id === snapshot.row.id))
            throw new ImportLoadError('target-unavailable');
          await enqueueAttachmentUploaded(tx, parsed.claim.brandId, {
            attachmentId: snapshot.row.id,
            ticketId: snapshot.row.ticketId,
          });
        });
        return resultSchema.parse({ state: 'downloaded', attachmentId: snapshot.row.id });
      },
    );
  } catch (error) {
    if (!(error instanceof PolicyRefusal)) {
      // A revoked upload can finish after the next attempt's cleanup. Queue its key again,
      // while preserving any attempt still named by a live attachment row.
      await inRun((tx) =>
        enqueueObjectPurge(tx, parsed.claim.brandId, [
          {
            id: uuidv7(),
            brandId: parsed.claim.brandId,
            ticketId: snapshot.row.ticketId,
            s3Key: snapshot.key,
          },
        ]),
      );
      throw error;
    }
    await inRun(async (tx) => {
      await renewImportClaim(tx, parsed.claim);
      await tx
        .update(attachments)
        .set({ status: 'rejected', rejectReason: error.reason, processedAt: new Date() })
        .where(
          and(
            eq(attachments.brandId, parsed.claim.brandId),
            eq(attachments.origin, 'import'),
            eq(attachments.s3Key, snapshot.key),
            eq(attachments.status, 'pending'),
          ),
        );
      await tx.insert(importLog).values({
        brandId: parsed.claim.brandId,
        runId: parsed.claim.runId,
        entity: 'attachment',
        externalId: snapshot.ref.externalId,
        level: 'warning',
        message: 'import.attachment.rejected',
      });
    });
    return resultSchema.parse({ state: 'rejected', attachmentId: snapshot.row.id });
  }
}
