import { z } from 'zod';
import { importEntitySchema } from './import.js';

export const importLogLevelSchema = z.enum(['info', 'warning', 'error']);
const cursor = z.coerce.number().int().nonnegative().safe();
export const importLogQuerySchema = z.strictObject({
  level: importLogLevelSchema.optional(),
  direction: z.enum(['asc', 'desc']).default('desc'),
  after: cursor.optional(),
  through: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export const importLogExportQuerySchema = importLogQuerySchema.pick({ level: true });
export const importLogEntrySchema = z.strictObject({
  id: z.int().positive().safe(),
  at: z.iso.datetime(),
  level: importLogLevelSchema,
  entity: importEntitySchema.nullable(),
  externalId: z.string().max(200).nullable(),
  message: z.string().max(4000),
});
export const importLogPageSchema = z.strictObject({
  entries: z.array(importLogEntrySchema).max(500),
  nextCursor: z.int().nonnegative().safe().nullable(),
  through: z.int().nonnegative().safe(),
});
export type ImportLogQuery = z.infer<typeof importLogQuerySchema>;
export type ImportLogExportQuery = z.infer<typeof importLogExportQuerySchema>;
export type ImportLogPage = z.infer<typeof importLogPageSchema>;
