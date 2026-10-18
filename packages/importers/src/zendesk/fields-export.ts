import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import type { ZendeskClient } from './client.js';
import { zendeskCommentPageSchema } from './contracts.js';

const fieldSchema = z.looseObject({
  id: z.int().positive(),
  key: z.string().min(1).optional(),
  title: z.string().min(1),
  type: z.string().min(1),
  custom_field_options: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});
const targets = ['ticket', 'contact', 'organization'] as const;
const endpoints = ['ticket_fields', 'user_fields', 'organization_fields'] as const;
const checkpointSchema = z.strictObject({
  collection: z.int().min(0).max(2),
  after: z.string().optional(),
});
const types = {
  text: 'text',
  textarea: 'textarea',
  integer: 'number',
  decimal: 'number',
  date: 'date',
  checkbox: 'checkbox',
  tagger: 'select',
  dropdown: 'select',
  multiselect: 'multiselect',
} as const;
const systemTypes = new Set([
  'subject',
  'description',
  'status',
  'custom_status',
  'priority',
  'tickettype',
  'group',
  'assignee',
]);

async function fieldRecord(
  client: ZendeskClient,
  field: z.infer<typeof fieldSchema>,
  collection: number,
): Promise<ImportRecord | null> {
  if (collection === 0 && systemTypes.has(field.type)) return null;
  if (!Object.hasOwn(types, field.type)) {
    await client.warnUnsupportedField(`${targets[collection]}:${field.id}`);
    throw new ConnectorError('invalid-response');
  }
  const target = targets[collection];
  return importRecordSchema.parse({
    entity: 'field',
    payload: {
      externalId: `${target}:${field.id}`,
      target,
      key: collection === 0 ? String(field.id) : field.key,
      label: field.title,
      type: types[field.type as keyof typeof types],
      ...(field.custom_field_options
        ? {
            options: field.custom_field_options.map((option) => ({
              value: option.value,
              label: option.name,
            })),
          }
        : {}),
    },
  });
}

export async function* exportZendeskFields(
  client: ZendeskClient,
  cursor: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let checkpoint = checkpointSchema.parse(cursor ?? { collection: 0 });
  while (true) {
    const endpoint = endpoints[checkpoint.collection];
    if (!endpoint) throw new ConnectorError('invalid-response');
    const path = `/api/v2/${endpoint}.json`;
    const fields = z.array(fieldSchema).max(100);
    const schema = zendeskCommentPageSchema.omit({ comments: true }).extend({
      ticket_fields: fields.optional(),
      user_fields: fields.optional(),
      organization_fields: fields.optional(),
    });
    const page = await client.json(path, schema, {
      'page[size]': '100',
      ...(checkpoint.collection === 0 ? { include_boundary_indicators: 'true' } : {}),
      ...(checkpoint.after ? { 'page[after]': checkpoint.after } : {}),
    });
    const sourceFields = page[endpoint];
    if (!sourceFields) throw new ConnectorError('invalid-response');
    const records: ImportRecord[] = [];
    for (const field of sourceFields) {
      const record = await fieldRecord(client, field, checkpoint.collection);
      if (record) records.push(record);
    }
    const next = page.meta.has_more
      ? {
          collection: checkpoint.collection,
          after: client.nextCommentCursor(page.links.next, path, page.meta.after_cursor),
        }
      : checkpoint.collection < 2
        ? { collection: checkpoint.collection + 1 }
        : null;
    if (next?.after && next.after === checkpoint.after)
      throw new ConnectorError('invalid-response');
    yield { records, cursor: next };
    if (!next) return;
    checkpoint = next;
  }
}
