import { z } from 'zod';

export const importMediaInspectionOutcomeSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('available'),
    size: z.int().positive(),
    mime: z.string().min(1).max(255),
  }),
  z.strictObject({ state: z.enum(['warning', 'error']), code: z.string().min(1).max(100) }),
]);

export const importAttachmentAvailabilitySchema = z.discriminatedUnion('state', [
  importMediaInspectionOutcomeSchema.options[0],
  z.strictObject({ state: z.literal('not_checked') }),
  z.strictObject({ state: z.enum(['unavailable', 'rejected']), code: z.string().min(1).max(100) }),
]);
export type ImportAttachmentAvailability = z.infer<typeof importAttachmentAvailabilitySchema>;
