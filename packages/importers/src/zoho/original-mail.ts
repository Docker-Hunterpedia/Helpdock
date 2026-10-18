import type { ImportMessage } from '@helpdock/schemas';
import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema, type zohoThreadSchema } from './contracts.js';
import { zohoEmailAddresses } from './history-content.js';

const headerLine = z.string().regex(/^[^\r\n\0]*$/);
const originalMailSchema = z.object({
  date: headerLine.max(1000),
  returnPath: headerLine.max(1000),
  subject: headerLine.max(10000),
  messageId: headerLine.min(1).max(998),
  from: headerLine.max(10000),
  to: headerLine.max(100000),
});
type MailProjection = {
  email: NonNullable<ImportMessage['email']>;
  details: NonNullable<ImportMessage['sourceDetails']>;
};

function matchingAddresses(original: string, detail?: string | null): string[] {
  const addresses = zohoEmailAddresses(original);
  if (detail?.trim()) {
    const addressListKey = (list: string[]) =>
      list
        .map((address) => address.toLowerCase())
        .sort()
        .join('\n');
    if (addressListKey(addresses) !== addressListKey(zohoEmailAddresses(detail)))
      throw new ConnectorError('invalid-response');
  }
  return addresses;
}

function originalMailProjection(
  original: z.infer<typeof originalMailSchema>,
  thread: z.infer<typeof zohoThreadSchema>,
): MailProjection {
  const from = matchingAddresses(original.from, thread.fromEmailAddress);
  const to = matchingAddresses(original.to, thread.to);
  if (from.length !== 1) throw new ConnectorError('invalid-response');
  const sent = Date.parse(original.date);
  return {
    email: {
      messageId: original.messageId,
      from: from[0],
      to,
      cc: zohoEmailAddresses(thread.cc),
      sentAt: Number.isFinite(sent) ? new Date(sent).toISOString() : null,
    },
    details: {
      mailSubject: original.subject,
      mailDate: original.date,
      mailReturnPath: original.returnPath,
    },
  };
}

/** The raw MIME field is deliberately stripped by the boundary schema, never staged or logged. */
export async function readZohoOriginalMail(
  client: ZohoDeskClient,
  ticketId: string,
  thread: z.infer<typeof zohoThreadSchema>,
): Promise<Partial<MailProjection>> {
  if (thread.channel.toUpperCase() !== 'EMAIL' || thread.status !== 'SUCCESS') return {};
  const path = `/api/v1/tickets/${zohoIdSchema.parse(ticketId)}/threads/${zohoIdSchema.parse(thread.id)}/originalContent`;
  let original: z.infer<typeof originalMailSchema>;
  try {
    original = await client.json(path, originalMailSchema, { inline: 'false' });
  } catch (error) {
    if (
      !(error instanceof ConnectorError) ||
      error.code !== 'record-unavailable' ||
      ![404, 410].includes(error.status ?? 0)
    )
      throw error;
    await client.warnHistory('import.zoho.original-mail-unavailable', `thread:${thread.id}`);
    return {};
  }
  const mail = originalMailProjection(original, thread);
  if (mail.email.sentAt === null)
    await client.warnHistory('import.zoho.mail-date-unparsed', `thread:${thread.id}`);
  return mail;
}
