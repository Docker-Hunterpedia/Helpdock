import {
  type ImportEntity,
  type ImportFileMapping,
  type ImportFileRowIssue,
  type ImportFileRowResult,
  importFileHeadersSchema,
  importFileMappingSchema,
  importRecordSchema,
} from '@helpdock/schemas';
import { FileTransformError, type FileValue, transformFileValue } from './file-transforms.js';
import { hashImportValue } from './hash.js';

export type FileRowIssue = ImportFileRowIssue;
export type MappedFileRow = ImportFileRowResult;
type CompiledField = {
  field: ImportFileMapping['fields'][number];
  indexes: number[];
  missing: string | undefined;
};
type MappingPlan = {
  mapping: ImportFileMapping;
  fields: CompiledField[];
  first: CompiledField[] | undefined;
  width: number;
};

function payloadDefaults(entity: ImportEntity): Record<string, unknown> {
  switch (entity) {
    case 'ticket':
      return { ccEmails: [], tags: [], custom: {} };
    case 'contact':
      return { emails: [], phones: [], custom: {} };
    case 'organization':
      return { domains: [], custom: {} };
    case 'message':
      return { attachments: [] };
    default:
      return {};
  }
}

function assign(payload: Record<string, unknown>, path: string, value: FileValue): void {
  const parts = path.split('.');
  const leaf = parts.pop();
  if (!leaf) return;
  let parent = payload;
  for (const part of parts) {
    const current = parent[part];
    if (typeof current !== 'object' || current === null || Array.isArray(current))
      parent[part] = {};
    parent = parent[part] as Record<string, unknown>;
  }
  Object.defineProperty(parent, leaf, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function fieldValue(compiled: CompiledField, cells: string[]): FileValue {
  const { field } = compiled;
  if (field.source.kind === 'literal') return field.source.value;
  const values = compiled.indexes.map((index) => cells[index] ?? '');
  return values.length === 1 ? (values[0] ?? '') : values;
}

function attachmentIds(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.attachments) || typeof payload.externalId !== 'string') return;
  const parentId = payload.externalId;
  payload.attachments = payload.attachments.map((ref: unknown, index: number) => {
    if (typeof ref !== 'object' || ref === null) return ref;
    return { ...ref, externalId: `csv-file:${hashImportValue({ parentId, index })}` };
  });
}

/** Ordered headers bind presets to the exact column layout, including spelling and case. */
export function fileHeaderFingerprint(headers: readonly string[]): string {
  return hashImportValue(headers);
}

function mapFields(
  input: { fields: CompiledField[]; cells: string[] },
  payload: Record<string, unknown>,
) {
  const issues: FileRowIssue[] = [];
  for (const compiled of input.fields) {
    const { field, missing } = compiled;
    if (missing) {
      issues.push({ target: field.target, column: missing, code: 'missing-column' });
      continue;
    }
    let value = fieldValue(compiled, input.cells);
    if (
      field.omitEmpty &&
      (value === '' || (Array.isArray(value) && value.every((part) => part === '')))
    )
      continue;
    try {
      for (const transform of field.transforms) value = transformFileValue(value, transform);
      assign(payload, field.target, value);
    } catch (error) {
      if (!(error instanceof FileTransformError)) throw error;
      issues.push({ target: field.target, code: error.code });
    }
  }
  return issues;
}

function mapCompiledRow(plan: MappingPlan, cells: string[]): MappedFileRow {
  const { mapping } = plan;
  const payload = payloadDefaults(mapping.entity);
  if (plan.width !== cells.length)
    return { ok: false, issues: [{ target: '', code: 'invalid-columns' }] };
  const issues = mapFields({ cells, fields: plan.fields }, payload);
  if (issues.length) return { ok: false, issues };
  attachmentIds(payload);
  const record = importRecordSchema.safeParse({ entity: mapping.entity, payload });
  if (!record.success)
    return {
      ok: false,
      issues: record.error.issues.map((issue) => ({
        target: issue.path.slice(1).join('.'),
        code: 'invalid-field',
      })),
    };
  if (!plan.first || record.data.entity !== 'ticket') return { ok: true, records: [record.data] };
  const message: Record<string, unknown> = {
    externalId: `csv-first-message:${hashImportValue(record.data.payload.externalId).slice(0, 40)}`,
    ticketExternalId: record.data.payload.externalId,
    createdAt: record.data.payload.createdAt,
    authorKind: 'system',
    public: false,
    attachments: [],
  };
  const messageIssues = mapFields({ cells, fields: plan.first }, message);
  if (messageIssues.length)
    return {
      ok: false,
      issues: messageIssues.map((issue) => ({ ...issue, target: `firstMessage.${issue.target}` })),
    };
  // The generated linkage cannot be overridden by a column mapping.
  message.ticketExternalId = record.data.payload.externalId;
  attachmentIds(message);
  const parsedMessage = importRecordSchema.safeParse({ entity: 'message', payload: message });
  if (!parsedMessage.success)
    return {
      ok: false,
      issues: parsedMessage.error.issues.map((issue) => ({
        target: `firstMessage.${issue.path.slice(1).join('.')}`,
        code: 'invalid-field',
      })),
    };
  return { ok: true, records: [record.data, parsedMessage.data] };
}

/** Validate the mapping and resolve column indexes once, rather than once per historical row. */
export function createFileRowMapper(raw: ImportFileMapping, rawHeaders: string[]) {
  const mapping = importFileMappingSchema.parse(raw);
  const headers = importFileHeadersSchema.parse(rawHeaders);
  const positions = new Map(headers.map((header, index) => [header, index]));
  const compile = (fields: ImportFileMapping['fields']): CompiledField[] =>
    fields.map((field) => {
      const names = field.source.kind === 'columns' ? field.source.names : [];
      return {
        field,
        indexes: names.map((name) => positions.get(name) ?? -1),
        missing: names.find((name) => !positions.has(name)),
      };
    });
  const plan: MappingPlan = {
    mapping,
    width: headers.length,
    fields: compile(mapping.fields),
    first: mapping.firstMessageFields ? compile(mapping.firstMessageFields) : undefined,
  };
  return (cells: string[]) => mapCompiledRow(plan, cells);
}
