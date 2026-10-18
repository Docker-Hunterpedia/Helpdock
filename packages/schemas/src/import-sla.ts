import { z } from 'zod';

export const importSlaActivationSchema = z.strictObject({
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  requestedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  checked: z.int().nonnegative(),
  started: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
});
export const importSlaActivationStateSchema = importSlaActivationSchema.extend({
  revision: z.uuid(),
  requestedBy: z.uuid(),
  after: z.uuid().nullable(),
});
export const importSlaOverviewSchema = z.strictObject({
  available: z.boolean(),
  eligible: z.int().nonnegative(),
  activation: importSlaActivationSchema.nullable(),
});
export const importSlaStartRequestSchema = z.strictObject({ acknowledge: z.literal(true) });
export type ImportSlaOverview = z.infer<typeof importSlaOverviewSchema>;
