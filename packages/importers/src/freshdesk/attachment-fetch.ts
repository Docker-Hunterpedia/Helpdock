import { Readable } from 'node:stream';
import { type ImportAttachmentRef, importAttachmentRefSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ConnectorContext } from '../connector.js';
import { ConnectorError } from '../errors.js';
import type { FreshdeskClient } from './client.js';
import {
  type FreshdeskCredentials,
  type freshdeskAttachmentSchema,
  freshdeskConversationSchema,
  freshdeskTicketSchema,
} from './contracts.js';

const locatorSchema = z.string().regex(/^t:[1-9]\d*:m:(?:description|[1-9]\d*):a:[1-9]\d*$/);

export function freshdeskAttachmentRef(
  ticketId: number,
  messageId: number | 'description',
  attachment: z.infer<typeof freshdeskAttachmentSchema>,
  sourcePage?: number,
): ImportAttachmentRef {
  return importAttachmentRefSchema.parse({
    externalId: `t:${ticketId}:m:${messageId}:a:${attachment.id}`,
    fileName: attachment.name,
    contentType: attachment.content_type,
    size: attachment.size,
    url: attachment.attachment_url,
    ...(sourcePage === undefined ? {} : { sourcePage }),
  });
}

function expired(error: unknown): boolean {
  return (
    error instanceof ConnectorError && (error.code === 'record-unavailable' || error.status === 403)
  );
}

async function refreshedUrl(client: FreshdeskClient, ref: ImportAttachmentRef): Promise<string> {
  const locator = locatorSchema.safeParse(ref.externalId);
  if (!locator.success) throw new ConnectorError('record-unavailable');
  const parts = locator.data.split(':');
  const ticketId = parts[1];
  const messageId = parts[3];
  const attachmentId = parts[5];
  let path = `/api/v2/tickets/${ticketId}`;
  let ticket: z.infer<typeof freshdeskTicketSchema>;
  try {
    ticket = await client.json(path, freshdeskTicketSchema);
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== 'record-unavailable') throw error;
    path = `/api/v2/tickets/archived/${ticketId}`;
    ticket = await client.json(path, freshdeskTicketSchema);
  }
  if (String(ticket.id) !== ticketId) throw new ConnectorError('invalid-response');
  if (messageId === 'description') {
    const attachment = ticket.attachments.find((item) => String(item.id) === attachmentId);
    if (!attachment) throw new ConnectorError('record-unavailable');
    return attachment.attachment_url;
  }
  if (ref.sourcePage === undefined) throw new ConnectorError('record-unavailable');
  const response = await client.page(`${path}/conversations`, freshdeskConversationSchema, {
    page: String(ref.sourcePage),
    per_page: '100',
  });
  const conversation = response.rows.find((item) => String(item.id) === messageId);
  if (!conversation) throw new ConnectorError('record-unavailable');
  if (String(conversation.ticket_id) !== ticketId) throw new ConnectorError('invalid-response');
  const attachment = conversation.attachments.find((item) => String(item.id) === attachmentId);
  if (!attachment) throw new ConnectorError('record-unavailable');
  return attachment.attachment_url;
}

/** Asset hosts never receive account credentials, including after refreshing an expired link. */
export async function fetchFreshdeskAttachment(
  context: ConnectorContext<FreshdeskCredentials>,
  client: FreshdeskClient,
  request: ImportAttachmentRef,
) {
  const ref = importAttachmentRefSchema.parse(request);
  if (!ref.url) throw new ConnectorError('invalid-response');
  const download = (url: string) => context.http.request(url, { signal: context.signal });
  let response: Awaited<ReturnType<typeof download>>;
  try {
    response = await download(ref.url);
  } catch (error) {
    if (!expired(error)) throw error;
    const url = await refreshedUrl(client, ref);
    try {
      response = await download(url);
    } catch (retry) {
      if (expired(retry)) throw new ConnectorError('record-unavailable');
      throw retry;
    }
  }
  const contentType = response.headers['content-type'];
  return {
    stream: Readable.from(response.body),
    size: response.body.length,
    ...(typeof contentType === 'string' ? { contentType } : {}),
  };
}
