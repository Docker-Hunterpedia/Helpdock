import { z } from 'zod';
import { importEntitySchema } from './import.js';

export const importDryRunReportSchema = z.strictObject({
  phase: z.enum([
    'records',
    'records_checked',
    'plans_checked',
    'identities_checked',
    'media_checked',
    'invalidated',
  ]),
  complete: z.boolean(),
  reviewToken: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  defaultCallingCode: z.string().regex(/^\d{0,4}$/),
  recordsChecked: z.int().nonnegative(),
  mappingsChecked: z.int().nonnegative(),
  mediaChecked: z.int().nonnegative(),
  errors: z.int().nonnegative(),
  warnings: z.int().nonnegative(),
  refusedPhones: z.int().nonnegative(),
  issues: z
    .array(
      z.strictObject({
        area: z.enum(['record', 'mapping', 'field', 'invitation', 'identity', 'media', 'source']),
        entity: importEntitySchema.optional(),
        externalId: z.string().max(300),
        code: z.string().min(1).max(100),
        level: z.enum(['warning', 'error']),
      }),
    )
    .max(500),
});
