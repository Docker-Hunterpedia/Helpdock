import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { validatedImportCursor } from '../cursor.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { TicketInventory } from '../ticket-inventory.js';
import { freshdeskAttachmentRef } from './attachment-fetch.js';
import type { FreshdeskClient } from './client.js';
import {
  type freshdeskAttachmentSchema,
  freshdeskConversationSchema,
  freshdeskTicketSchema,
} from './contracts.js';
import {
  freshdeskTicketCursorSchema,
  initialFreshdeskTicketCursor,
  readFreshdeskTicketPage,
} from './tickets-export.js';

const cursorSchema = z.strictObject({
  mode: z.enum(['message', 'attachment']),
  tickets: freshdeskTicketCursorSchema,
  ticketOffset: z.number().int().min(0).max(100).default(0),
  ticketFingerprint: z.string().length(64).optional(),
  descriptionDone: z.boolean().default(false),
  conversationPage: z.number().int().min(1).max(1000000).default(1),
  conversationOffset: z.number().int().min(0).max(100).default(0),
  conversationFingerprint: z.string().length(64).optional(),
});
type Cursor = z.infer<typeof cursorSchema>;

function attachmentRecords(
  ticketId: number,
  messageId: number | 'description',
  attachments: z.infer<typeof freshdeskAttachmentSchema>[],
  page?: number,
): ImportRecord[] {
  return attachments.map((attachment) =>
    importRecordSchema.parse({
      entity: 'attachment',
      payload: {
        ...freshdeskAttachmentRef(ticketId, messageId, attachment, page),
        ticketExternalId: String(ticketId),
        messageExternalId:
          messageId === 'description' ? `ticket:${ticketId}:description` : String(messageId),
      },
    }),
  );
}

async function descriptionRecords(
  client: FreshdeskClient,
  mode: Cursor['mode'],
  id: number,
  archived: boolean,
): Promise<ImportRecord[]> {
  // List embeds are not a guarantee that initial-message attachments are included.
  const ticket = await client.json(
    `/api/v2/tickets/${archived ? 'archived/' : ''}${id}`,
    freshdeskTicketSchema,
  );
  if (ticket.id !== id) throw new ConnectorError('invalid-response');
  if (mode === 'attachment') return attachmentRecords(id, 'description', ticket.attachments);
  if (ticket.source === 10) await client.warnOutboundAuthor(id);
  return [
    importRecordSchema.parse({
      entity: 'message',
      payload: {
        externalId: `ticket:${id}:description`,
        ticketExternalId: String(id),
        authorKind: ticket.source === 10 ? 'agent' : 'customer',
        ...(ticket.source === 10 ? {} : { authorExternalId: String(ticket.requester_id) }),
        public: true,
        createdAt: ticket.created_at,
        ...(ticket.description == null ? {} : { bodyHtml: ticket.description }),
        ...(ticket.description_text == null
          ? ticket.description == null
            ? { bodyText: '' }
            : {}
          : { bodyText: ticket.description_text }),
        attachments: ticket.attachments.map((attachment) =>
          freshdeskAttachmentRef(id, 'description', attachment),
        ),
      },
    }),
  ];
}

async function conversationRecords(
  client: FreshdeskClient,
  mode: Cursor['mode'],
  ticketId: number,
  conversation: z.infer<typeof freshdeskConversationSchema>,
  page: number,
): Promise<ImportRecord[]> {
  if (conversation.ticket_id !== ticketId) throw new ConnectorError('invalid-response');
  if (mode === 'attachment')
    return attachmentRecords(ticketId, conversation.id, conversation.attachments, page);
  const email = conversation.from_email
    ? z
        .email()
        .safeParse(
          conversation.from_email.match(/^[^<>\r\n]*<([^<>\r\n]+)>\s*$/)?.[1] ??
            conversation.from_email,
        )
    : null;
  if (email && !email.success) throw new ConnectorError('invalid-response');
  const authorKind = await client.authorKind(conversation.user_id);
  return [
    importRecordSchema.parse({
      entity: 'message',
      payload: {
        externalId: String(conversation.id),
        ticketExternalId: String(ticketId),
        authorKind,
        ...(authorKind === 'system'
          ? { authorName: `#${conversation.user_id}` }
          : { authorExternalId: String(conversation.user_id) }),
        public: !conversation.private,
        createdAt: conversation.created_at,
        ...(conversation.body == null ? {} : { bodyHtml: conversation.body }),
        ...(conversation.body_text == null
          ? conversation.body == null
            ? { bodyText: '' }
            : {}
          : { bodyText: conversation.body_text }),
        email: {
          ...(email?.success ? { from: email.data } : {}),
          ...(conversation.to_emails ? { to: conversation.to_emails } : {}),
          ...(conversation.cc_emails ? { cc: conversation.cc_emails } : {}),
        },
        attachments: conversation.attachments.map((attachment) =>
          freshdeskAttachmentRef(ticketId, conversation.id, attachment, page),
        ),
      },
    }),
  ];
}

