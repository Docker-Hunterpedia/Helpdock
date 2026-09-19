import type { Principal } from '@helpdock/schemas';

/**
 * The principal of DOMAIN-RULES §1.1:
 *
 * ```ts
 * type Principal =
 *   | { type: 'staff';   id: uuid; brands: Record<uuid, { role: 'admin'|'team_leader'|'agent'|'viewer'; departmentIds: uuid[] | 'all' }>; installAdmin: boolean }
 *   | { type: 'visitor'; id: uuid; brandId: uuid; conversationIds: uuid[]; verifiedContactId?: uuid }
 *   | { type: 'apikey';  id: uuid; brandId: uuid; scopes: string[] }
 *   | { type: 'system';  brandId: uuid; jobId: string }   // workers only
 * ```
 *
 * It is declared as a Zod schema in `@helpdock/schemas` and inferred here: a
 * resolver parses untrusted input into it, and `apps/admin` parses the same
 * shape out of `GET /api/me`, so one declaration has to serve both.
 */
export type { BrandMembership, BrandRole, DepartmentScope, Principal } from '@helpdock/schemas';

/** Every brand the principal may act in at all, before any permission is checked. */
export const brandsOf = (principal: Principal): readonly string[] =>
  principal.type === 'staff' ? Object.keys(principal.brands) : [principal.brandId];

/** The id recorded in `app.principal_id` and on audit rows. A worker is named by its job. */
export const principalIdOf = (principal: Principal): string =>
  principal.type === 'system' ? principal.jobId : principal.id;
