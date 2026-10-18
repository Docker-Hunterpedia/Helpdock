import { Readable } from 'node:stream';
import { type ImportAttachmentRef, importAttachmentRefSchema } from '@helpdock/schemas';
import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import type { ZohoDeskClient } from './client.js';
import { zohoCommentSchema, zohoIdSchema, zohoThreadSchema } from './contracts.js';
import { readZohoTicketAttachments } from './ticket-attachments.js';

function unavailable(error: unknown): boolean {
  return (
    error instanceof ConnectorError && (error.code === 'record-unavailable' || error.status === 403)
  );
}

/** Authenticated downloads are bound to one native parent; metadata is refreshed once after an asset refusal. */
export async function fetchZohoAttachment(client: ZohoDeskClient, raw: ImportAttachmentRef) {
  const ref = importAttachmentRefSchema.parse(raw);
  if (!ref.url) throw new ConnectorError('invalid-response');
  const locator = attachmentLocator(ref);
  const parent =
    locator.kind === 'ticket'
      ? `/api/v1/tickets/${locator.ticketId}`
      : `/api/v1/tickets/${locator.ticketId}/${locator.kind}/${locator.messageId}`;
  const path = `${parent}/attachments/${locator.attachmentId}/content`;
  const initial = client.resource(ref.url, path);
  let response: Awaited<ReturnType<ZohoDeskClient['request']>>;
  try {
    response = await client.request(initial);
  } catch (error) {
    if (!unavailable(error)) throw error;
    await client.warnAttachmentRefresh(ref.externalId);
    const file = await refreshedAttachment(client, locator, parent);
    if (file.name !== ref.fileName || (ref.size !== undefined && Number(file.size) !== ref.size))
      throw new ConnectorError('invalid-response');
    const refreshed = client.resource(file.href, path);
    try {
      response = await client.request(refreshed);
    } catch (retry) {
      if (unavailable(retry)) throw new ConnectorError('record-unavailable');
      throw retry;
    }
  }
  if (ref.size !== undefined && response.body.length !== ref.size)
    throw new ConnectorError('invalid-response');
  const contentType = response.headers['content-type'];
  return {
    stream: Readable.from(response.body),
    size: response.body.length,
    ...(typeof contentType === 'string' ? { contentType } : {}),
  };
}

function attachmentLocator(ref: ImportAttachmentRef) {
  const root = /^t:([1-9]\d*):ticket:a:([1-9]\d*)$/.exec(ref.externalId);
  if (root) {
    if (ref.sourcePage === undefined) throw new ConnectorError('invalid-response');
    return {
      kind: 'ticket' as const,
      ticketId: zohoIdSchema.parse(root[1]),
      attachmentId: zohoIdSchema.parse(root[2]),
      sourcePage: ref.sourcePage,
    };
  }
  const message = /^t:([1-9]\d*):(threads|comments):([1-9]\d*):a:([1-9]\d*)$/.exec(ref.externalId);
  if (!message) throw new ConnectorError('invalid-response');
  return {
    kind: z.enum(['threads', 'comments']).parse(message[2]),
    ticketId: zohoIdSchema.parse(message[1]),
    messageId: zohoIdSchema.parse(message[3]),
    attachmentId: zohoIdSchema.parse(message[4]),
  };
}

async function refreshedAttachment(
  client: ZohoDeskClient,
  locator: ReturnType<typeof attachmentLocator>,
  parent: string,
) {
  if (locator.kind === 'ticket') {
    const rows = await readZohoTicketAttachments(
      client,
      locator.ticketId,
      (locator.sourcePage - 1) * 100,
    );
    const file = rows.find((attachment) => attachment.id === locator.attachmentId);
    if (!file) throw new ConnectorError('invalid-response');
    return file;
  }
  const source =
    locator.kind === 'threads'
      ? await client.json(parent, zohoThreadSchema)
      : await client.json(parent, zohoCommentSchema);
  if (source.id !== locator.messageId) throw new ConnectorError('invalid-response');
  const file = source.attachments.find((attachment) => attachment.id === locator.attachmentId);
  if (!file) throw new ConnectorError('record-unavailable');
  return file;
}
