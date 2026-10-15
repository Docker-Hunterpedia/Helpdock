import { type DbTransaction, importRecords } from '@helpdock/db';
import {
  type ImportMessage,
  importTicketPreviewRequestSchema,
  importTicketPreviewSchema,
} from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type ImportRunRef, lockImportBrand } from '../jobs/claims.js';
import { previewStagedTicketChildren } from '../jobs/load-ticket-checkpoint.js';
import { ImportLoadError } from '../loader/contracts.js';
import { importedMessageBody } from '../loader/message-body.js';
import { requireImportPreviewRun } from './preview-run.js';
import { validatedStagedRecord } from './staged-record.js';

const MAX_PREVIEW_PAGE_BYTES = 4 * 1024 * 1024;

async function sourceAuthorName(tx: DbTransaction, scope: ImportRunRef, message: ImportMessage) {
  if (message.authorKind === 'system' || !message.authorExternalId) return null;
  const entity = message.authorKind === 'agent' ? 'user' : 'contact';
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, entity),
        eq(importRecords.externalId, message.authorExternalId),
      ),
    );
  if (!row) return null;
  const native = validatedStagedRecord(row);
  if (native.entity !== 'user' && native.entity !== 'contact')
    throw new ImportLoadError('mapping-invalid');
  if (native.entity === 'user' && native.payload.kind !== 'agent')
    throw new ImportLoadError('mapping-invalid');
  return native.payload.name;
}

async function previewTicketRoot(tx: DbTransaction, scope: ImportRunRef, externalId: string) {
  await requireImportPreviewRun(tx, scope);
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, 'ticket'),
        eq(importRecords.externalId, externalId),
      ),
    );
  if (!row) throw new ImportLoadError('target-unavailable');
  const native = validatedStagedRecord(row);
  if (native.entity !== 'ticket') throw new ImportLoadError('mapping-invalid');
  return native.payload;
}

/** Bounded thread reads and paged output, without source-link/download URL fields or mail transport headers. */
export async function previewImportedTicket(
  tx: DbTransaction,
  raw: z.input<typeof importTicketPreviewRequestSchema>,
) {
  const request = importTicketPreviewRequestSchema.parse(raw);
  const scope = { brandId: request.brandId, runId: request.runId };
  await lockImportBrand(tx, request.brandId);
  const sourceTicket = await previewTicketRoot(tx, scope, request.externalId);
  const children = await previewStagedTicketChildren(tx, scope, sourceTicket.externalId);
  const messages: ImportMessage[] = [];
  for (const child of children) {
    const record = validatedStagedRecord(child);
    if (
      'ticketExternalId' in record.payload &&
      record.payload.ticketExternalId !== sourceTicket.externalId
    )
      throw new ImportLoadError('mapping-invalid');
    if (record.entity === 'message') messages.push(record.payload);
  }
  messages.sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));
  const previews = [];
  let pageBytes = 0;
  for (const message of messages.slice(request.offset, request.offset + request.limit)) {
    const body = importedMessageBody(message);
    const preview = {
      externalId: message.externalId,
      authorKind: message.authorKind,
      authorExternalId: message.authorExternalId ?? null,
      sourceAuthorName: await sourceAuthorName(tx, scope, message),
      public: message.public,
      createdAt: message.createdAt,
      bodyHtml: body.html,
      bodyText: body.text,
      attachments: message.attachments.map(
        ({ url: _url, bundlePath: _bundle, ...metadata }) => metadata,
      ),
    };
    const bytes = Buffer.byteLength(JSON.stringify(preview));
    // A single large message remains readable; additional messages continue on the next page.
    if (previews.length > 0 && pageBytes + bytes > MAX_PREVIEW_PAGE_BYTES) break;
    previews.push(preview);
    pageBytes += bytes;
  }
  const { sourceUrl: _sourceUrl, ...ticket } = sourceTicket;
  const next = request.offset + previews.length;
  return importTicketPreviewSchema.parse({
    ticket,
    messages: previews,
    messageCount: messages.length,
    nextOffset: next < messages.length ? next : null,
  });
}
