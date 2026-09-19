import { describe, expect, it } from 'vitest';
import {
  brandDepartmentsRefusal,
  canShapeBrandDepartments,
  type DepartmentActor,
  departmentEditRefusal,
  isEligibleMember,
  leadsDepartment,
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

describe('isEligibleMember', () => {
  it('offers an agent whose scope names the department', () => {
    expect(isEligibleMember({ role: 'agent', departmentIds: [BILLING] }, BILLING)).toBe(true);
  });

  it('keeps out an agent who could not see the tickets the team would take', () => {
    expect(isEligibleMember({ role: 'agent', departmentIds: [TECHNICAL] }, BILLING)).toBe(false);
  });

  it('offers an admin, who reaches the whole brand', () => {
    expect(isEligibleMember({ role: 'admin', departmentIds: [] }, BILLING)).toBe(true);
  });

  it('offers anybody whose scope is unrestricted', () => {
    expect(isEligibleMember({ role: 'viewer', departmentIds: 'all' }, BILLING)).toBe(true);
  });
});
