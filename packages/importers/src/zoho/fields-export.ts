import { CUSTOM_FIELD_OPTIONS_MAX, type ImportRecord, importFieldSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import { RUN_SNAPSHOT } from '../http.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';
import { zohoNativeFields } from './profile-fields.js';

type Target = 'ticket' | 'contact' | 'organization';
type FieldRecord = Extract<ImportRecord, { entity: 'field' }>;
const modules = { ticket: 'tickets', contact: 'contacts', organization: 'accounts' } as const;
const targets = ['ticket', 'contact', 'organization'] as const;
const fieldSchema = z.object({
  id: zohoIdSchema,
  apiName: z.string().min(1).max(200),
  displayLabel: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  isCustomField: z.boolean(),
  isEncryptedField: z.boolean().optional(),
  isComputed: z.boolean().optional(),
  allowedValues: z
    .array(z.object({ value: z.string().max(300) }))
    .max(10000)
    .nullable()
    .optional(),
});
export type ZohoField = FieldRecord;

/** The module endpoint returns all fields; it does not document page/from/limit parameters. */
export async function readZohoFields(client: ZohoDeskClient, target: Target): Promise<ZohoField[]> {
  // Ticket and profile entities replay this response, so custom values use the staged fields.
  const result = await client.list(
    '/api/v1/fields',
    z.object({ data: z.array(fieldSchema).max(10000) }),
    { module: modules[target] },
    RUN_SNAPSHOT,
  );
  if (
    new Set(result.data.map((field) => field.apiName)).size !== result.data.length ||
    new Set(result.data.map((field) => field.id)).size !== result.data.length
  )
    throw new ConnectorError('invalid-response');
  const fields: ZohoField[] = [];
  for (const field of result.data) {
    // The official examples include a cf_* field incorrectly marked non-custom.
    if (!field.isCustomField && !field.apiName.startsWith('cf_')) continue;
    const externalId = `${target}:${field.id}`;
    const sourceType = field.type.toLowerCase().replaceAll(' ', '');
    let type: FieldRecord['payload']['type'] = 'text';
    let warning = !field.isCustomField || !!field.isComputed || !!field.isEncryptedField;
    let options: { value: string; label: string }[] | undefined;
    if (['textarea', 'largetext'].includes(sourceType)) type = 'textarea';
    else if (['boolean', 'checkbox'].includes(sourceType)) type = 'checkbox';
    else if (sourceType === 'number') type = 'number';
    else if (sourceType === 'date') type = 'date';
    else if (sourceType === 'picklist' || sourceType === 'multiselect') {
      const choices = field.allowedValues ?? [];
      if (new Set(choices.map((choice) => choice.value)).size !== choices.length)
        throw new ConnectorError('invalid-response');
      if (
        choices.length &&
        choices.length <= CUSTOM_FIELD_OPTIONS_MAX &&
        choices.every((choice) => choice.value.length > 0 && choice.value.length <= 200)
      ) {
        type = sourceType === 'picklist' ? 'select' : 'multiselect';
        options = choices.map((choice) => ({ value: choice.value, label: choice.value }));
      } else warning = true;
    } else if (!['text', 'email', 'phone', 'website', 'url', 'fax'].includes(sourceType)) {
      // Currency/decimals retain their original precision. DateTime keeps its
      // timezone; lookups/formulas remain inert source data, never local behavior.
      warning = true;
    }
    if (warning) await client.warnFieldSemantics(externalId);
    fields.push({
      entity: 'field',
      payload: importFieldSchema.parse({
        externalId,
        target,
        key: field.apiName,
        label: field.displayLabel,
        type,
        ...(options ? { options } : {}),
      }),
    });
  }
  return fields;
}

const cursorSchema = z.strictObject({
  collection: z.int().min(0).max(2),
  offset: z.int().min(0).max(11000),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
export async function* exportZohoFields(
  client: ZohoDeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let cursor = cursorSchema.parse(raw ?? { collection: 0, offset: 0, fingerprint: null });
  while (true) {
    const target = targets[cursor.collection];
    if (!target) throw new ConnectorError('invalid-response');
    const records = [...zohoNativeFields(target), ...(await readZohoFields(client, target))];
    const fingerprint = hashImportValue(records);
    if (
      (cursor.fingerprint !== null && cursor.fingerprint !== fingerprint) ||
      cursor.offset > records.length
    )
      throw new ConnectorError('invalid-response');
    while (true) {
      const batch = records.slice(cursor.offset, cursor.offset + 500);
      const offset = cursor.offset + batch.length;
      const next =
        offset < records.length
          ? { ...cursor, offset, fingerprint }
          : cursor.collection < 2
            ? { collection: cursor.collection + 1, offset: 0, fingerprint: null }
            : null;
      yield { records: batch, cursor: next };
      if (next === null) return;
      const collectionDone = next.collection !== cursor.collection;
      cursor = next;
      if (collectionDone) break;
    }
  }
}
