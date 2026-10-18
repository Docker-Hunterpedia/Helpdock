import { z } from 'zod';
import { importEntitySchema, importRecordSchema } from './import.js';
import {
  importInventoryMappingSchema,
  importInventoryValidationSchema,
} from './import-inventory.js';

const safePath = z
  .string()
  .max(300)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){0,2}$/)
  .refine((path) =>
    path.split('.').every((part) => !['__proto__', 'prototype', 'constructor'].includes(part)),
  );
const text = z
  .string()
  .max(10000)
  .regex(/^[^\0]*$/);
export const importFileTransformSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('trim') }),
  z.strictObject({ kind: z.literal('number') }),
  z.strictObject({ kind: z.literal('json') }),
  z.strictObject({ kind: z.literal('join'), separator: text.max(100) }),
  z.strictObject({ kind: z.literal('split'), separator: text.min(1).max(100) }),
  z.strictObject({ kind: z.literal('attachment-urls'), separator: text.min(1).max(100) }),
  z.strictObject({ kind: z.literal('name'), part: z.enum(['given', 'family']) }),
  z
    .strictObject({
      kind: z.literal('boolean'),
      trueValues: z.array(text).min(1).max(100),
      falseValues: z.array(text).min(1).max(100),
    })
    .refine((rule) => !rule.trueValues.some((value) => rule.falseValues.includes(value))),
  z
    .strictObject({
      kind: z.literal('values'),
      entries: z.array(z.strictObject({ from: text, to: text })).max(1000),
    })
    .refine(
      (rule) => new Set(rule.entries.map((entry) => entry.from)).size === rule.entries.length,
    ),
  z.strictObject({
    kind: z.literal('date'),
    format: z.enum(['iso', 'dmy', 'mdy', 'epoch-seconds', 'epoch-milliseconds']),
    timezone: text.min(1).max(100),
  }),
]);
const fileFieldsSchema = z
  .array(
    z.strictObject({
      target: safePath,
      source: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('columns'),
          names: z.array(text.min(1)).min(1).max(20),
        }),
        z.strictObject({
          kind: z.literal('literal'),
          value: z.union([text, z.boolean(), z.number().finite(), z.array(text).max(1000)]),
        }),
      ]),
      transforms: z.array(importFileTransformSchema).max(10),
      omitEmpty: z.boolean(),
    }),
  )
  .min(1)
  .max(500)
  .refine((fields) => {
    const paths = fields.map((field) => field.target);
    return paths.every((path, index) =>
      paths.every(
        (other, otherIndex) =>
          index === otherIndex || (path !== other && !other.startsWith(`${path}.`)),
      ),
    );
  }, 'A target field cannot be assigned twice or overlap another target');
export const importFileMappingSchema = z
  .strictObject({
    entity: importEntitySchema,
    fields: fileFieldsSchema,
    skipInvalidRows: z.boolean().optional(),
    firstMessageFields: fileFieldsSchema.optional(),
  })
  .refine(
    (mapping) => mapping.firstMessageFields === undefined || mapping.entity === 'ticket',
    'Only a tickets file can include the first message',
  );
export type ImportFileMapping = z.infer<typeof importFileMappingSchema>;
export type ImportFileTransform = z.infer<typeof importFileTransformSchema>;

export const importFileHeadersSchema = z
  .array(text.min(1))
  .min(1)
  .max(1024)
  .refine(
    (headers) =>
      new Set(headers).size === headers.length &&
      headers.every((header) => header.trim().length > 0),
  );
export const importFilePresetCreateSchema = z
  .strictObject({
    name: text.trim().min(1).max(80),
    headers: importFileHeadersSchema,
    mapping: importFileMappingSchema,
  })
  .refine(
    (input) =>
      [...input.mapping.fields, ...(input.mapping.firstMessageFields ?? [])].every(
        (field) =>
          field.source.kind === 'literal' ||
          field.source.names.every((name) => input.headers.includes(name)),
      ),
    'Every mapped column must exist in the file headers',
  );
