import { attachments, type DbTransaction, importExternalIds, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { type ImportAttachmentRef, safeFileName } from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import type { TicketLoad } from './contracts.js';
import { importedIdentity } from './external-ids.js';

/** Acquire all shared asset locks in one order so concurrent ticket transactions cannot deadlock. */
export async function lockImportedAttachments(tx: DbTransaction, input: TicketLoad): Promise<void> {
  const ids = new Set(
    input.messages.flatMap((message) => message.attachments.map((ref) => ref.externalId)),
  );
  for (const id of [...ids].sort())
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.brandId}:${input.source}:${id}`}, 18))`,
    );
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
): Promise<void> {
  const { input, ref } = options;
  const known = await importedIdentity(tx, input, 'attachment', ref.externalId);
  const [original] = known
    ? await tx
        .select()
        .from(attachments)
        .where(and(eq(attachments.id, known.helpdockId), eq(attachments.brandId, input.brandId)))
    : [];
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
      `brands/${input.brandId}/imports/${input.runId}/attachments/${attachmentId}`,
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
  if (original) return;
  // A file purged with its old ticket may be re-fetched for a new delta message.
  const payloadHash = hashImportValue({
    externalId: ref.externalId,
    fileName: ref.fileName,
    size: ref.size ?? null,
    contentType: ref.contentType ?? null,
  });
  await tx
    .insert(importExternalIds)
    .values({
      brandId: input.brandId,
      source: input.source,
      entity: 'attachment',
      externalId: ref.externalId,
      helpdockId: attachmentId,
      payloadHash,
    })
    .onConflictDoUpdate({
      target: [
        importExternalIds.brandId,
        importExternalIds.source,
        importExternalIds.entity,
        importExternalIds.externalId,
      ],
      set: { helpdockId: attachmentId, payloadHash },
    });
}
