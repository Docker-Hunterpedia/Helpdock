import type { UserBrandRole } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { mappedSsoAccess, type SsoAccess, ssoRoleSyncPlan } from './role-sync.js';

const access = (brandId: string, role: SsoAccess['role'] = 'viewer'): SsoAccess => ({
  brandId,
  role,
  departmentIds: null,
});
const membership = (
  brandId: string,
  source: 'manual' | 'sso',
  connection = 'provider',
): UserBrandRole => ({
  ...access(brandId),
  id: `membership-${brandId}`,
  userId: 'user',
  source,
  ssoConnectionId: source === 'sso' ? connection : null,
  createdAt: new Date(0),
});

describe('SSO role synchronization', () => {
  it('uses the first matching group per brand and defaults only the unmatched brand', () => {
    expect(
      mappedSsoAccess({
        groups: ['support', 'managers'],
        defaultAccess: access('default'),
        mappings: [
          { ...access('work', 'viewer'), idpGroup: 'support', position: 10 },
          { ...access('work', 'admin'), idpGroup: 'managers', position: 2 },
          { ...access('unmatched'), idpGroup: 'missing', position: 0 },
        ],
      }),
    ).toEqual([access('work', 'admin'), access('default')]);
  });

  it('preserves manual and other-provider grants while removing only owned grants', () => {
    const owned = membership('owned', 'sso');
    const plan = ssoRoleSyncPlan({
      connectionId: 'provider',
      current: [
        owned,
        membership('manual', 'manual'),
        membership('other', 'sso', 'other-provider'),
      ],
      desired: [access('manual', 'admin')],
    });
    expect(plan.remove).toEqual([owned]);
    expect(plan.upsert).toEqual([]);
    expect(plan.after).toEqual([access('manual'), access('other')]);
    expect(plan.revokeSessions).toBe(true);
  });

  it('retains removals when the last membership disappears', () => {
    const plan = ssoRoleSyncPlan({
      connectionId: 'provider',
      current: [membership('last', 'sso')],
      desired: [],
    });
    expect(plan.remove).toHaveLength(1);
    expect(plan.after).toEqual([]);
    expect(plan.revokeSessions).toBe(true);
  });

  it('refuses an ownership conflict instead of taking another provider grant', () => {
    const foreign = membership('work', 'sso', 'other-provider');
    const plan = ssoRoleSyncPlan({
      connectionId: 'provider',
      current: [foreign],
      desired: [access('work', 'admin')],
    });
    expect(plan.conflicts).toEqual([foreign]);
    expect(plan.upsert).toEqual([]);
  });

  it('revokes sessions on role or department replacement, but repeated equivalent grants write nothing', () => {
    const current = {
      ...membership('work', 'sso'),
      role: 'agent' as const,
      departmentIds: ['b', 'a'],
    };
    expect(
      ssoRoleSyncPlan({
        connectionId: 'provider',
        current: [current],
        desired: [{ ...access('work', 'agent'), departmentIds: ['a', 'b', 'a'] }],
      }).upsert,
    ).toEqual([]);
    expect(
      ssoRoleSyncPlan({
        connectionId: 'provider',
        current: [current],
        desired: [{ ...access('work', 'agent'), departmentIds: ['a'] }],
      }).revokeSessions,
    ).toBe(true);
    expect(
      ssoRoleSyncPlan({ connectionId: 'provider', current: [], desired: [access('work')] })
        .revokeSessions,
    ).toBe(false);
  });
});
