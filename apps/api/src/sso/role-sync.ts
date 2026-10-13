import type { UserBrandRole } from '@helpdock/db';
import type { ssoAccessSchema } from '@helpdock/schemas';
import type { z } from 'zod';

export type SsoAccess = z.infer<typeof ssoAccessSchema>;
export type SsoGroupMapping = SsoAccess & { idpGroup: string; position: number };

export function mappedSsoAccess(input: {
  groups: readonly string[];
  mappings: readonly SsoGroupMapping[];
  defaultAccess: SsoAccess | null;
}): SsoAccess[] {
  const groups = new Set(input.groups);
  const byBrand = new Map<string, SsoAccess>();
  for (const mapping of [...input.mappings].sort((a, b) => a.position - b.position)) {
    if (groups.has(mapping.idpGroup) && !byBrand.has(mapping.brandId)) {
      byBrand.set(mapping.brandId, accessOnly(mapping));
    }
  }
  if (input.defaultAccess && !byBrand.has(input.defaultAccess.brandId)) {
    byBrand.set(input.defaultAccess.brandId, accessOnly(input.defaultAccess));
  }
  return [...byBrand.values()];
}

export function ssoRoleSyncPlan(input: {
  connectionId: string;
  current: readonly UserBrandRole[];
  desired: readonly SsoAccess[];
}) {
  const desired = new Map(input.desired.map((grant) => [grant.brandId, grant]));
  const owned = input.current.filter(
    (grant) => grant.source === 'sso' && grant.ssoConnectionId === input.connectionId,
  );
  const conflicts = input.current.filter(
    (grant) =>
      grant.source === 'sso' &&
      grant.ssoConnectionId !== input.connectionId &&
      desired.has(grant.brandId),
  );
  const remove = owned.filter((grant) => !desired.has(grant.brandId));
  const upsert = input.desired.filter((grant) => {
    const existing = input.current.find((row) => row.brandId === grant.brandId);
    return (
      !existing ||
      (existing.source === 'sso' &&
        existing.ssoConnectionId === input.connectionId &&
        !sameAccess(existing, grant))
    );
  });
  const after = [
    ...input.current.filter((grant) => !owned.includes(grant)).map(accessOnly),
    ...input.desired.filter(
      (grant) =>
        !input.current.some((row) => row.brandId === grant.brandId && !owned.includes(row)),
    ),
  ];
  // Any replacement can narrow permissions; revoking on all replacements avoids
  // relying on an incomplete ordering of roles and department scopes.
  const revokeSessions =
    remove.length > 0 || upsert.some((grant) => owned.some((row) => row.brandId === grant.brandId));
  return { remove, upsert, after, conflicts, revokeSessions };
}

function accessOnly(grant: SsoAccess): SsoAccess {
  return {
    brandId: grant.brandId,
    role: grant.role,
    departmentIds: grant.departmentIds === null ? null : [...new Set(grant.departmentIds)].sort(),
  };
}

function sameAccess(left: SsoAccess, right: SsoAccess): boolean {
  return JSON.stringify(accessOnly(left)) === JSON.stringify(accessOnly(right));
}
