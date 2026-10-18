import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { isInvalidUtf8 } from '../utf8.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema, zohoThreadSchema } from './contracts.js';

function zohoBodyMime(contentType: string): 'text/html' | 'text/plain' {
  switch (contentType.toLowerCase()) {
    case 'html':
    case 'text/html':
      return 'text/html';
    case 'plaintext':
    case 'text/plain':
      return 'text/plain';
    default:
      throw new ConnectorError('invalid-response');
  }
}

export function zohoBody(content: string, contentType: string, plainText?: string | null) {
  return zohoBodyMime(contentType) === 'text/html'
    ? { bodyHtml: content, ...(plainText == null ? {} : { bodyText: plainText }) }
    : { bodyText: content };
}

/** Never mistake the documented truncated detail for the complete historical body. */
export async function readZohoThread(
  client: ZohoDeskClient,
  rawTicketId: string,
  rawThreadId: string,
) {
  const ticketId = zohoIdSchema.parse(rawTicketId),
    threadId = zohoIdSchema.parse(rawThreadId);
  const path = `/api/v1/tickets/${ticketId}/threads/${threadId}`;
  const thread = await client.json(path, zohoThreadSchema, { include: 'plainText' });
  if (thread.id !== threadId) throw new ConnectorError('invalid-response');
  if (!thread.isContentTruncated)
    return { thread, body: zohoBody(thread.content, thread.contentType, thread.plainText) };
  if (!thread.fullContentURL) return client.refuseFullContent(`thread:${threadId}`);
  const fullUrl = client.resource(thread.fullContentURL, `${path}/fullContent`);
  const response = await client.request(fullUrl);
  const header = response.headers['content-type'];
  const type = (Array.isArray(header) ? header[0] : header)?.split(';')[0]?.trim().toLowerCase();
  const expected = zohoBodyMime(thread.contentType);
  if (
    !type ||
    !['text/html', 'text/plain'].includes(type) ||
    type !== expected ||
    response.body.length > 2 * 1024 * 1024
  )
    return client.refuseFullContent(`thread:${threadId}`);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch (error) {
    if (isInvalidUtf8(error)) return client.refuseFullContent(`thread:${threadId}`);
    throw error;
  }
  await client.warnHistory('import.zoho.full-content-format-inferred', `thread:${threadId}`);
  return { thread, body: zohoBody(content, type) };
}

/** Desk email fields are RFC display-name lists; reject an unrepresentable address rather than omit it. */
export function zohoEmailAddresses(value?: string | null): string[] {
  if (value == null || value.trim() === '') return [];
  if (/[\r\n\0]/.test(value)) throw new ConnectorError('invalid-response');
  const parts = value.match(/(?:"[^"]*"|[^,])+/g) ?? [];
  return parts.map((part) => {
    const angle = /<([^<>]+)>/.exec(part);
    if (
      angle &&
      (part.slice(angle.index + angle[0].length).trim() || /[<>]/.test(part.slice(0, angle.index)))
    )
      throw new ConnectorError('invalid-response');
    const address = angle?.[1]?.trim() ?? part.trim();
    const parsed = z.email().max(320).safeParse(address);
    if (!parsed.success) throw new ConnectorError('invalid-response');
    return parsed.data;
  });
}
