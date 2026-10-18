import { importAttachmentRefSchema, importMessageSchema } from '@helpdock/schemas';
import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import type { ZohoDeskClient } from './client.js';
import { zohoTicketAttachmentSchema } from './contracts.js';

export async function readZohoTicketAttachments(
  client: ZohoDeskClient,
  ticketId: string,
  from: number,
) {
  if (!Number.isSafeInteger(from) || from < 0 || from % 100 !== 0 || from > 99999900)
    throw new ConnectorError('invalid-response');
  const page = await client.list(
    `/api/v1/tickets/${ticketId}/attachments`,
    z.object({ data: z.array(zohoTicketAttachmentSchema).max(100) }),
    {
      from: String(from),
      limit: '100',
      sortBy: 'createdTime',
      include: 'creator',
    },
  );
  if (new Set(page.data.map((file) => file.id)).size !== page.data.length)
    throw new ConnectorError('invalid-response');
  return page.data;
}

export function zohoTicketAttachmentRef(
  client: ZohoDeskClient,
  ticketId: string,
  file: z.infer<typeof zohoTicketAttachmentSchema>,
  from: number,
) {
  return importAttachmentRefSchema.parse({
    externalId: `t:${ticketId}:ticket:a:${file.id}`,
    fileName: file.name,
    size: Number(file.size),
    url: client.resource(file.href, `/api/v1/tickets/${ticketId}/attachments/${file.id}/content`),
    sourcePage: from / 100 + 1,
  });
}

export async function zohoTicketAttachmentMessage(
  client: ZohoDeskClient,
  ticketId: string,
  file: z.infer<typeof zohoTicketAttachmentSchema>,
  from: number,
) {
  if (file.creatorId && file.creator && file.creatorId !== file.creator.id)
    throw new ConnectorError('invalid-response');
  const externalId = `ticket-attachment:${file.id}`;
  const authorName =
    [file.creator?.firstName, file.creator?.lastName].filter(Boolean).join(' ').trim() ||
    file.creator?.email;
  const creatorId = file.creatorId ?? file.creator?.id;
  await client.warnHistory('import.message.identity-unavailable', externalId);
  return importMessageSchema.parse({
    externalId,
    ticketExternalId: ticketId,
    authorKind: 'system',
    ...(authorName ? { authorName } : {}),
    sourceDetails: { authorKind: 'unknown', authorType: creatorId ? `USER:${creatorId}` : 'USER' },
    public: file.isPublic,
    bodyText: '',
    createdAt: file.createdTime,
    attachments: [zohoTicketAttachmentRef(client, ticketId, file, from)],
    via: 'zoho:ticket-attachment',
  });
}
