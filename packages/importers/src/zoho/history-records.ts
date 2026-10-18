import {
  type ImportMessage,
  importAttachmentRefSchema,
  importMessageSchema,
} from '@helpdock/schemas';
import type { z } from 'zod';
import { ConnectorError } from '../errors.js';
import type { ZohoDeskClient } from './client.js';
import type {
  zohoAttachmentSchema,
  zohoCommentSchema,
  zohoHistoryTicketSchema,
  zohoThreadSchema,
} from './contracts.js';
import { zohoBody, zohoEmailAddresses } from './history-content.js';
import { readZohoOriginalMail } from './original-mail.js';

type Author = NonNullable<z.infer<typeof zohoThreadSchema>['author']>;
type Ticket = z.infer<typeof zohoHistoryTicketSchema>;

async function historyAuthor(
  client: ZohoDeskClient,
  input: {
    author: Author | null;
    responderId?: string | null | undefined;
    sourceAuthorId?: string | null | undefined;
    ticket: Ticket;
    externalId: string;
  },
) {
  const { author, responderId, sourceAuthorId, ticket, externalId } = input;
  if (author?.id && sourceAuthorId && author.id !== sourceAuthorId)
    throw new ConnectorError('invalid-response');
  const declaredId = author?.id ?? sourceAuthorId;
  const name =
    author?.name?.trim() ||
    [author?.firstName, author?.lastName].filter(Boolean).join(' ').trim() ||
    author?.email;
  const display = name ? { authorName: name } : {};
  if (author?.type === 'AGENT') {
    if (declaredId && responderId && declaredId !== responderId)
      throw new ConnectorError('invalid-response');
    const id = declaredId ?? responderId;
    if (id) return { ...display, authorKind: 'agent' as const, authorExternalId: id };
  } else if (author?.type === 'END_USER') {
    if (declaredId)
      return { ...display, authorKind: 'customer' as const, authorExternalId: declaredId };
    if (
      author.email &&
      ticket.contact?.email &&
      author.email.toLowerCase() === ticket.contact.email.toLowerCase()
    ) {
      if (ticket.contact.id !== ticket.contactId) throw new ConnectorError('invalid-response');
      return { ...display, authorKind: 'customer' as const, authorExternalId: ticket.contactId };
    }
  } else if (author?.type === 'SYSTEM') return { ...display, authorKind: 'system' as const };
  await client.warnHistory('import.message.identity-unavailable', externalId);
  return { ...display, authorKind: 'system' as const };
}

export function zohoAttachmentRef(
  client: ZohoDeskClient,
  ticketId: string,
  kind: 'threads' | 'comments',
  messageId: string,
  attachment: z.infer<typeof zohoAttachmentSchema>,
) {
  const path = `/api/v1/tickets/${ticketId}/${kind}/${messageId}/attachments/${attachment.id}/content`;
  return importAttachmentRefSchema.parse({
    externalId: `t:${ticketId}:${kind}:${messageId}:a:${attachment.id}`,
    fileName: attachment.name,
    size: Number(attachment.size),
    url: client.resource(attachment.href, path),
  });
}

export async function zohoThreadMessage(
  client: ZohoDeskClient,
  ticket: Ticket,
  thread: z.infer<typeof zohoThreadSchema>,
  body: Pick<ImportMessage, 'bodyHtml' | 'bodyText'>,
) {
  const externalId = `thread:${thread.id}`;
  if (
    !['public', 'private'].includes(thread.visibility) ||
    !['in', 'out'].includes(thread.direction)
  )
    throw new ConnectorError('invalid-response');
  const unsent = thread.status !== 'SUCCESS';
  if (unsent) await client.warnHistory('import.message.unsent-thread', externalId);
  const mail = await readZohoOriginalMail(client, ticket.id, thread);
  const emailChannel = thread.channel.toUpperCase() === 'EMAIL';
  const from = emailChannel ? zohoEmailAddresses(thread.fromEmailAddress) : [];
  const to = emailChannel ? zohoEmailAddresses(thread.to) : [];
  const cc = emailChannel ? zohoEmailAddresses(thread.cc) : [];
  if (from.length > 1) throw new ConnectorError('invalid-response');
  if (!from.length && (to.length || cc.length)) throw new ConnectorError('invalid-response');
  return importMessageSchema.parse({
    externalId,
    ticketExternalId: ticket.id,
    ...(await historyAuthor(client, {
      author: thread.author,
      responderId: thread.responderId,
      ticket,
      externalId,
    })),
    public: thread.visibility === 'public' && !unsent,
    ...body,
    createdAt: thread.createdTime,
    via: `zoho:${thread.channel}:${thread.direction}:${thread.status}`,
    sourceDetails: {
      status: thread.status,
      channel: thread.channel,
      direction: thread.direction,
      authorKind:
        thread.author?.type === 'AGENT'
          ? 'agent'
          : thread.author?.type === 'END_USER'
            ? 'customer'
            : thread.author?.type === 'SYSTEM'
              ? 'system'
              : 'unknown',
      ...(thread.author ? { authorType: thread.author.type } : {}),
      ...mail.details,
    },
    ...(mail.email ? { email: mail.email } : from[0] ? { email: { from: from[0], to, cc } } : {}),
    attachments: thread.attachments.map((attachment) =>
      zohoAttachmentRef(client, ticket.id, 'threads', thread.id, attachment),
    ),
  });
}

export async function zohoCommentMessage(
  client: ZohoDeskClient,
  ticket: Ticket,
  comment: z.infer<typeof zohoCommentSchema>,
) {
  const externalId = `comment:${comment.id}`;
  return importMessageSchema.parse({
    externalId,
    ticketExternalId: ticket.id,
    ...(await historyAuthor(client, {
      author: comment.commenter,
      sourceAuthorId: comment.commenterId,
      ticket,
      externalId,
    })),
    public: comment.isPublic,
    createdAt: comment.commentedTime,
    via: 'zoho:comment',
    sourceDetails: {
      authorKind:
        comment.commenter?.type === 'AGENT'
          ? 'agent'
          : comment.commenter?.type === 'END_USER'
            ? 'customer'
            : comment.commenter?.type === 'SYSTEM'
              ? 'system'
              : 'unknown',
      ...(comment.commenter ? { authorType: comment.commenter.type } : {}),
    },
    ...zohoBody(comment.content, comment.contentType, comment.plainText),
    attachments: comment.attachments.map((attachment) =>
      zohoAttachmentRef(client, ticket.id, 'comments', comment.id, attachment),
    ),
  });
}
