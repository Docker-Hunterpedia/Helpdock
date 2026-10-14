import { sanitizeMessageBody } from '@helpdock/channels';
import { type DbTransaction, ticketMessages, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import type { ImportMessage } from '@helpdock/schemas';
import { eq, sql } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import { importEmailMeta } from './email-meta.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import { loadImportedAttachment, lockImportedAttachments } from './load-attachments.js';
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
    entity: 'message',
    externalId: message.externalId,
    helpdockId: messageId,
    payloadHash: importMessageHash(message),
  });
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
      const [target] = await tx
        .select({ ticketId: ticketMessages.ticketId })
        .from(ticketMessages)
        .where(eq(ticketMessages.id, existing.helpdockId));
      if (target && target.ticketId !== ticketId)
        throw new ImportLoadError('duplicate-source-message');
      continue;
    }
    sequence += 1;
    await insertImportedMessage(tx, { input, message, ticketId, sequence });
    appended += 1;
  }
  return appended;
}
