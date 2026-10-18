import { z } from 'zod';
import { importSourceSchema } from './import.js';

export const importBrandHealthSchema = z.strictObject({
  brandId: z.uuid(),
  brandName: z.string().min(1).max(200),
  active: z.int().nonnegative(),
  paused: z.int().nonnegative(),
  lastError: z
    .strictObject({
      runId: z.uuid(),
      source: importSourceSchema,
      at: z.iso.datetime(),
      code: z
        .string()
        .max(100)
        .regex(/^import\.[a-z0-9_.:-]+$/),
    })
    .nullable(),
});
export const importHealthSchema = z.discriminatedUnion('configured', [
  z.strictObject({ configured: z.literal(false) }),
  z.strictObject({
    configured: z.literal(true),
    snapshotId: z.uuid().optional(),
    observedAt: z.iso.datetime(),
    totalBrands: z.int().nonnegative(),
    active: z.int().nonnegative(),
    paused: z.int().nonnegative(),
    brands: z.array(importBrandHealthSchema).max(50),
  }),
]);
export type ImportHealth = z.infer<typeof importHealthSchema>;
export const importHealthQuerySchema = z.strictObject({
  snapshotId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
});
export const importHealthPageSchema = z.discriminatedUnion('configured', [
  z.strictObject({ configured: z.literal(false) }),
  importHealthSchema.options[1].extend({ page: z.int().positive(), hasNext: z.boolean() }),
]);
export type ImportHealthQuery = z.infer<typeof importHealthQuerySchema>;
export type ImportHealthPage = z.infer<typeof importHealthPageSchema>;
