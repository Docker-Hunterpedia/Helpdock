import { z } from 'zod';

export const importInventoryLocationSchema = z.enum(['active', 'archived', 'auto']);
export const importInventoryEntrySchema = z.strictObject({
  externalId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+$/),
  location: importInventoryLocationSchema,
});
export const importInventoryIdentitySchema = z.object({
  mode: z.enum(['complete', 'archives']),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export const importInventoryMappingSchema = z.strictObject({
  idColumn: z.string().min(1).max(10000).nullable(),
  location: importInventoryLocationSchema,
});
export type ImportInventoryMapping = z.infer<typeof importInventoryMappingSchema>;
export const importInventoryValidationSchema = z
  .strictObject({
    kind: z.literal('ticket-inventory'),
    sourceRows: z.number().int().nonnegative().safe(),
    records: z.number().int().nonnegative().safe(),
    duplicates: z.number().int().nonnegative().safe(),
  })
  .refine((result) => result.sourceRows === result.records + result.duplicates);
