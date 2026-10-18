import { importSourceSchema, importStaffTargetSchema, importUserSchema } from '@helpdock/schemas';
import { z } from 'zod';

export const staffLoadSchema = z
  .strictObject({
    brandId: z.uuid(),
    runId: z.uuid(),
    source: importSourceSchema,
    record: importUserSchema,
    mapping: importStaffTargetSchema,
  })
  .refine(
    (input) =>
      input.record.kind === 'agent' &&
      (input.mapping.kind !== 'invited' || input.record.email !== undefined),
    { message: 'Staff mappings require an agent and invitations require an email' },
  );
export type StaffLoad = z.infer<typeof staffLoadSchema>;
