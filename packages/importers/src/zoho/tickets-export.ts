import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import type { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import type { TicketInventory } from '../ticket-inventory.js';
import type { ZohoDeskClient } from './client.js';
import { zohoTicketSchema, zohoTicketTagsSchema } from './contracts.js';
import { zohoCustomValues } from './field-values.js';
import { readZohoFields } from './fields-export.js';
import { zohoNativeValues } from './profile-fields.js';
import { initialZohoTicketScan, readZohoTicketScan, zohoTicketScanSchema } from './ticket-scan.js';

export function zohoTicketRecord(
  ticket: z.infer<typeof zohoTicketSchema>,
  tags: string[],
): ImportRecord {
  const accountId = ticket.accountId ?? ticket.contact?.account?.id;
  return importRecordSchema.parse({
    entity: 'ticket',
    payload: {
      externalId: ticket.id,
      number: ticket.ticketNumber,
      subject: ticket.subject?.trim() ? ticket.subject : `#${ticket.ticketNumber}`,
      status: ticket.status,
      statusLabel: ticket.status,
      channel: ticket.channel,
      ...(ticket.priority ? { priority: ticket.priority } : {}),
      requesterExternalId: ticket.contactId,
      groupExternalId: ticket.departmentId,
      ...(ticket.assigneeId ? { assigneeExternalId: ticket.assigneeId } : {}),
      ...(accountId ? { organizationExternalId: accountId } : {}),
      ccEmails: [],
      ccExternalIds: ticket.secondaryContacts,
      tags: [...new Set(tags)],
      custom: zohoNativeValues('ticket', ticket, ticket.cf),
      createdAt: ticket.createdTime,
      updatedAt: ticket.modifiedTime,
      ...(ticket.closedTime ? { closedAt: ticket.closedTime } : {}),
      ...(ticket.webUrl ? { sourceUrl: ticket.webUrl } : {}),
    },
  });
}

/** Hydrate one ticket plus its documented `tags` envelope per yielded checkpoint. */
export async function* exportZohoTickets(
  client: ZohoDeskClient,
  raw: ImportCursor | null,
  since?: Date,
  inventory?: TicketInventory,
): AsyncGenerator<ImportPage> {
  let scan = zohoTicketScanSchema.parse(raw ?? initialZohoTicketScan(inventory, since));
  // Commit the fixed delta end before any HTTP request can fail or be throttled.
  if (raw === null) yield { records: [], cursor: scan };
  let fields: Awaited<ReturnType<typeof readZohoFields>> | undefined;
  while (true) {
    const next = await readZohoTicketScan(client, scan, inventory);
    const records: ImportRecord[] = [];
    if (next.id !== null) {
      const ticket = await client.json(`/api/v1/tickets/${next.id}`, zohoTicketSchema);
      if (ticket.id !== next.id || ticket.isDeleted || ticket.isTrashed || ticket.isSpam)
        throw new ConnectorError('invalid-response');
      if (
        next.archivedDepartmentId &&
        (ticket.departmentId !== next.archivedDepartmentId || ticket.isArchived !== true)
      )
        throw new ConnectorError('invalid-response');
      const tags = await client.json(`/api/v1/tickets/${next.id}/tags`, zohoTicketTagsSchema);
      fields ??= await readZohoFields(client, 'ticket');
      records.push(
        zohoTicketRecord(
          { ...ticket, cf: zohoCustomValues(fields, ticket.cf) },
          tags.tags.map((tag) => tag.name),
        ),
      );
    }
    yield { records, cursor: next.next };
    if (next.next === null) return;
    scan = next.next;
  }
}
