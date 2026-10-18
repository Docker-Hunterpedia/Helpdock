import { z } from 'zod';

export const extractionRetrySchema = z.strictObject({
  retryAt: z.iso.datetime().optional(),
  retryFailures: z.int().min(0).max(3).optional(),
});
export function extractionRetry(counts: Record<string, unknown>) {
  return extractionRetrySchema.parse({
    retryAt: counts.retryAt,
    retryFailures: counts.retryFailures,
  });
}