export const importFilePresetViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  entity: importEntitySchema,
  headerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  mapping: importFileMappingSchema,
  createdAt: z.iso.datetime(),
});
export const importFilePresetListQuerySchema = z.strictObject({
  headerFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  entity: importEntitySchema.optional(),
  after: z.uuid().optional(),
});
export const importFilePresetListSchema = z.strictObject({
  presets: z.array(importFilePresetViewSchema).max(50),
  nextCursor: z.uuid().nullable(),
});
export const importFilePresetParamSchema = z.strictObject({
  brandId: z.uuid(),
  presetId: z.uuid(),
});
export const importFilePresetDeleteSchema = z.strictObject({ deleted: z.literal(true) });
export type ImportFilePresetCreate = z.infer<typeof importFilePresetCreateSchema>;
export type ImportFilePresetListQuery = z.infer<typeof importFilePresetListQuerySchema>;

export const importFileRowIssueSchema = z.strictObject({
  target: z.string().max(500),
  column: z.string().max(10000).optional(),
  code: z.enum([
    'type-mismatch',
    'unmapped-value',
    'invalid-date',
    'invalid-columns',
    'missing-column',
    'invalid-field',
  ]),
});
export const importFileRowResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), records: z.array(importRecordSchema).min(1).max(2) }),
  z.strictObject({
    ok: z.literal(false),
    issues: z.array(importFileRowIssueSchema).min(1).max(1000),
  }),
]);
export const importFilePreviewSchema = z.strictObject({
  headers: importFileHeadersSchema,
  delimiter: z.enum([',', ';', '\t']),
  headerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  rows: z
    .array(z.strictObject({ line: z.int().positive(), result: importFileRowResultSchema }))
    .max(20),
});
export const importFileValidationSchema = z.strictObject({
  preview: importFilePreviewSchema,
  checkedRows: z.int().nonnegative(),
  invalidRows: z.int().nonnegative(),
  records: z.int().nonnegative(),
  issues: z
    .array(z.strictObject({ line: z.int().positive(), issue: importFileRowIssueSchema }))
    .max(100),
});
export type ImportFileRowIssue = z.infer<typeof importFileRowIssueSchema>;
export type ImportFileRowResult = z.infer<typeof importFileRowResultSchema>;

export const importFileUploadRequestSchema = z.discriminatedUnion('format', [
  z.strictObject({
    format: z.literal('csv'),
    entity: importEntitySchema,
    inventoryMapping: importInventoryMappingSchema.optional(),
    fileName: z.string().min(1).max(255),
    size: z.int().positive().max(2147483648),
  }),
  z.strictObject({
    format: z.literal('bundle'),
    fileName: z.string().min(1).max(255),
    size: z.int().positive().max(2147483648),
  }),
]);
export const importFileParamSchema = z.strictObject({
  brandId: z.uuid(),
  runId: z.uuid(),
  fileId: z.uuid(),
});
export const importFileViewSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  revision: z.uuid(),
  fileName: z.string().max(255),
  format: z.enum(['csv', 'bundle']),
  entity: importEntitySchema.nullable(),
  size: z.int().positive(),
  status: z.enum(['pending', 'uploaded', 'ready', 'invalid', 'discarded']),
  headers: importFileHeadersSchema.nullable(),
  headerFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
  sampleRows: z
    .array(
      z.strictObject({
        cells: z.array(z.string().max(1000)).max(1024),
        line: z.int().positive(),
        truncated: z.boolean(),
      }),
    )
    .max(20)
    .nullable(),
  mapping: importFileMappingSchema.nullable(),
  inventoryMapping: importInventoryMappingSchema.nullable().optional(),
  inventoryValidation: importInventoryValidationSchema.nullable().optional(),
  validation: importFileValidationSchema.nullable(),
  recordCount: z.int().nonnegative().nullable(),
  error: z.string().max(100).nullable(),
});
export const importFileSummarySchema = importFileViewSchema
  .omit({
    headers: true,
    headerFingerprint: true,
    sampleRows: true,
    mapping: true,
    validation: true,
  })
  .extend({
    hasMapping: z.boolean(),
    hasHeaders: z.boolean(),
    validationPending: z.boolean(),
    readyForExtraction: z.boolean(),
  });
export const importFileListSchema = z.strictObject({
  files: z.array(importFileSummarySchema).max(100),
});
export const importFileUploadResponseSchema = z.strictObject({
  file: importFileViewSchema,
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export const importFileMappingRequestSchema = z.strictObject({ mapping: importFileMappingSchema });
export const importInventoryMappingRequestSchema = z.strictObject({
  mapping: importInventoryMappingSchema,
});
export const importFileDeleteSchema = z.strictObject({ deleted: z.literal(true) });
export type ImportFileUploadRequest = z.infer<typeof importFileUploadRequestSchema>;
