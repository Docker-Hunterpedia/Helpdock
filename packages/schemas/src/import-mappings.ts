import { z } from 'zod';
import { customFieldCreateRequestSchema } from './custom-fields.js';
import { importFieldSchema, importUserSchema } from './import.js';
import { ticketChannelSchema, ticketPrioritySchema } from './ticket.js';

export const importMappingKindSchema = z.enum([
  'status',
  'priority',
  'channel',
  'group',
  'agent',
  'field',
  'tag',
]);

export const importStaffTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), userId: z.uuid() }),
  z.strictObject({
    kind: z.literal('invited'),
    departmentIds: z
      .array(z.uuid())
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
  z.strictObject({ kind: z.literal('name') }),
]);
export const importFieldTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), fieldId: z.uuid() }),
  z.strictObject({
    kind: z.literal('create'),
    definition: customFieldCreateRequestSchema.strict(),
  }),
  z.strictObject({ kind: z.literal('skip') }),
]);

const externalValue = z
  .string()
  .max(300)
  .regex(/^[^\0]*$/);
export const importMappingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('status'),
    externalValue,
    target: z.strictObject({ statusId: z.uuid() }),
  }),
  z.strictObject({
    kind: z.literal('priority'),
    externalValue,
    target: z.strictObject({ priority: ticketPrioritySchema }),
  }),
  z.strictObject({
    kind: z.literal('channel'),
    externalValue,
    target: z.strictObject({ channel: ticketChannelSchema }),
  }),
  z.strictObject({
    kind: z.literal('group'),
    externalValue,
    target: z.strictObject({ departmentId: z.uuid(), teamId: z.uuid().nullable() }),
  }),
  z.strictObject({ kind: z.literal('agent'), externalValue, target: importStaffTargetSchema }),
  z.strictObject({ kind: z.literal('field'), externalValue, target: importFieldTargetSchema }),
  z.strictObject({
    kind: z.literal('tag'),
    externalValue,
    target: z.strictObject({ tagId: z.uuid().nullable() }),
  }),
]);
export type ImportMapping = z.infer<typeof importMappingSchema>;
export const importMappingsSchema = z
  .array(importMappingSchema)
  .max(50000)
  .refine(
    (mappings) =>
      new Set(mappings.map((mapping) => `${mapping.kind}\0${mapping.externalValue}`)).size ===
      mappings.length,
    { message: 'A source value has more than one mapping of the same kind' },
  );

export const importMappingTargetChoiceSchema = z.strictObject({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(300),
  nameAr: z.string().max(300).nullable(),
  detail: z.string().max(320).nullable(),
  selection: importMappingSchema,
});

/** The destination catalog id a mapping selects; `null` when it names no existing destination. */
export function importMappingChoiceId(mapping: ImportMapping | null): string | null {
  if (!mapping) return null;
  switch (mapping.kind) {
    case 'status':
      return mapping.target.statusId;
    case 'priority':
      return mapping.target.priority;
    case 'channel':
      return mapping.target.channel;
    case 'group':
      return mapping.target.teamId
        ? `team:${mapping.target.teamId}`
        : `department:${mapping.target.departmentId}`;
    case 'tag':
      return mapping.target.tagId;
    case 'agent':
      return mapping.target.kind === 'existing' ? mapping.target.userId : null;
    case 'field':
      return mapping.target.kind === 'existing' ? mapping.target.fieldId : null;
  }
}

export const importMappingValuesQuerySchema = z.strictObject({
  kind: importMappingKindSchema,
  after: externalValue.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const importMappingValueSchema = z.strictObject({
  externalValue,
  label: z.string().max(300),
  occurrences: z.int().nonnegative().nullable(),
  person: importUserSchema.pick({ name: true, email: true, kind: true, active: true }).nullable(),
  // Metadata excludes the options themselves, so it needs a count-based rule.
  field: z
    .strictObject({
      target: importFieldSchema.shape.target,
      key: importFieldSchema.shape.key,
      type: importFieldSchema.shape.type,
      optionsCount: z.int().nonnegative(),
    })
    .refine((field) => !['select', 'multiselect'].includes(field.type) || field.optionsCount > 0)
    .nullable(),
  confirmed: importMappingSchema.nullable(),
  proposed: importMappingSchema.nullable(),
  // Display names of the destinations above, so a closed picker needs no catalog search.
  confirmedChoice: importMappingTargetChoiceSchema.nullable(),
  proposedChoice: importMappingTargetChoiceSchema.nullable(),
});
export const importMappingValuesSchema = z.strictObject({
  kind: importMappingKindSchema,
  values: z.array(importMappingValueSchema).max(100),
  nextCursor: externalValue.nullable(),
});
export const importMappingPageRequestSchema = z.strictObject({
  mappings: importMappingsSchema.min(1).max(100),
});
export const importMappingPageResultSchema = z.strictObject({ saved: z.int().min(1).max(100) });
export type ImportMappingValuesQuery = z.infer<typeof importMappingValuesQuerySchema>;
export type ImportMappingValue = z.infer<typeof importMappingValueSchema>;
export type ImportMappingPageRequest = z.infer<typeof importMappingPageRequestSchema>;

export const importMappingTargetsQuerySchema = z.strictObject({
  kind: importMappingKindSchema,
  externalValue,
  search: z
    .string()
    .max(200)
    .regex(/^[^\0]*$/)
    .default(''),
  after: z
    .string()
    .max(80)
    .regex(/^[a-zA-Z0-9_:-]*$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const importMappingTargetsSchema = z.strictObject({
  choices: z.array(importMappingTargetChoiceSchema).max(100),
  nextCursor: z.string().max(80).nullable(),
});
export const importMappingFieldQuerySchema = z.strictObject({
  externalId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\0]*$/),
});
export type ImportMappingTargetsQuery = z.infer<typeof importMappingTargetsQuerySchema>;
export type ImportMappingFieldQuery = z.infer<typeof importMappingFieldQuerySchema>;
export type ImportMappingTargetChoice = z.infer<typeof importMappingTargetChoiceSchema>;
