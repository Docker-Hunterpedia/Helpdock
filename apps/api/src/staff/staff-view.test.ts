import type { Department, User, UserBrandRole } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import type { PendingInvite } from './invite.store.js';
import { toStaffMember } from './staff-view.js';

const SUPPORT: Department = {
  id: '0199f4b2-6a91-7c27-9a1f-0000000000a1',
  brandId: '0199f4b2-6a91-7c27-9a1f-00000000000f',
  name: 'Support',
  nameAr: null,
  defaultTeamId: null,
  sortOrder: 0,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
};

const VIEWER_ID = '0199f4b2-6a91-7c27-9a1f-00000000000c';

const user = (overrides: Partial<User> = {}): User => ({
  id: '0199f4b2-6a91-7c27-9a1f-00000000000a',
  email: 'lina@helpdock.com',
  name: 'Lina Haddad',
  passwordHash: null,
  totpSecretEncrypted: null,
  totpEnabled: false,
  recoveryCodesHashed: [],
  locale: 'en',
  status: 'active',
  installAdmin: false,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  deactivatedAt: null,
  ...overrides,
});

const membership = (overrides: Partial<UserBrandRole> = {}): UserBrandRole => ({
  id: '0199f4b2-6a91-7c27-9a1f-00000000000e',
  userId: '0199f4b2-6a91-7c27-9a1f-00000000000a',
  brandId: '0199f4b2-6a91-7c27-9a1f-00000000000f',
  role: 'agent',
  departmentIds: [SUPPORT.id],
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
});

const view = (
  row: { user: User; membership: UserBrandRole },
  extra: {
    pendingInvite?: PendingInvite | null;
    lastActiveAt?: number | null;
    departments?: Map<string, Department>;
  } = {},
) =>
  toStaffMember({
    row,
    departments: extra.departments ?? new Map([[SUPPORT.id, SUPPORT]]),
    pendingInvite: extra.pendingInvite ?? null,
    lastActiveAt: extra.lastActiveAt ?? null,
    viewerId: VIEWER_ID,
  });

describe('toStaffMember', () => {
  it('names the departments the cell prints', () => {
    const member = view({ user: user(), membership: membership() });

    expect(member.departments).toEqual([{ id: SUPPORT.id, name: 'Support' }]);
  });

  it('reads a null department column as every department', () => {
    const member = view({ user: user(), membership: membership({ departmentIds: null }) });

    expect(member.departments).toBe('all');
  });

  it('drops an id whose department has been deleted rather than printing a uuid', () => {
    const member = view({ user: user(), membership: membership() }, { departments: new Map() });

    expect(member.departments).toEqual([]);
  });

  it('spells the role the way the admin app does', () => {
    const member = view({ user: user(), membership: membership({ role: 'team_leader' }) });

    expect(member.role).toBe('teamLeader');
  });

  it('carries the invitation window while the account has never been used', () => {
    const pendingInvite: PendingInvite = {
      tokenHash: 'hash',
      issuedAt: Date.parse('2026-09-10T09:00:00.000Z'),
      expiresAt: Date.parse('2026-09-17T09:00:00.000Z'),
    };

    const member = view(
      { user: user({ status: 'invited' }), membership: membership() },
      { pendingInvite },
    );

    expect(member.invitedAt).toBe('2026-09-10T09:00:00.000Z');
    expect(member.invitationExpiresAt).toBe('2026-09-17T09:00:00.000Z');
  });

  /** A stale Redis record must not make an active person look like an invitation. */
  it('ignores an invitation record for an account that has signed in', () => {
    const member = view(
      { user: user({ status: 'active' }), membership: membership() },
      {
        pendingInvite: { tokenHash: 'hash', issuedAt: 1, expiresAt: 2 },
      },
    );

    expect(member.invitedAt).toBeNull();
    expect(member.invitationExpiresAt).toBeNull();
  });

  it('turns the last refresh into an instant, and no refresh into null', () => {
    expect(
      view({ user: user(), membership: membership() }, { lastActiveAt: 1_789_000_000 })
        .lastActiveAt,
    ).toBe(new Date(1_789_000_000_000).toISOString());

    expect(view({ user: user(), membership: membership() }).lastActiveAt).toBeNull();
  });

  it('marks the reader their own row', () => {
    expect(view({ user: user(), membership: membership() }).self).toBe(false);
    expect(view({ user: user({ id: VIEWER_ID }), membership: membership() }).self).toBe(true);
  });

  it('carries the deactivation instant a greyed row prints', () => {
    const deactivatedAt = new Date('2026-09-01T12:00:00.000Z');
    const member = view({
      user: user({ status: 'deactivated', deactivatedAt }),
      membership: membership(),
    });

    expect(member.status).toBe('deactivated');
    expect(member.deactivatedAt).toBe('2026-09-01T12:00:00.000Z');
  });
});
