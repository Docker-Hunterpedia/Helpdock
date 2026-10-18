import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { validatedImportCursor } from '../cursor.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { TicketInventory } from '../ticket-inventory.js';
import type { ZohoDeskClient } from './client.js';
import {
  zohoCommentSchema,
  zohoHistoryTicketSchema,
  zohoThreadIndexSchema,
  zohoThreadSchema,
  zohoTicketAttachmentSchema,
} from './contracts.js';
import { readZohoThread } from './history-content.js';
import { zohoAttachmentRef, zohoCommentMessage, zohoThreadMessage } from './history-records.js';
import {
  readZohoTicketAttachments,
  zohoTicketAttachmentMessage,
  zohoTicketAttachmentRef,
} from './ticket-attachments.js';
import { initialZohoTicketScan, readZohoTicketScan, zohoTicketScanSchema } from './ticket-scan.js';

const modeSchema = z.enum(['message', 'attachment']);
const cursorSchema = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('scan'), mode: modeSchema, scan: zohoTicketScanSchema }),
  z.strictObject({
    stage: z.literal('history'),
    mode: modeSchema,
    kind: z.enum(['threads', 'comments', 'attachments']),
    ticket: zohoHistoryTicketSchema,
    scan: zohoTicketScanSchema.nullable(),
    from: z.int().min(0).max(2147483647),
    offset: z.int().min(0).max(200),
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    descriptionSeen: z.boolean(),
  }),
]);
type Cursor = z.infer<typeof cursorSchema>;
type HistoryCursor = Extract<Cursor, { stage: 'history' }>;
type HistoryRows =
  | z.infer<typeof zohoThreadIndexSchema>[]
  | z.infer<typeof zohoCommentSchema>[]
  | z.infer<typeof zohoTicketAttachmentSchema>[];
type PageCache = { current?: { key: string; rows: HistoryRows; fingerprint: string } };

function attachments(
  client: ZohoDeskClient,
  cursor: HistoryCursor,
  kind: 'threads' | 'comments',
  message: {
    id: string;
    attachments: z.infer<typeof zohoThreadSchema>['attachments'];
  },
): ImportRecord[] {
  return message.attachments.map((file) =>
    importRecordSchema.parse({
      entity: 'attachment',
      payload: {
        ...zohoAttachmentRef(client, cursor.ticket.id, kind, message.id, file),
        ticketExternalId: cursor.ticket.id,
        messageExternalId: `${kind === 'threads' ? 'thread' : 'comment'}:${message.id}`,
      },
    }),
  );
}

async function historyPage(
  client: ZohoDeskClient,
  cursor: HistoryCursor,
  cache: PageCache,
): Promise<ImportPage> {
  if (cursor.kind === 'attachments') return ticketFilesPage(client, cursor, cache);
  const path = `/api/v1/tickets/${cursor.ticket.id}/${cursor.kind}`;
  const limit = cursor.kind === 'threads' ? 200 : 100;
  const query = {
    from: String(cursor.from),
    limit: String(limit),
    sortBy: cursor.kind === 'threads' ? 'sendDateTime' : 'commentedTime',
  };
  const key = `${cursor.ticket.id}:${cursor.kind}:${cursor.from}`;
  if (!cache.current || cache.current.key !== key) {
    const page =
      cursor.kind === 'threads'
        ? await client.list(
            path,
            z.object({ data: z.array(zohoThreadIndexSchema).max(200) }),
            query,
          )
        : await client.list(path, z.object({ data: z.array(zohoCommentSchema).max(100) }), {
            ...query,
            include: 'plainText',
          });
    const fingerprint = hashImportValue(
      page.data.map((row) =>
        'attachments' in row
          ? { ...row, attachments: row.attachments.map(({ href: _href, ...file }) => file) }
          : row,
      ),
    );
    // A single validated page lives only for this iterator. On worker restart it
    // is re-read and checked against the persisted fingerprint.
    cache.current = { key, rows: page.data, fingerprint };
  }
  const { rows, fingerprint } = cache.current;
  if (new Set(rows.map((row) => row.id)).size !== rows.length || cursor.offset > rows.length)
    throw new ConnectorError('invalid-response');
  if (cursor.fingerprint && cursor.fingerprint !== fingerprint)
    return client.refuseHistoryPage(cursor.ticket.id);
  const row = rows[cursor.offset];
  if (row) {
    let records: ImportRecord[];
    let descriptionSeen = cursor.descriptionSeen;
    if (cursor.kind === 'threads') {
      const index = zohoThreadIndexSchema.parse(row);
      const loaded =
        cursor.mode === 'message'
          ? await readZohoThread(client, cursor.ticket.id, index.id)
          : { thread: await client.json(`${path}/${index.id}`, zohoThreadSchema), body: {} };
      const { thread } = loaded;
      if (
        thread.id !== index.id ||
        Date.parse(thread.createdTime) !== Date.parse(index.createdTime) ||
        thread.visibility !== index.visibility ||
        thread.direction !== index.direction ||
        thread.status !== index.status ||
        thread.isDescriptionThread !== index.isDescriptionThread
      )
        return client.refuseHistoryPage(cursor.ticket.id);
      descriptionSeen ||= thread.isDescriptionThread;
      records =
        cursor.mode === 'attachment'
          ? attachments(client, cursor, 'threads', thread)
          : [
              {
                entity: 'message',
                payload: await zohoThreadMessage(client, cursor.ticket, thread, loaded.body),
              },
            ];
    } else {
      const comment = zohoCommentSchema.parse(row);
      records =
        cursor.mode === 'attachment'
          ? attachments(client, cursor, 'comments', comment)
          : [
              {
                entity: 'message',
                payload: await zohoCommentMessage(client, cursor.ticket, comment),
              },
            ];
    }
    return {
      records,
      cursor: validatedImportCursor({
        ...cursor,
        descriptionSeen,
        fingerprint,
        offset: cursor.offset + 1,
      }),
    };
  }
  if (rows.length === limit)
    return {
      records: [],
      cursor: validatedImportCursor({
        ...cursor,
        from: cursor.from + rows.length,
        offset: 0,
        fingerprint: null,
      }),
    };
  if (cursor.kind === 'threads') {
    const fallback: ImportRecord[] =
      !cursor.descriptionSeen && cursor.ticket.description && cursor.mode === 'message'
        ? [
            importRecordSchema.parse({
              entity: 'message',
              payload: {
                externalId: `description:${cursor.ticket.id}`,
                ticketExternalId: cursor.ticket.id,
                authorKind: 'system',
                public: false,
                bodyHtml: cursor.ticket.description,
                createdAt: cursor.ticket.createdTime,
                attachments: [],
                via: 'zoho:ticket-description',
                sourceDetails: { authorKind: 'unknown' },
              },
            }),
          ]
        : [];
    if (fallback.length) await client.warnDescriptionFallback(cursor.ticket.id);
    return {
      records: fallback,
      cursor: validatedImportCursor({
        ...cursor,
        kind: 'comments',
        from: 0,
        offset: 0,
        fingerprint: null,
      }),
    };
  }
  return {
    records: [],
    cursor: validatedImportCursor({
      ...cursor,
      kind: 'attachments',
      from: 0,
      offset: 0,
      fingerprint: null,
    }),
  };
}

