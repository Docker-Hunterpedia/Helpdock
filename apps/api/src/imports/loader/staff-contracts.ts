import { importSourceSchema, importUserSchema } from '@helpdock/schemas';
import { z } from 'zod';

export const staffLoadSchema = z
  .strictObject({
    brandId: z.uuid(),
    runId: z.uuid(),
    source: importSourceSchema,
    record: importUserSchema,
    mapping: z.discriminatedUnion('kind', [
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
    ]),
  })
  .refine(
    (input) =>
      input.record.kind === 'agent' &&
      (input.mapping.kind !== 'invited' || input.record.email !== undefined),
    { message: 'Staff mappings require an agent and invitations require an email' },
  );
export type StaffLoad = z.infer<typeof staffLoadSchema>;
