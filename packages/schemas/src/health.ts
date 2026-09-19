import { z } from 'zod';

/**
 * The two probes of ARCHITECTURE §14: `/health` says the process is alive,
 * `/ready` says it can serve. Neither carries a version or a hostname, because
 * both are reachable without a principal.
 */

export const healthSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
});
export type Health = z.infer<typeof healthSchema>;

/** A dependency `/ready` probes. `error` is a short reason, never a stack or a URL. */
export const readinessCheckSchema = z.object({
  name: z.enum(['database', 'redis', 'settings']),
  status: z.enum(['up', 'down']),
  error: z.string().optional(),
});
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

export const readinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.array(readinessCheckSchema),
});
export type Readiness = z.infer<typeof readinessSchema>;