async function ticketFilesPage(
  client: ZohoDeskClient,
  cursor: HistoryCursor,
  cache: PageCache,
): Promise<ImportPage> {
  const key = `${cursor.ticket.id}:attachments:${cursor.from}`;
  if (cache.current?.key !== key) {
    const rows = await readZohoTicketAttachments(client, cursor.ticket.id, cursor.from);
    cache.current = {
      key,
      rows,
      fingerprint: hashImportValue(rows.map(({ href: _href, ...file }) => file)),
    };
  }
  const { rows, fingerprint } = cache.current;
  if (
    cursor.offset > rows.length ||
    (cursor.fingerprint !== null && cursor.fingerprint !== fingerprint)
  )
    return client.refuseHistoryPage(cursor.ticket.id);
  const row = rows[cursor.offset];
  if (row) {
    const file = zohoTicketAttachmentSchema.parse(row);
    const externalId = `ticket-attachment:${file.id}`;
    const record: ImportRecord =
      cursor.mode === 'message'
        ? {
            entity: 'message',
            payload: await zohoTicketAttachmentMessage(client, cursor.ticket.id, file, cursor.from),
          }
        : {
            entity: 'attachment',
            payload: {
              ...zohoTicketAttachmentRef(client, cursor.ticket.id, file, cursor.from),
              ticketExternalId: cursor.ticket.id,
              messageExternalId: externalId,
            },
          };
    return {
      records: [record],
      cursor: validatedImportCursor({ ...cursor, fingerprint, offset: cursor.offset + 1 }),
    };
  }
  if (rows.length === 100)
    return {
      records: [],
      cursor: validatedImportCursor({
        ...cursor,
        from: cursor.from + rows.length,
        offset: 0,
        fingerprint: null,
      }),
    };
  return {
    records: [],
    cursor:
      cursor.scan === null
        ? null
        : validatedImportCursor({ stage: 'scan', mode: cursor.mode, scan: cursor.scan }),
  };
}

/** One source item per checkpoint; long threads never require a whole ticket in memory. */
export async function* exportZohoHistory(
  client: ZohoDeskClient,
  input: {
    mode: z.infer<typeof modeSchema>;
    cursor: ImportCursor | null;
    since?: Date;
    inventory?: TicketInventory;
  },
): AsyncGenerator<ImportPage> {
  let cursor = cursorSchema.parse(
    input.cursor ?? {
      stage: 'scan',
      mode: input.mode,
      scan: initialZohoTicketScan(input.inventory, input.since),
    },
  );
  if (cursor.mode !== input.mode) throw new ConnectorError('invalid-response');
  if (input.cursor === null) yield { records: [], cursor: validatedImportCursor(cursor) };
  const cache: PageCache = {};
  while (true) {
    if (cursor.stage === 'scan') {
      const next = await readZohoTicketScan(client, cursor.scan, input.inventory);
      if (next.id === null) {
        if (next.next === null) {
          yield { records: [], cursor: null };
          return;
        }
        cursor = { ...cursor, scan: next.next };
      } else {
        const ticket = await client.json(`/api/v1/tickets/${next.id}`, zohoHistoryTicketSchema);
        if (ticket.id !== next.id || ticket.isDeleted || ticket.isTrashed || ticket.isSpam)
          throw new ConnectorError('invalid-response');
        if (
          next.archivedDepartmentId &&
          (ticket.departmentId !== next.archivedDepartmentId || ticket.isArchived !== true)
        )
          throw new ConnectorError('invalid-response');
        cursor = {
          stage: 'history',
          mode: cursor.mode,
          kind: 'threads',
          ticket,
          scan: next.next,
          from: 0,
          offset: 0,
          fingerprint: null,
          descriptionSeen: false,
        };
      }
      yield { records: [], cursor: validatedImportCursor(cursor) };
      continue;
    }
    const page = await historyPage(client, cursor, cache);
    yield page;
    if (page.cursor === null) return;
    cursor = cursorSchema.parse(page.cursor);
  }
}
