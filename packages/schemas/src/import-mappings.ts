import { z } from 'zod';
import { customFieldCreateRequestSchema } from './custom-fields.js';
import { ticketChannelSchema, ticketPrioritySchema } from './ticket.js';

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
