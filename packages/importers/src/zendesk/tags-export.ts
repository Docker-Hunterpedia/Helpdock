import { importRecordSchema } from '@helpdock/schemas';
import type { ImportCursor, ImportPage } from '../connector.js';
import type { ZendeskClient } from './client.js';
import { exportZendeskTickets } from './core-export.js';

export async function* exportZendeskTags(
  client: ZendeskClient,
  cursor: ImportCursor | null,
  since?: Date,
): AsyncGenerator<ImportPage> {
  // The account tags endpoint excludes old and unpopular tags; ticket exports do not.
  for await (const page of exportZendeskTickets(client, cursor, since)) {
    const tags = new Set<string>();
    for (const record of page.records) {
      if (record.entity === 'ticket') for (const tag of record.payload.tags) tags.add(tag);
    }
    yield {
      ...page,
      records: [...tags].map((tag) =>
        importRecordSchema.parse({ entity: 'tag', payload: { externalId: tag, name: tag } }),
      ),
    };
  }
}
