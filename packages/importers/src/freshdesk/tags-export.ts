import { importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { validatedImportCursor } from '../cursor.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { TicketInventory } from '../ticket-inventory.js';
import type { FreshdeskClient } from './client.js';
import {
  freshdeskTicketCursorSchema,
  initialFreshdeskTicketCursor,
  readFreshdeskTicketPage,
} from './tickets-export.js';

const cursorSchema = z.strictObject({
  tickets: freshdeskTicketCursorSchema,
  offset: z.number().int().min(0).max(100000).default(0),
  fingerprint: z.string().length(64).optional(),
});

export async function* exportFreshdeskTags(
  client: FreshdeskClient,
  raw: ImportCursor | null,
  since?: Date,
  inventory?: TicketInventory,
): AsyncGenerator<ImportPage> {
  let checkpoint = cursorSchema.parse(
    raw ?? { tickets: initialFreshdeskTicketCursor(inventory, since) },
  );
  while (true) {
    const batch = await readFreshdeskTicketPage(client, checkpoint.tickets, inventory);
    const names = [...new Set(batch.rows.flatMap((row) => row.tags))].sort();
    const fingerprint = hashImportValue(names);
    if (
      (checkpoint.fingerprint && checkpoint.fingerprint !== fingerprint) ||
      checkpoint.offset > names.length
    )
      throw new ConnectorError('invalid-response');
    for (let offset = checkpoint.offset; offset < names.length; offset += 1000) {
      const nextOffset = Math.min(offset + 1000, names.length);
      yield {
        records: names
          .slice(offset, nextOffset)
          .map((name) =>
            importRecordSchema.parse({ entity: 'tag', payload: { externalId: name, name } }),
          ),
        cursor: validatedImportCursor({ ...checkpoint, offset: nextOffset, fingerprint }),
      };
    }
    if (!batch.next) {
      yield { records: [], cursor: null };
      return;
    }
    checkpoint = cursorSchema.parse({ tickets: batch.next });
    yield { records: [], cursor: validatedImportCursor(checkpoint) };
  }
}
