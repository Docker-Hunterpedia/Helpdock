import { z } from 'zod';

/**
 * The principal of [DOMAIN-RULES
 * §1.1](../../../docs/planning/DOMAIN-RULES.md#11-principal), as a schema
 * rather than a bare type: `apps/api` parses untrusted input into it (the dev
 * header resolver today, the session resolver from M0-05), and `apps/admin`
 * parses what `GET /api/me` answers. One declaration keeps the two in step.
 *
 * ```ts
 * type Principal =
 *   | { type: 'staff';   id: uuid; brands: Record<uuid, { role; departmentIds: uuid[] | 'all' }>; installAdmin: boolean }
 *   | { type: 'visitor'; id: uuid; brandId: uuid; conversationIds: uuid[]; verifiedContactId?: uuid }
 *   | { type: 'apikey';  id: uuid; brandId: uuid; scopes: string[] }
 *   | { type: 'system';  brandId: uuid; jobId: string }
 * ```
 */

/** One role per user per brand (DOMAIN-RULES §1.2). */
export const brandRoleSchema = z.enum(['admin', 'team_leader', 'agent', 'viewer']);
export type BrandRole = z.infer<typeof brandRoleSchema>;

/** `'all'` for an Admin, and for a Team Leader or Viewer with no department restriction. */
export const departmentScopeSchema = z.union([z.array(z.uuid()), z.literal('all')]);
export type DepartmentScope = z.infer<typeof departmentScopeSchema>;

export const brandMembershipSchema = z.object({
  role: brandRoleSchema,
  departmentIds: departmentScopeSchema,
});
export type BrandMembership = z.infer<typeof brandMembershipSchema>;

export const staffPrincipalSchema = z.object({
  type: z.literal('staff'),
  id: z.uuid(),
  brands: z.record(z.uuid(), brandMembershipSchema),
  installAdmin: z.boolean(),
});

export const visitorPrincipalSchema = z.object({
  type: z.literal('visitor'),
  id: z.uuid(),
  brandId: z.uuid(),
  conversationIds: z.array(z.uuid()),
  verifiedContactId: z.uuid().optional(),
});

export const apiKeyPrincipalSchema = z.object({
  type: z.literal('apikey'),
  id: z.uuid(),
  brandId: z.uuid(),
  scopes: z.array(z.string()),
});

/** Workers only: a job runs as the system principal for exactly one brand (DOMAIN-RULES §1.4). */
export const systemPrincipalSchema = z.object({
  type: z.literal('system'),
  brandId: z.uuid(),
  jobId: z.string().min(1),
});

export const principalSchema = z.discriminatedUnion('type', [
  staffPrincipalSchema,
  visitorPrincipalSchema,
  apiKeyPrincipalSchema,
  systemPrincipalSchema,
]);
export type Principal = z.infer<typeof principalSchema>;

/**
 * What `GET /api/me` answers. It is the principal itself: the endpoint exists so
 * a client can learn who it is talking as, and the principal carries nothing
 * the client did not already prove.
 */
export const meSchema = z.object({
  principal: principalSchema,
});
export type Me = z.infer<typeof meSchema>;
