import { importRecordSchema } from '@helpdock/schemas';
import type { ImportCursor, ImportPage } from '../connector.js';
import type { TicketInventory } from '../ticket-inventory.js';
import type { ZohoDeskClient } from './client.js';
import { zohoTicketTagsSchema } from './contracts.js';
import { initialZohoTicketScan, readZohoTicketScan, zohoTicketScanSchema } from './ticket-scan.js';

/** Ticket tags share the same native traversal and inventory as their parent tickets. */
export async function* exportZohoTags(
  client: ZohoDeskClient,
  raw: ImportCursor | null,
  since?: Date,
  inventory?: TicketInventory,
): AsyncGenerator<ImportPage> {
  let scan = zohoTicketScanSchema.parse(raw ?? initialZohoTicketScan(inventory, since));
  if (raw === null) yield { records: [], cursor: scan };
  while (true) {
    const step = await readZohoTicketScan(client, scan, inventory);
    const tags =
      step.id === null
        ? []
        : (await client.json(`/api/v1/tickets/${step.id}/tags`, zohoTicketTagsSchema)).tags;
    yield {
      records: [...new Set(tags.map((tag) => tag.name))]
        .sort()
        .map((name) =>
          importRecordSchema.parse({ entity: 'tag', payload: { externalId: name, name } }),
        ),
      cursor: step.next,
    };
    if (step.next === null) return;
    scan = step.next;
  }
}
