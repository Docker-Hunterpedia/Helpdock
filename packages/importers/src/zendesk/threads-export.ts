import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import { ticketAudits } from './audits-export.js';
import type { ZendeskClient } from './client.js';
import {
  type zendeskAttachmentSchema,
  zendeskCommentPageSchema,
  type zendeskCommentSchema,
  zendeskCursorEnvelopeSchema,
  zendeskCursorSchema,
} from './contracts.js';

const threadCursorSchema = z.strictObject({
  mode: z.enum(['message', 'attachment', 'activity']),
  tickets: zendeskCursorSchema,
  ticketOffset: z.int().nonnegative().default(0),
  ticketFingerprint: z.string().optional(),
  commentAfter: z.string().optional(),
  commentOffset: z.int().nonnegative().default(0),
  commentFingerprint: z.string().optional(),
  audit: z
    .strictObject({
      page: z.int().positive(),
      offset: z.int().nonnegative(),
      fingerprint: z.string().optional(),
    })
    .optional(),
});
export type ThreadCursor = z.infer<typeof threadCursorSchema>;

function attachmentRef(attachment: z.infer<typeof zendeskAttachmentSchema>) {
  return {
    externalId: String(attachment.id),
    fileName: attachment.file_name,
    url: attachment.content_url,
    ...(attachment.content_type === undefined ? {} : { contentType: attachment.content_type }),
    ...(attachment.size === undefined ? {} : { size: attachment.size }),
  };
}

async function commentRecords(
  client: ZendeskClient,
  request: {
    mode: 'message' | 'attachment';
    ticketId: number;
    comment: z.infer<typeof zendeskCommentSchema>;
  },
): Promise<ImportRecord[]> {
  const { mode, ticketId, comment } = request;
  if (mode === 'attachment')
    return comment.attachments.map((attachment) =>
      importRecordSchema.parse({
        entity: 'attachment',
        payload: {
          ...attachmentRef(attachment),
          ticketExternalId: String(ticketId),
          messageExternalId: String(comment.id),
        },
      }),
    );
  const text = comment.plain_body ?? comment.body;
  return [
    importRecordSchema.parse({
      entity: 'message',
      payload: {
        externalId: String(comment.id),
        ticketExternalId: String(ticketId),
        authorExternalId: String(comment.author_id),
        authorKind: await client.authorKind(comment.author_id),
        public: comment.public,
        ...(comment.html_body == null ? {} : { bodyHtml: comment.html_body }),
        ...(text == null ? {} : { bodyText: text }),
        createdAt: comment.created_at,
        attachments: comment.attachments.map(attachmentRef),
      },
    }),
  ];
}

function cursorJson(cursor: ThreadCursor): ImportCursor {
  return z.record(z.string(), z.json()).parse(cursor);
}

async function* ticketComments(
  client: ZendeskClient,
  state: ThreadCursor & { mode: 'message' | 'attachment' },
  ticketId: number,
): AsyncGenerator<ImportPage> {
  const path = `/api/v2/tickets/${ticketId}/comments.json`;
  let checkpoint = state;
  while (true) {
    const page = await client.json(path, zendeskCommentPageSchema, {
      'page[size]': '100',
      ...(checkpoint.commentAfter === undefined ? {} : { 'page[after]': checkpoint.commentAfter }),
    });
    const fingerprint = hashImportValue(page.comments);
    if (
      (checkpoint.commentFingerprint && checkpoint.commentFingerprint !== fingerprint) ||
      checkpoint.commentOffset > page.comments.length
    )
      throw new ConnectorError('invalid-response');
    for (let index = checkpoint.commentOffset; index < page.comments.length; index++) {
      const comment = page.comments[index];
      if (!comment) throw new ConnectorError('invalid-response');
      yield {
        records: await commentRecords(client, {
          mode: state.mode,
          ticketId,
          comment,
        }),
        cursor: cursorJson({
          ...checkpoint,
          commentOffset: index + 1,
          commentFingerprint: fingerprint,
        }),
      };
    }
    if (!page.meta.has_more) return;
    const next = client.nextCommentCursor(page.links.next, path, page.meta.after_cursor);
    if (next === checkpoint.commentAfter) throw new ConnectorError('invalid-response');
    const { commentFingerprint: _fingerprint, ...continuation } = checkpoint;
    checkpoint = { ...continuation, commentAfter: next, commentOffset: 0 };
    yield { records: [], cursor: cursorJson(checkpoint) };
  }
}

export async function* exportZendeskThread(
  client: ZendeskClient,
  request: {
    mode: 'message' | 'attachment' | 'activity';
    cursor: ImportCursor | null;
    since: Date | undefined;
  },
): AsyncGenerator<ImportPage> {
  let checkpoint = threadCursorSchema.parse(
    request.cursor ?? {
      mode: request.mode,
      tickets: {
        startTime: request.since ? Math.max(0, Math.floor(request.since.getTime() / 1000)) : 0,
      },
    },
  );
  if (checkpoint.mode !== request.mode) throw new ConnectorError('invalid-response');
  const schema = zendeskCursorEnvelopeSchema.extend({
    tickets: z.array(z.looseObject({ id: z.int().positive() })).max(1000),
  });
  while (true) {
    const batch = await client.json('/api/v2/incremental/tickets/cursor.json', schema, {
      per_page: '100',
      support_type_scope: 'all',
      ...(checkpoint.tickets.after === undefined
        ? { start_time: String(checkpoint.tickets.startTime) }
        : { cursor: checkpoint.tickets.after }),
    });
    const fingerprint = hashImportValue(batch.tickets);
    if (
      (checkpoint.ticketFingerprint && checkpoint.ticketFingerprint !== fingerprint) ||
      checkpoint.ticketOffset > batch.tickets.length
    )
      throw new ConnectorError('invalid-response');
    for (let index = checkpoint.ticketOffset; index < batch.tickets.length; index++) {
      const ticket = batch.tickets[index];
      if (!ticket) throw new ConnectorError('invalid-response');
      const state = { ...checkpoint, ticketOffset: index, ticketFingerprint: fingerprint };
      if (request.mode === 'activity') yield* ticketAudits(client, state, ticket.id);
      else yield* ticketComments(client, { ...state, mode: request.mode }, ticket.id);
      checkpoint = {
        mode: request.mode,
        tickets: checkpoint.tickets,
        ticketOffset: index + 1,
        ticketFingerprint: fingerprint,
        commentOffset: 0,
      };
      yield { records: [], cursor: cursorJson(checkpoint) };
    }
    const next = {
      mode: request.mode,
      tickets: { after: batch.after_cursor },
      ticketOffset: 0,
      commentOffset: 0,
    };
    if (batch.end_of_stream) {
      yield { records: [], cursor: null, deltaCursor: cursorJson(next) };
      return;
    }
    checkpoint = next;
  }
}
