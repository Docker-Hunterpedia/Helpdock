import { describe, expect, it } from 'vitest';
import {
  canAssign,
  canManage,
  type StaffActor,
  scopeCovers,
  staffActionRefusal,
} from './staff-scope.js';

/**
 * The authorization matrix of DOMAIN-RULES §1.2 and §12, checked as a table
 * rather than as prose. Every row here is a sentence from those two sections;
 * if a row changes, one of them changed first.
 */

const SUPPORT = '0199f4b2-6a91-7c27-9a1f-0000000000a1';
const BILLING = '0199f4b2-6a91-7c27-9a1f-0000000000a2';

const admin: StaffActor = {
  userId: 'admin',
  role: 'admin',
  departmentIds: 'all',
  installAdmin: false,
};

const leaderOfSupport: StaffActor = {
  userId: 'leader',
  role: 'team_leader',
  departmentIds: [SUPPORT],
  installAdmin: false,
};

describe('scopeCovers', () => {
  it('lets every department cover any list', () => {
    expect(scopeCovers('all', [SUPPORT, BILLING])).toBe(true);
    expect(scopeCovers('all', 'all')).toBe(true);
  });

  it('refuses a list that does not contain every department', () => {
    expect(scopeCovers([SUPPORT], 'all')).toBe(false);
  });

  it('covers a subset and refuses anything outside it', () => {
    expect(scopeCovers([SUPPORT, BILLING], [SUPPORT])).toBe(true);
    expect(scopeCovers([SUPPORT], [SUPPORT, BILLING])).toBe(false);
    expect(scopeCovers([SUPPORT], [])).toBe(true);
  });
});

describe('canManage', () => {
  it('lets an Admin manage every role in the brand', () => {
    for (const role of ['admin', 'team_leader', 'agent', 'viewer'] as const) {
      expect(canManage(admin, { userId: 'x', role, departmentIds: 'all' })).toBe(true);
    }
  });

  it('lets a Team Leader manage agents and viewers in their departments', () => {
    expect(
      canManage(leaderOfSupport, { userId: 'x', role: 'agent', departmentIds: [SUPPORT] }),
    ).toBe(true);
    expect(
      canManage(leaderOfSupport, { userId: 'x', role: 'viewer', departmentIds: [SUPPORT] }),
    ).toBe(true);
  });

  it('refuses a Team Leader another leader or an admin', () => {
    expect(
      canManage(leaderOfSupport, { userId: 'x', role: 'team_leader', departmentIds: [SUPPORT] }),
    ).toBe(false);
    expect(canManage(leaderOfSupport, { userId: 'x', role: 'admin', departmentIds: 'all' })).toBe(
      false,
    );
  });

  it('refuses a Team Leader an agent of a department they do not lead', () => {
    expect(
      canManage(leaderOfSupport, { userId: 'x', role: 'agent', departmentIds: [BILLING] }),
    ).toBe(false);
    expect(canManage(leaderOfSupport, { userId: 'x', role: 'agent', departmentIds: 'all' })).toBe(
      false,
    );
  });

  it('gives an Agent or a Viewer nothing, whatever the guard let through', () => {
    for (const role of ['agent', 'viewer'] as const) {
      const actor: StaffActor = { userId: 'x', role, departmentIds: 'all', installAdmin: true };

      expect(canManage(actor, { userId: 'y', role: 'agent', departmentIds: [] })).toBe(false);
    }
  });
});

describe('canAssign', () => {
  it('lets an Admin hand out any role', () => {
    expect(canAssign(admin, 'admin', 'all')).toBe(true);
  });

  it('stops a Team Leader promoting anybody past themselves', () => {
    expect(canAssign(leaderOfSupport, 'team_leader', [SUPPORT])).toBe(false);
    expect(canAssign(leaderOfSupport, 'admin', 'all')).toBe(false);
  });

  it('stops a Team Leader assigning a department they do not lead', () => {
    expect(canAssign(leaderOfSupport, 'agent', [BILLING])).toBe(false);
    expect(canAssign(leaderOfSupport, 'agent', [SUPPORT])).toBe(true);
  });
});

describe('staffActionRefusal', () => {
  const target = { userId: 'other', role: 'agent' as const, departmentIds: [SUPPORT] };

  it('allows an action an Admin is entitled to', () => {
    expect(
      staffActionRefusal({
        actor: admin,
        target,
        assigning: { role: 'agent', departmentIds: [SUPPORT] },
        viewerEnabled: true,
      }),
    ).toBeNull();
  });

  it('refuses acting on your own membership before anything else', () => {
    expect(
      staffActionRefusal({
        actor: admin,
        target: { ...target, userId: admin.userId },
        viewerEnabled: true,
      }),
    ).toBe('self');
  });

  it('refuses taking the access of the last install admin', () => {
    expect(
      staffActionRefusal({
        actor: admin,
        target,
        viewerEnabled: true,
        wouldRemoveLastInstallAdmin: true,
      }),
    ).toBe('last-install-admin');
  });

  it('refuses a Team Leader a target outside their departments', () => {
    expect(
      staffActionRefusal({
        actor: leaderOfSupport,
        target: { ...target, departmentIds: [BILLING] },
        viewerEnabled: true,
      }),
    ).toBe('out-of-scope');
  });

  it('refuses a Team Leader a role they may not hand out', () => {
    expect(
      staffActionRefusal({
        actor: leaderOfSupport,
        target,
        assigning: { role: 'team_leader', departmentIds: [SUPPORT] },
        viewerEnabled: true,
      }),
    ).toBe('out-of-scope');
  });

  it('refuses the Viewer role while the install toggle is off', () => {
    expect(
      staffActionRefusal({
        actor: admin,
        assigning: { role: 'viewer', departmentIds: 'all' },
        viewerEnabled: false,
      }),
    ).toBe('viewer-disabled');
  });

  it('allows the Viewer role while the toggle is on', () => {
    expect(
      staffActionRefusal({
        actor: admin,
        assigning: { role: 'viewer', departmentIds: 'all' },
        viewerEnabled: true,
      }),
    ).toBeNull();
  });

  it('checks the self rule before the install-admin floor', () => {
    expect(
      staffActionRefusal({
        actor: admin,
        target: { ...target, userId: admin.userId },
        viewerEnabled: true,
        wouldRemoveLastInstallAdmin: true,
      }),
    ).toBe('self');
  });
});
