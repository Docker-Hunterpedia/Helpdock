import { sanitizeMessageBody } from '@helpdock/channels';
import { type DbTransaction, ticketMessages, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import type { ImportMessage } from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import { importEmailMeta } from './email-meta.js';
import { importedIdentity, importSourceAccountKey, rememberImported } from './external-ids.js';
import {
  loadImportedAttachment,
  lockImportedAttachments,
  reconcileImportedMessageAttachments,
} from './load-attachments.js';
import { importedAuthor } from './load-authors.js';

function plainHtml(text: string): string {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<p>${escaped.replaceAll(/\r?\n/g, '<br>')}</p>`;
}

/** Download URLs expire and change independently of the historical message. */
export function importMessageHash(message: ImportMessage): string {
  return hashImportValue({
    ...message,
    attachments: message.attachments.map(
      ({ url: _url, bundlePath: _path, ...identity }) => identity,
    ),
  });
}

async function insertImportedMessage(
  tx: DbTransaction,
  options: { input: TicketLoad; message: ImportMessage; ticketId: string; sequence: number },
): Promise<void> {
  const { input, message } = options;
  const author = await importedAuthor(tx, input, message);
  const messageBody = sanitizeMessageBody(message.bodyHtml ?? plainHtml(message.bodyText ?? ''));
  const messageId = uuidv7();
  await tx.insert(ticketMessages).values({
    id: messageId,
    brandId: input.brandId,
    departmentId: input.resolved.departmentId,
    ticketId: options.ticketId,
    seq: options.sequence,
    kind: message.public ? 'public' : 'note',
    ...author,
    bodyHtml: messageBody.html,
    bodyText: messageBody.text,
    channel: input.resolved.channel,
    externalMessageId: message.email?.messageId ?? null,
    importSourceAccountKey: await importSourceAccountKey(tx, input),
    email: importEmailMeta(message),
    createdAt: new Date(message.createdAt),
  });
  for (const ref of message.attachments)
    await loadImportedAttachment(tx, {
      input,
      ticketId: options.ticketId,
      messageId,
      createdAt: message.createdAt,
      ref,
    });
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    runId: input.runId,
    entity: 'message',
    externalId: message.externalId,
    helpdockId: messageId,
    payloadHash: importMessageHash(message),
  });
}

async function updateImportedMessage(
  tx: DbTransaction,
  input: TicketLoad,
  message: ImportMessage,
  messageId: string,
  ticketId: string,
): Promise<void> {
  await reconcileImportedMessageAttachments(tx, input, ticketId, messageId, message);
  const author = await importedAuthor(tx, input, message);
  const messageBody = sanitizeMessageBody(message.bodyHtml ?? plainHtml(message.bodyText ?? ''));
  await tx
    .update(ticketMessages)
    .set({
      ...author,
      kind: message.public ? 'public' : 'note',
      bodyHtml: messageBody.html,
      bodyText: messageBody.text,
      email: importEmailMeta(message),
      externalMessageId: message.email?.messageId ?? null,
      importSourceAccountKey: await importSourceAccountKey(tx, input),
      createdAt: new Date(message.createdAt),
    })
    .where(and(eq(ticketMessages.id, messageId), eq(ticketMessages.brandId, input.brandId)));
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    runId: input.runId,
    entity: 'message',
    externalId: message.externalId,
    helpdockId: messageId,
    payloadHash: importMessageHash(message),
  });
}

async function requireImportedMessageTarget(
  tx: DbTransaction,
  input: TicketLoad,
  messageId: string,
  ticketId: string,
) {
  const [target] = await tx
    .select()
    .from(ticketMessages)
    .where(and(eq(ticketMessages.id, messageId), eq(ticketMessages.brandId, input.brandId)))
    .for('update');
  if (!target) throw new ImportLoadError('target-unavailable');
  if (target.ticketId !== ticketId) throw new ImportLoadError('duplicate-source-message');
  return target;
}

/** Validate source receipts before the ticket fingerprint can short-circuit a repeat. */
export async function requireImportedMessageTargets(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
): Promise<void> {
  for (const message of input.messages) {
    const existing = await importedIdentity(tx, input, 'message', message.externalId);
    if (existing) await requireImportedMessageTarget(tx, input, existing.helpdockId, ticketId);
  }
}

export async function loadImportedMessages(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
): Promise<number> {
  await lockImportedAttachments(tx, input);
  const [maximum] = await tx
    .select({ seq: sql<number>`coalesce(max(${ticketMessages.seq}), 0)` })
    .from(ticketMessages)
    .where(eq(ticketMessages.ticketId, ticketId));
  let sequence = maximum?.seq ?? 0;
  let appended = 0;
  for (const message of [...input.messages].sort(
    (first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt),
  )) {
    const existing = await importedIdentity(tx, input, 'message', message.externalId);
    if (existing) {
      const target = await requireImportedMessageTarget(tx, input, existing.helpdockId, ticketId);
      const author = await importedAuthor(tx, input, message);
      if (
        existing.payloadHash !== importMessageHash(message) ||
        target.authorType !== author.authorType ||
        target.authorId !== author.authorId ||
        target.authorDisplay !== author.authorDisplay
      )
        await updateImportedMessage(tx, input, message, existing.helpdockId, ticketId);
      continue;
    }
    sequence += 1;
    await insertImportedMessage(tx, { input, message, ticketId, sequence });
    appended += 1;
  }
  return appended;
}
