import { INSTALL_SCOPE_BRAND_ID, type TenantContext } from '@helpdock/db';
import { brandsOf, type Principal, principalIdOf } from '../auth/principal.js';
import type { TenantScopeKind } from '../context/request-context.js';

/**
 * The `app.*` settings a request's transaction carries (ARCHITECTURE §6, step
 * 3). What may go in them is decided by the route's declaration, never by the
 * request: a brand-scoped route names one brand even when the principal holds
 * ten, and only an install-admin route may name the install sentinel.
 */

export interface TenantScopeInput {
  readonly principal: Principal;
  readonly scopeKind: TenantScopeKind;
  /** Required for `'brand'` scope; the brand the permission was checked in. */
  readonly targetBrandId: string | null;
}

/** Thrown when a scope is asked for that cannot be built. Always a programming error. */
export class TenantScopeError extends Error {
  constructor(reason: string) {
    super(`Cannot derive a tenant context: ${reason}`);
    this.name = 'TenantScopeError';
  }
}

type DepartmentScope = readonly string[] | 'all';

/**
 * Which departments the principal reaches: `'all'` for an Admin, and for a Team
 * Leader or Viewer with no department restriction (DOMAIN-RULES §1.1). A worker
 * runs with every department (§1.4); a visitor or an api key has none of its
 * own, so the department-scoped policies see an empty list.
 */
const departmentsIn = (principal: Principal, brandIds: readonly string[]): DepartmentScope => {
  if (principal.type === 'system') {
    return 'all';
  }
  if (principal.type !== 'staff') {
    return [];
  }

  const memberships = brandIds
    .map((brandId) => principal.brands[brandId])
    .filter((membership) => membership !== undefined);

  if (memberships.some((membership) => membership.departmentIds === 'all')) {
    return 'all';
  }

  const departmentIds = new Set<string>();
  for (const membership of memberships) {
    if (membership.departmentIds !== 'all') {
      for (const id of membership.departmentIds) {
        departmentIds.add(id);
      }
    }
  }
  return [...departmentIds];
};

const scopeBrandIds = ({
  principal,
  scopeKind,
  targetBrandId,
}: TenantScopeInput): readonly string[] => {
  switch (scopeKind) {
    case 'brand':
      if (targetBrandId === null) {
        throw new TenantScopeError('a brand-scoped route resolved no target brand');
      }
      if (targetBrandId === INSTALL_SCOPE_BRAND_ID) {
        throw new TenantScopeError('a brand-scoped route may not name the install scope');
      }
      return [targetBrandId];
    case 'principal':
      // Never wider than the roles the principal already holds, and never the
      // install sentinel: `/api/me` and `/api/brands` describe the principal.
      // Only `@Requires('install:admin')` opens install scope, and a principal
      // that claims a role in the sentinel must not be a second way in.
      return brandsOf(principal).filter((brandId) => brandId !== INSTALL_SCOPE_BRAND_ID);
    case 'install':
      // "Install-admin 'all brands' paths set the full list explicitly and are
      // audited" (ARCHITECTURE §6). The sentinel is what makes install-wide
      // `settings` and `audit_log` rows reachable (DOMAIN-RULES §1.3); a route
      // that also needs a brand's own rows names it on top of this.
      return [INSTALL_SCOPE_BRAND_ID];
  }
};

/**
 * The tenant context for a request, or `null` when the principal reaches no
 * brand at all — an install admin who has not been given a role yet, on a route
 * that only describes the principal. There is nothing for a transaction to
 * scope to, so the request runs without one and any query fails loudly.
 */
export const tenantScopeFor = (input: TenantScopeInput): TenantContext | null => {
  const brandIds = scopeBrandIds(input);
  if (brandIds.length === 0) {
    return null;
  }

  return {
    brandIds,
    departmentIds: departmentsIn(input.principal, brandIds),
    principalType: input.principal.type,
    principalId: principalIdOf(input.principal),
  };
};
