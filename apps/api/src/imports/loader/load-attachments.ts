import { attachments, type DbTransaction, importExternalIds, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { type ImportAttachmentRef, type ImportMessage, safeFileName } from '@helpdock/schemas';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { attachmentKey } from '../../media/keys.js';
import { enqueueObjectPurge } from '../../media/object-purge.js';
import type { TicketLoad } from './contracts.js';
import { importedIdentity, importSourceAccountKey } from './external-ids.js';

/** Shared assets span tickets; serialize their reconciliation within one brand/source. */
export async function lockImportedAttachments(
  tx: DbTransaction,
  input: Pick<TicketLoad, 'brandId' | 'source'>,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.brandId}:${input.source}:assets`}, 18))`,
  );
}

export function importAttachmentHash(ref: ImportAttachmentRef): string {
  return hashImportValue({
    externalId: ref.externalId,
    fileName: ref.fileName,
    size: ref.size ?? null,
    contentType: ref.contentType ?? null,
  });
}

export async function loadImportedAttachment(
  tx: DbTransaction,
  options: {
    input: TicketLoad;
    ticketId: string;
    messageId: string;
    createdAt: string;
    ref: ImportAttachmentRef;
  },
): Promise<string> {
  const { input, ref } = options;
  const payloadHash = importAttachmentHash(ref);
  const known = await importedIdentity(tx, input, 'attachment', ref.externalId);
  const [original] =
    known?.payloadHash === payloadHash
      ? await tx
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.brandId, input.brandId),
              eq(attachments.origin, 'import'),
              or(
                eq(attachments.id, known.helpdockId),
                eq(attachments.copiedFromAttachmentId, known.helpdockId),
              ),
            ),
          )
          .orderBy(attachments.id)
          .limit(1)
      : [];
  if (original) {
    const [linked] = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.brandId, input.brandId),
          eq(attachments.messageId, options.messageId),
          eq(attachments.origin, 'import'),
          eq(attachments.s3Key, original.s3Key),
        ),
      )
      .limit(1);
    if (linked) return linked.id;
  }
  const attachmentId = uuidv7();
  await tx.insert(attachments).values({
    id: attachmentId,
    brandId: input.brandId,
    departmentId: input.resolved.departmentId,
    ticketId: options.ticketId,
    messageId: options.messageId,
    origin: 'import',
    uploaderType: 'system',
    uploaderId: `import:${input.runId}`,
    s3Key:
      original?.s3Key ??
      attachmentKey(
        { brandId: input.brandId, ticketId: options.ticketId, attachmentId },
        'original',
      ),
    copiedFromAttachmentId: original?.copiedFromAttachmentId ?? original?.id ?? null,
    originalName: safeFileName(ref.fileName),
    mime: original?.mime ?? ref.contentType ?? 'application/octet-stream',
    size: original?.size ?? ref.size ?? 0,
    kind: original?.kind ?? 'file',
    status: original?.status ?? 'pending',
    variants: original?.variants ?? {},
    scanStatus: original?.scanStatus ?? 'skipped',
    rejectReason: original?.rejectReason ?? null,
    processedAt: original?.processedAt ?? null,
    createdAt: new Date(options.createdAt),
  });
  if (original) return attachmentId;
  // A file purged with its old ticket may be re-fetched for a new delta message.
  await tx
    .insert(importExternalIds)
    .values({
      brandId: input.brandId,
      source: input.source,
      sourceAccountKey: await importSourceAccountKey(tx, input),
      entity: 'attachment',
      externalId: ref.externalId,
      helpdockId: attachmentId,
      payloadHash,
    })
    .onConflictDoUpdate({
      target: [
        importExternalIds.brandId,
        importExternalIds.source,
        importExternalIds.sourceAccountKey,
        importExternalIds.entity,
        importExternalIds.externalId,
      ],
      set: { helpdockId: attachmentId, payloadHash },
    });
  return attachmentId;
}

/** Reconcile only source-owned links; shared objects and ordinary uploads remain available. */
export async function reconcileImportedMessageAttachments(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
  messageId: string,
  message: ImportMessage,
): Promise<void> {
  const retained = new Set<string>();
  for (const ref of message.attachments)
    retained.add(
      await loadImportedAttachment(tx, {
        input,
        ticketId,
        messageId,
        createdAt: message.createdAt,
        ref,
      }),
    );
  const rows = await tx
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.brandId, input.brandId),
        eq(attachments.messageId, messageId),
        eq(attachments.origin, 'import'),
      ),
    )
    .for('update');
  const removed = rows.filter((row) => !retained.has(row.id));
  if (!removed.length) return;
  await enqueueObjectPurge(tx, input.brandId, removed);
  await tx.delete(attachments).where(
    and(
      eq(attachments.brandId, input.brandId),
      inArray(
        attachments.id,
        removed.map((row) => row.id),
      ),
    ),
  );
}
