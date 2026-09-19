import { describe, expect, it } from 'vitest';
import {
  brandDepartmentsRefusal,
  canManageMember,
  canShapeBrandDepartments,
  type DepartmentActor,
  departmentEditRefusal,
  isEligibleMember,
  leadsDepartment,
  reachesDepartment,
} from './department-scope.js';

const BILLING = '0199f4b2-6a91-7c27-9a1f-0000000000a1';
const TECHNICAL = '0199f4b2-6a91-7c27-9a1f-0000000000a2';
const ACTOR = '0199f4b2-6a91-7c27-9a1f-0000000000b1';

const actor = (
  role: DepartmentActor['role'],
  departmentIds: DepartmentActor['departmentIds'] = 'all',
): DepartmentActor => ({ userId: ACTOR, role, departmentIds });

describe('leadsDepartment', () => {
  it('lets an admin reach every department of the brand', () => {
    expect(leadsDepartment(actor('admin', [BILLING]), TECHNICAL)).toBe(true);
  });

  it('lets a team leader reach only the departments on their membership', () => {
    const leader = actor('team_leader', [BILLING]);

    expect(leadsDepartment(leader, BILLING)).toBe(true);
    expect(leadsDepartment(leader, TECHNICAL)).toBe(false);
  });

  it('treats an unrestricted team leader as leading all of them (DOMAIN-RULES §1.1)', () => {
    expect(leadsDepartment(actor('team_leader', 'all'), TECHNICAL)).toBe(true);
  });

  it('lets no agent or viewer lead anything, whatever their scope says', () => {
    expect(leadsDepartment(actor('agent', [BILLING]), BILLING)).toBe(false);
    expect(leadsDepartment(actor('viewer', 'all'), BILLING)).toBe(false);
  });
});

describe('canShapeBrandDepartments', () => {
  it('is the admin alone: which departments a brand has is the brand, not a department', () => {
    expect(canShapeBrandDepartments(actor('admin'))).toBe(true);
    expect(canShapeBrandDepartments(actor('team_leader', 'all'))).toBe(false);
    expect(canShapeBrandDepartments(actor('agent', [BILLING]))).toBe(false);
    expect(canShapeBrandDepartments(actor('viewer'))).toBe(false);
  });
});

describe('departmentEditRefusal', () => {
  it('allows an editor inside their own scope', () => {
    expect(departmentEditRefusal(actor('team_leader', [BILLING]), BILLING)).toBeNull();
  });

  it('refuses a department the actor does not lead', () => {
    expect(departmentEditRefusal(actor('team_leader', [BILLING]), TECHNICAL)).toBe('out-of-scope');
  });
});

describe('brandDepartmentsRefusal', () => {
  it('refuses a team leader who tries to add or remove a department', () => {
    expect(brandDepartmentsRefusal(actor('team_leader', 'all'))).toBe('out-of-scope');
    expect(brandDepartmentsRefusal(actor('admin'))).toBeNull();
  });
});

describe('reachesDepartment', () => {
  it('is true for an agent whose scope names the department', () => {
    expect(reachesDepartment({ role: 'agent', departmentIds: [BILLING] }, BILLING)).toBe(true);
  });

  it('is false for an agent who could not see the tickets the team would take', () => {
    expect(reachesDepartment({ role: 'agent', departmentIds: [TECHNICAL] }, BILLING)).toBe(false);
  });

  it('is true for an admin, who reaches the whole brand', () => {
    expect(reachesDepartment({ role: 'admin', departmentIds: [] }, BILLING)).toBe(true);
  });

  it('is true for anybody whose scope is unrestricted', () => {
    expect(reachesDepartment({ role: 'viewer', departmentIds: 'all' }, BILLING)).toBe(true);
  });
});

describe('canManageMember', () => {
  it('lets an admin put anybody on a team', () => {
    for (const role of ['admin', 'team_leader', 'agent', 'viewer'] as const) {
      expect(canManageMember(actor('admin'), { role, departmentIds: 'all' })).toBe(true);
    }
  });

  it('holds a team leader to agents and viewers (DOMAIN-RULES §1.2)', () => {
    const leader = actor('team_leader', [BILLING]);

    expect(canManageMember(leader, { role: 'agent', departmentIds: [BILLING] })).toBe(true);
    expect(canManageMember(leader, { role: 'viewer', departmentIds: [BILLING] })).toBe(true);
    expect(canManageMember(leader, { role: 'admin', departmentIds: 'all' })).toBe(false);
    expect(canManageMember(leader, { role: 'team_leader', departmentIds: [BILLING] })).toBe(false);
  });

  it('lets an agent or a viewer manage nobody', () => {
    for (const role of ['agent', 'viewer'] as const) {
      expect(canManageMember(actor(role, 'all'), { role: 'agent', departmentIds: 'all' })).toBe(
        false,
      );
    }
  });
});

describe('isEligibleMember', () => {
  it('needs both halves: the ceiling and the reach', () => {
    const leader = actor('team_leader', [BILLING]);

    // Reaches Billing, and a leader may touch an agent.
    expect(isEligibleMember(leader, { role: 'agent', departmentIds: [BILLING] }, BILLING)).toBe(
      true,
    );
    // Reaches Billing, but a leader may not touch an admin.
    expect(isEligibleMember(leader, { role: 'admin', departmentIds: 'all' }, BILLING)).toBe(false);
    // A leader may touch an agent, but this one cannot see Billing.
    expect(isEligibleMember(leader, { role: 'agent', departmentIds: [TECHNICAL] }, BILLING)).toBe(
      false,
    );
  });

  it('lets an admin add the admin a team leader could not', () => {
    expect(isEligibleMember(actor('admin'), { role: 'admin', departmentIds: 'all' }, BILLING)).toBe(
      true,
    );
  });
});
