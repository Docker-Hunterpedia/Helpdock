import {
  type ImportEntity,
  type ImportFileMapping,
  importFileMappingSchema,
  importRecordSchema,
} from '@helpdock/schemas';

export type FileColumnRule = {
  id: string;
  target: string;
  source: ImportFileMapping['fields'][number]['source'];
  transforms: ImportFileMapping['fields'][number]['transforms'];
  omitEmpty: boolean;
};

export function fileDestinations(entity: ImportEntity): string[] {
  const schema = importRecordSchema.options.find((option) => option.shape.entity.value === entity);
  const fields = schema ? Object.keys(schema.shape.payload.shape) : [];
  if (entity === 'category' || entity === 'section') {
    return fields
      .filter((field) => !['names', 'descriptions'].includes(field))
      .concat(['names.en', 'names.ar', 'descriptions.en', 'descriptions.ar']);
  }
  if (entity === 'ticket') {
    const message = importRecordSchema.options.find(
      (option) => option.shape.entity.value === 'message',
    );
    fields.push(
      ...Object.keys(message?.shape.payload.shape ?? {})
        .filter((field) => field !== 'ticketExternalId')
        .map((field) => `firstMessage.${field}`),
    );
  }
  return fields;
}

export function initialFileColumns(
  entity: ImportEntity,
  headers: string[],
  mapping: ImportFileMapping | null,
): FileColumnRule[] {
  if (mapping)
    return [
      ...mapping.fields.map((field) => ({ ...field, id: crypto.randomUUID() })),
      ...(mapping.firstMessageFields ?? []).map((field) => ({
        ...field,
        target: `firstMessage.${field.target}`,
        id: crypto.randomUUID(),
      })),
      ...headers
        .filter(
          (header) =>
            ![...mapping.fields, ...(mapping.firstMessageFields ?? [])].some(
              (field) => field.source.kind === 'columns' && field.source.names.includes(header),
            ),
        )
        .map((header) => ({
          id: crypto.randomUUID(),
          target: '',
          source: { kind: 'columns' as const, names: [header] },
          transforms: [],
          omitEmpty: true,
        })),
    ];
  const available = fileDestinations(entity);
  const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]/g, '');
  return headers.map((header) => ({
    id: crypto.randomUUID(),
    target: available.find((field) => normalize(field) === normalize(header)) ?? '',
    source: { kind: 'columns', names: [header] },
    transforms: [],
    omitEmpty: true,
  }));
}

export function compileFileColumns(
  entity: ImportEntity,
  rules: FileColumnRule[],
  skipInvalidRows = false,
) {
  const fields: ImportFileMapping['fields'] = [];
  const firstMessageFields: ImportFileMapping['fields'] = [];
  for (const { id: _id, ...rule } of rules) {
    if (!rule.target) continue;
    if (rule.target.startsWith('firstMessage.'))
      firstMessageFields.push({ ...rule, target: rule.target.slice('firstMessage.'.length) });
    else fields.push(rule);
  }
  return importFileMappingSchema.safeParse({
    entity,
    fields,
    skipInvalidRows,
    ...(firstMessageFields.length ? { firstMessageFields } : {}),
  });
}
