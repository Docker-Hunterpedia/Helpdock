import {
  customFieldCreateRequestSchema,
  importFieldSchema,
  importSourceSchema,
} from '@helpdock/schemas';
import { z } from 'zod';

export const fieldLoadSchema = z
  .strictObject({
    brandId: z.uuid(),
    runId: z.uuid(),
    source: importSourceSchema,
    record: importFieldSchema,
    mapping: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('existing'), fieldId: z.uuid() }),
      z.strictObject({
        kind: z.literal('create'),
        definition: customFieldCreateRequestSchema.strict(),
      }),
      z.strictObject({ kind: z.literal('skip') }),
    ]),
  })
  .refine(
    (input) =>
      input.mapping.kind !== 'create' ||
      input.mapping.definition.target ===
        (input.record.target === 'organization' ? 'account' : input.record.target),
    { message: 'The field target must match its source entity' },
  );
export type FieldLoad = z.infer<typeof fieldLoadSchema>;