async function* conversations(
  client: FreshdeskClient,
  initial: Cursor,
  ticketId: number,
  archived: boolean,
): AsyncGenerator<ImportPage> {
  let checkpoint = initial;
  while (true) {
    const page = await client.page(
      `/api/v2/tickets/${archived ? 'archived/' : ''}${ticketId}/conversations`,
      freshdeskConversationSchema,
      { page: String(checkpoint.conversationPage), per_page: '100' },
    );
    const fingerprint = hashImportValue(
      page.rows.map((conversation) => ({
        ...conversation,
        attachments: conversation.attachments.map(
          ({ attachment_url: _url, ...attachment }) => attachment,
        ),
      })),
    );
    if (
      (checkpoint.conversationFingerprint && checkpoint.conversationFingerprint !== fingerprint) ||
      checkpoint.conversationOffset > page.rows.length
    )
      throw new ConnectorError('invalid-response');
    for (let offset = checkpoint.conversationOffset; offset < page.rows.length; offset++) {
      const conversation = page.rows[offset];
      if (!conversation) throw new ConnectorError('invalid-response');
      yield {
        records: await conversationRecords(
          client,
          checkpoint.mode,
          ticketId,
          conversation,
          checkpoint.conversationPage,
        ),
        cursor: validatedImportCursor({
          ...checkpoint,
          conversationOffset: offset + 1,
          conversationFingerprint: fingerprint,
        }),
      };
    }
    if (!page.nextPage) return;
    const { conversationFingerprint: _old, ...remaining } = checkpoint;
    checkpoint = cursorSchema.parse({
      ...remaining,
      conversationPage: page.nextPage,
      conversationOffset: 0,
    });
    yield { records: [], cursor: validatedImportCursor(checkpoint) };
  }
}

export async function* exportFreshdeskThread(
  client: FreshdeskClient,
  input: {
    mode: Cursor['mode'];
    cursor: ImportCursor | null;
    since?: Date;
    inventory?: TicketInventory;
  },
): AsyncGenerator<ImportPage> {
  let checkpoint = cursorSchema.parse(
    input.cursor ?? {
      mode: input.mode,
      tickets: initialFreshdeskTicketCursor(input.inventory, input.since),
    },
  );
  if (checkpoint.mode !== input.mode) throw new ConnectorError('invalid-response');
  while (true) {
    const batch = await readFreshdeskTicketPage(client, checkpoint.tickets, input.inventory);
    const fingerprint = hashImportValue(
      batch.rows.map((row) => ({ id: row.id, updatedAt: row.updated_at })),
    );
    if (
      (checkpoint.ticketFingerprint && checkpoint.ticketFingerprint !== fingerprint) ||
      checkpoint.ticketOffset > batch.rows.length
    )
      throw new ConnectorError('invalid-response');
    for (let offset = checkpoint.ticketOffset; offset < batch.rows.length; offset++) {
      const ticket = batch.rows[offset];
      if (!ticket) throw new ConnectorError('invalid-response');
      checkpoint = { ...checkpoint, ticketOffset: offset, ticketFingerprint: fingerprint };
      if (!checkpoint.descriptionDone) {
        checkpoint = { ...checkpoint, descriptionDone: true };
        yield {
          records: await descriptionRecords(
            client,
            input.mode,
            ticket.id,
            ticket.archived === true,
          ),
          cursor: validatedImportCursor(checkpoint),
        };
      }
      yield* conversations(client, checkpoint, ticket.id, ticket.archived === true);
      checkpoint = cursorSchema.parse({
        mode: input.mode,
        tickets: checkpoint.tickets,
        ticketOffset: offset + 1,
        ticketFingerprint: fingerprint,
      });
      yield { records: [], cursor: validatedImportCursor(checkpoint) };
    }
    if (!batch.next) {
      yield { records: [], cursor: null };
      return;
    }
    checkpoint = cursorSchema.parse({ mode: input.mode, tickets: batch.next });
    yield { records: [], cursor: validatedImportCursor(checkpoint) };
  }
}
