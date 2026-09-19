import { INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/principal.js';
import { TenantScopeError, tenantScopeFor } from './tenant-scope.js';

const BRAND_A = '01937f5e-7e53-7000-8000-00000000000a';
const BRAND_B = '01937f5e-7e53-7000-8000-00000000000b';
const DEPT_1 = '01937f5e-7e53-7000-8000-0000000000d1';
const DEPT_2 = '01937f5e-7e53-7000-8000-0000000000d2';
const USER = '01937f5e-7e53-7000-8000-000000000001';

const staff = (
  brands: Record<
    string,
    { role: 'admin' | 'team_leader' | 'agent' | 'viewer'; departmentIds: string[] | 'all' }
  >,
  installAdmin = false,
): Principal => ({ type: 'staff', id: USER, brands, installAdmin });

describe('tenantScopeFor', () => {
  describe('brand scope', () => {
    it('names the target brand and nothing else, however many the principal holds', () => {
      const scope = tenantScopeFor({
        principal: staff({
          [BRAND_A]: { role: 'admin', departmentIds: 'all' },
          [BRAND_B]: { role: 'admin', departmentIds: 'all' },
        }),
        scopeKind: 'brand',
        targetBrandId: BRAND_A,
      });

      expect(scope).toEqual({
        brandIds: [BRAND_A],
        departmentIds: 'all',
        principalType: 'staff',
        principalId: USER,
      });
    });

    it("carries an agent's departments so the policies can narrow on them", () => {
      const scope = tenantScopeFor({
        principal: staff({ [BRAND_A]: { role: 'agent', departmentIds: [DEPT_1, DEPT_2] } }),
        scopeKind: 'brand',
        targetBrandId: BRAND_A,
      });

      expect(scope?.departmentIds).toEqual([DEPT_1, DEPT_2]);
    });

    it('does not leak departments from a brand that is not the target', () => {
      const scope = tenantScopeFor({
        principal: staff({
          [BRAND_A]: { role: 'agent', departmentIds: [DEPT_1] },
          [BRAND_B]: { role: 'agent', departmentIds: [DEPT_2] },
        }),
        scopeKind: 'brand',
        targetBrandId: BRAND_A,
      });

      expect(scope?.departmentIds).toEqual([DEPT_1]);
    });

    it('is a programming error with no target brand', () => {
      expect(() =>
        tenantScopeFor({
          principal: staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } }),
          scopeKind: 'brand',
          targetBrandId: null,
        }),
      ).toThrow(TenantScopeError);
    });

    it('refuses the install sentinel, which would be a way around @Requires(install:admin)', () => {
      expect(() =>
        tenantScopeFor({
          principal: staff({ [INSTALL_SCOPE_BRAND_ID]: { role: 'admin', departmentIds: 'all' } }),
          scopeKind: 'brand',
          targetBrandId: INSTALL_SCOPE_BRAND_ID,
        }),
      ).toThrow(TenantScopeError);
    });
  });

  describe('principal scope', () => {
    it('names every brand the principal holds a role in, and no other', () => {
      const scope = tenantScopeFor({
        principal: staff({
          [BRAND_A]: { role: 'agent', departmentIds: [DEPT_1] },
          [BRAND_B]: { role: 'viewer', departmentIds: [DEPT_2] },
        }),
        scopeKind: 'principal',
        targetBrandId: null,
      });

      expect(scope?.brandIds).toEqual([BRAND_A, BRAND_B]);
      expect(scope?.departmentIds).toEqual([DEPT_1, DEPT_2]);
    });

    it('widens to every department as soon as one role is unrestricted', () => {
      const scope = tenantScopeFor({
        principal: staff({
          [BRAND_A]: { role: 'agent', departmentIds: [DEPT_1] },
          [BRAND_B]: { role: 'admin', departmentIds: 'all' },
        }),
        scopeKind: 'principal',
        targetBrandId: null,
      });

      expect(scope?.departmentIds).toBe('all');
    });

    it('drops the install sentinel even when the principal claims a role in it', () => {
      const scope = tenantScopeFor({
        principal: staff(
          {
            [BRAND_A]: { role: 'admin', departmentIds: 'all' },
            [INSTALL_SCOPE_BRAND_ID]: { role: 'admin', departmentIds: 'all' },
          },
          true,
        ),
        scopeKind: 'principal',
        targetBrandId: null,
      });

      expect(scope?.brandIds).toEqual([BRAND_A]);
    });

    it('opens no transaction for a principal that holds no brand yet', () => {
      expect(
        tenantScopeFor({ principal: staff({}, true), scopeKind: 'principal', targetBrandId: null }),
      ).toBeNull();
    });
  });

  describe('install scope', () => {
    it('names the install sentinel, which is what makes install rows reachable', () => {
      const scope = tenantScopeFor({
        principal: staff({}, true),
        scopeKind: 'install',
        targetBrandId: null,
      });

      expect(scope?.brandIds).toEqual([INSTALL_SCOPE_BRAND_ID]);
      expect(scope?.departmentIds).toEqual([]);
    });
  });

  it('records a worker by its job id and gives it every department', () => {
    const scope = tenantScopeFor({
      principal: { type: 'system', brandId: BRAND_A, jobId: 'outbox.relay:42' },
      scopeKind: 'brand',
      targetBrandId: BRAND_A,
    });

    expect(scope).toEqual({
      brandIds: [BRAND_A],
      departmentIds: 'all',
      principalType: 'system',
      principalId: 'outbox.relay:42',
    });
  });

  it('gives a visitor no department scope of its own', () => {
    const scope = tenantScopeFor({
      principal: { type: 'visitor', id: USER, brandId: BRAND_A, conversationIds: [] },
      scopeKind: 'brand',
      targetBrandId: BRAND_A,
    });

    expect(scope?.departmentIds).toEqual([]);
  });
});
