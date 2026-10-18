import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { validatedImportCursor } from '../cursor.js';
import { ConnectorError } from '../errors.js';
import type { TicketInventory } from '../ticket-inventory.js';
import type { FreshdeskClient } from './client.js';
import { freshdeskTicketSchema } from './contracts.js';
import {
  freshdeskInventoryCursorSchema,
  initialFreshdeskInventory,
  readFreshdeskInventory,
} from './inventory.js';

const apiCursorSchema = z.strictObject({
  page: z.number().int().min(1).max(300),
  windowStart: z.iso.datetime({ offset: true }),
  lastUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});
export const freshdeskTicketCursorSchema = z.union([
  apiCursorSchema,
  freshdeskInventoryCursorSchema,
]);

export function initialFreshdeskTicketCursor(
  inventory?: TicketInventory,
  since?: Date,
): z.infer<typeof freshdeskTicketCursorSchema> {
  return inventory?.mode === 'complete'
    ? initialFreshdeskInventory(inventory)
    : { page: 1, windowStart: (since ?? new Date(0)).toISOString() };
}

export function freshdeskTicketRecord(
  ticket: z.infer<typeof freshdeskTicketSchema>,
  origin: string,
): ImportRecord {
  return importRecordSchema.parse({
    entity: 'ticket',
    payload: {
      externalId: String(ticket.id),
      number: String(ticket.id),
      subject: ticket.subject?.trim() ? ticket.subject : `#${ticket.id}`,
      status: String(ticket.status),
      priority: String(ticket.priority),
      channel: String(ticket.source),
      requesterExternalId: String(ticket.requester_id),
      ...(ticket.responder_id ? { assigneeExternalId: String(ticket.responder_id) } : {}),
      ...(ticket.group_id ? { groupExternalId: String(ticket.group_id) } : {}),
      ...(ticket.company_id ? { organizationExternalId: String(ticket.company_id) } : {}),
      ccEmails: ticket.cc_emails,
      tags: ticket.tags,
      custom: ticket.custom_fields,
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
      ...(ticket.stats?.resolved_at ? { solvedAt: ticket.stats.resolved_at } : {}),
      ...(ticket.stats?.closed_at ? { closedAt: ticket.stats.closed_at } : {}),
      sourceUrl: new URL(`/a/tickets/${ticket.id}`, origin).href,
    },
  });
}

/** Overlapping windows never advance past timestamp ties at the vendor's hard page ceiling. */
export async function readFreshdeskTicketPage(
  client: FreshdeskClient,
  checkpoint: z.infer<typeof freshdeskTicketCursorSchema>,
  inventory?: TicketInventory,
) {
  if ('kind' in checkpoint) return readFreshdeskInventory(client, checkpoint, inventory);
  const result = await client.page('/api/v2/tickets', freshdeskTicketSchema, {
    page: String(checkpoint.page),
    per_page: '100',
    updated_since: checkpoint.windowStart,
    order_by: 'updated_at',
    order_type: 'asc',
    include: 'description,stats',
  });
  let last = checkpoint.lastUpdatedAt ?? checkpoint.windowStart;
  for (const row of result.rows) {
    if (Date.parse(row.updated_at) < Date.parse(last) || row.archived || row.deleted || row.spam)
      throw new ConnectorError('invalid-response');
    last = row.updated_at;
  }
  let next: z.infer<typeof freshdeskTicketCursorSchema> | null = null;
  if (checkpoint.page === 300 && result.rows.length) {
    const boundary = new Date(Math.floor(Date.parse(last) / 1000) * 1000 - 1000).toISOString();
    if (Date.parse(boundary) <= Date.parse(checkpoint.windowStart))
      await client.refuseTimestampWindow();
    next = { page: 1, windowStart: boundary };
  } else if (result.nextPage !== null) {
    next = freshdeskTicketCursorSchema.parse({
      ...checkpoint,
      page: result.nextPage,
      lastUpdatedAt: last,
    });
  }
  if (next === null && inventory) next = initialFreshdeskInventory(inventory);
  return { rows: result.rows, next };
}

export async function* exportFreshdeskTickets(
  client: FreshdeskClient,
  raw: ImportCursor | null,
  since?: Date,
  inventory?: TicketInventory,
): AsyncGenerator<ImportPage> {
  let checkpoint = freshdeskTicketCursorSchema.parse(
    raw ?? initialFreshdeskTicketCursor(inventory, since),
  );
  while (true) {
    const result = await readFreshdeskTicketPage(client, checkpoint, inventory);
    yield {
      records: result.rows.map((row) => freshdeskTicketRecord(row, client.origin)),
      cursor: result.next === null ? null : validatedImportCursor(result.next),
    };
    if (result.next === null) return;
    checkpoint = result.next;
  }
}
