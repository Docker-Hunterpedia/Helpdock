import { CUSTOM_FIELD_OPTIONS_MAX, type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { RUN_SNAPSHOT } from '../http.js';
import type { FreshdeskClient } from './client.js';
import { freshdeskFieldSchema } from './contracts.js';
import { freshdeskProfileFields } from './profile-fields.js';

const collections = [
  { path: '/api/v2/ticket_fields', target: 'ticket' },
  { path: '/api/v2/contact_fields', target: 'contact' },
  { path: '/api/v2/company_fields', target: 'organization' },
] as const;
const cursorSchema = z.strictObject({
  collection: z.number().int().min(0).max(2),
  page: z.number().int().min(1).max(1000000),
});
const types = new Map([
  ['custom_text', 'text'],
  ['custom_paragraph', 'textarea'],
  ['custom_number', 'number'],
  ['custom_decimal', 'number'],
  ['custom_date', 'date'],
  ['custom_checkbox', 'checkbox'],
  ['custom_phone_number', 'text'],
  ['custom_url', 'text'],
  ['custom_dropdown', 'select'],
]);

async function fieldRecords(
  client: FreshdeskClient,
  field: z.infer<typeof freshdeskFieldSchema>,
  target: 'ticket' | 'contact' | 'organization',
): Promise<ImportRecord[]> {
  if (field.default || field.type.startsWith('default_')) return [];
  const externalId = `${target}:${field.id}`;
  const definition = { externalId, target, key: field.name, label: field.label };
  if (field.type === 'nested_field' && target === 'ticket') {
    await client.warnFieldSemantics(externalId);
    // Preserve each stored scalar. Conditional dropdown behavior is not a historical value.
    return [
      importRecordSchema.parse({ entity: 'field', payload: { ...definition, type: 'text' } }),
      ...(field.nested_ticket_fields ?? []).map((child) =>
        importRecordSchema.parse({
          entity: 'field',
          payload: {
            externalId: `${externalId}:nested:${child.id}`,
            target,
            key: child.name,
            label: child.label,
            type: 'text',
          },
        }),
      ),
    ];
  }
  const type = types.get(field.type);
  if (!type) {
    await client.warnFieldSemantics(externalId);
    throw new ConnectorError('invalid-response');
  }
  if (field.unique) await client.warnFieldSemantics(externalId);
  let options: { value: string; label: string }[] | undefined;
  if (type === 'select') {
    if (!Array.isArray(field.choices)) throw new ConnectorError('invalid-response');
    options = field.choices.map((choice) => {
      if (typeof choice === 'string') return { value: choice, label: choice };
      const parsed = z
        .object({ value: z.string(), label: z.string().optional() })
        .safeParse(choice);
      if (!parsed.success) throw new ConnectorError('invalid-response');
      return { value: parsed.data.value, label: parsed.data.label ?? parsed.data.value };
    });
    if (new Set(options.map((option) => option.value)).size !== options.length)
      throw new ConnectorError('invalid-response');
    if (options.length > CUSTOM_FIELD_OPTIONS_MAX) {
      await client.warnFieldSemantics(externalId);
      return [
        importRecordSchema.parse({ entity: 'field', payload: { ...definition, type: 'text' } }),
      ];
    }
  }
  return [
    importRecordSchema.parse({
      entity: 'field',
      payload: { ...definition, type, ...(options ? { options } : {}) },
    }),
  ];
}

export async function* exportFreshdeskFields(
  client: FreshdeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let checkpoint = cursorSchema.parse(raw ?? { collection: 0, page: 1 });
  while (true) {
    const collection = collections[checkpoint.collection];
    if (!collection) throw new ConnectorError('invalid-response');
    const page = await client.page(
      collection.path,
      freshdeskFieldSchema,
      { page: String(checkpoint.page), per_page: '100' },
      RUN_SNAPSHOT,
    );
    const records: ImportRecord[] = [];
    if (checkpoint.page === 1 && collection.target !== 'ticket')
      records.push(...freshdeskProfileFields(collection.target));
    for (const field of page.rows)
      records.push(...(await fieldRecords(client, field, collection.target)));
    const next = page.nextPage
      ? { ...checkpoint, page: page.nextPage }
      : checkpoint.collection < collections.length - 1
        ? { collection: checkpoint.collection + 1, page: 1 }
        : null;
    yield { records, cursor: next };
    if (!next) return;
    checkpoint = cursorSchema.parse(next);
  }
}
