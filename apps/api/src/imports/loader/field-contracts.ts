import { importFieldSchema, importFieldTargetSchema, importSourceSchema } from '@helpdock/schemas';
import { z } from 'zod';

export const fieldLoadSchema = z
  .strictObject({
    brandId: z.uuid(),
    runId: z.uuid(),
    source: importSourceSchema,
    record: importFieldSchema,
    mapping: importFieldTargetSchema,
  })
  .refine(
    (input) =>
      input.mapping.kind !== 'create' ||
      input.mapping.definition.target ===
        (input.record.target === 'organization' ? 'account' : input.record.target),
    { message: 'The field target must match its source entity' },
  );
export type FieldLoad = z.infer<typeof fieldLoadSchema>;
