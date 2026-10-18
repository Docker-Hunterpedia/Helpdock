import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { validatedImportCursor } from '../cursor.js';
import { ConnectorError } from '../errors.js';
import type { TicketInventory } from '../ticket-inventory.js';
import type { FreshdeskClient } from './client.js';
import { freshdeskFieldSchema } from './contracts.js';
import {
  exportFreshdeskTickets,
  freshdeskTicketCursorSchema,
  initialFreshdeskTicketCursor,
} from './tickets-export.js';

const labelsSchema = z
  .record(z.string().regex(/^\d+$/), z.string().min(1).max(300))
  .refine((labels) => Object.keys(labels).length <= 1000);
const cursorSchema = z.discriminatedUnion('stage', [
  z.strictObject({
    stage: z.literal('fields'),
    page: z.number().int().positive().max(1000000),
    labels: labelsSchema,
  }),
  z.strictObject({
    stage: z.literal('tickets'),
    tickets: freshdeskTicketCursorSchema,
    labels: labelsSchema,
  }),
]);

/** Source status IDs stay stable while their administrator-facing labels remain reviewable. */
export async function* exportFreshdeskStatusTickets(
  client: FreshdeskClient,
  raw: ImportCursor | null,
  since?: Date,
  inventory?: TicketInventory,
): AsyncGenerator<ImportPage> {
  let checkpoint = cursorSchema.parse(raw ?? { stage: 'fields', page: 1, labels: {} });
  while (checkpoint.stage === 'fields') {
    const page = await client.page('/api/v2/ticket_fields', freshdeskFieldSchema, {
      page: String(checkpoint.page),
      per_page: '100',
    });
    const labels = { ...checkpoint.labels };
    for (const field of page.rows) {
      if (field.type !== 'default_status') continue;
      const choices = z
        .record(z.string().regex(/^\d+$/), z.tuple([z.string().min(1).max(300), z.string()]))
        .safeParse(field.choices);
      if (!choices.success) throw new ConnectorError('invalid-response');
      for (const [id, [label]] of Object.entries(choices.data)) {
        if (labels[id] !== undefined && labels[id] !== label)
          throw new ConnectorError('invalid-response');
        labels[id] = label;
      }
    }
    labelsSchema.parse(labels);
    checkpoint =
      page.nextPage === null
        ? {
            stage: 'tickets',
            labels,
            tickets: initialFreshdeskTicketCursor(inventory, since),
          }
        : { stage: 'fields', page: page.nextPage, labels };
    yield { records: [], cursor: validatedImportCursor(checkpoint) };
  }
  const labels = checkpoint.labels;
  for await (const page of exportFreshdeskTickets(
    client,
    validatedImportCursor(checkpoint.tickets),
    since,
    inventory,
  )) {
    yield {
      ...page,
      records: page.records.map((record) => {
        if (record.entity !== 'ticket') throw new ConnectorError('invalid-response');
        const label = labels[record.payload.status];
        return label === undefined
          ? record
          : { ...record, payload: { ...record.payload, statusLabel: label } };
      }),
      cursor: page.cursor === null ? null : { stage: 'tickets', labels, tickets: page.cursor },
    };
  }
}
