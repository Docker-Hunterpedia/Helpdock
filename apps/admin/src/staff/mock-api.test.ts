import { beforeEach, describe, expect, it } from 'vitest';
import { isStaffError } from './api.js';
import {
  MOCK_CURRENT_PASSWORD,
  MOCK_DEPARTMENTS,
  MOCK_ENROLMENT_CODE,
  MOCK_INVITE_TOKEN,
  MOCK_SELF_ID,
  MOCK_STAFF_BRAND_ID,
  MockStaffApi,
} from './mock-api.js';

/**
 * The fixture is what the unit suite and the mock browser project run against,
 * so its rules have to be the api's rules. Where they differ, a screen would
 * pass in the fixture and fail against an install.
 */

let staff: MockStaffApi;

beforeEach(() => {
  staff = new MockStaffApi();
});

const brand = MOCK_STAFF_BRAND_ID;
const [support] = MOCK_DEPARTMENTS;

describe('the list', () => {
  it('carries one row per state a screen has to draw', async () => {
    const { staff: rows } = await staff.listStaff(brand);

    expect(rows.map((row) => row.status).sort()).toEqual([
      'active',
      'active',
      'active',
      'deactivated',
      'invited',
    ]);
  });

  it('matches a name or an address, ignoring case', async () => {
    await expect(staff.listStaff(brand, 'OMAR').then((l) => l.staff)).resolves.toHaveLength(1);
    await expect(staff.listStaff(brand, 'yara@').then((l) => l.staff)).resolves.toHaveLength(1);
  });

  it('reports the install toggle, so the screen can hide the Viewer card', async () => {
    await expect(staff.listStaff(brand).then((l) => l.viewerEnabled)).resolves.toBe(true);

    staff.setViewerEnabled(false);
    await expect(staff.listStaff(brand).then((l) => l.viewerEnabled)).resolves.toBe(false);
  });
});

describe('the department rule', () => {
  it('gives an Admin the whole brand, whatever was chosen', async () => {
    const created = await staff.invite(brand, {
      email: 'boss@example.com',
      role: 'admin',
      departmentIds: support === undefined ? [] : [support.id],
    });

    expect(created.departments).toBe('all');
  });

  it('reads an empty choice for an Agent as no departments at all', async () => {
    const created = await staff.invite(brand, {
      email: 'agent@example.com',
      role: 'agent',
      departmentIds: [],
    });

    expect(created.departments).toEqual([]);
  });

  it('reads an empty choice for a Team Leader as every department', async () => {
    const created = await staff.invite(brand, {
      email: 'leader@example.com',
      role: 'teamLeader',
      departmentIds: [],
    });

    expect(created.departments).toBe('all');
  });
});

describe('the rules that answer no', () => {
  it('refuses the Viewer role while the install toggle is off', async () => {
    staff.setViewerEnabled(false);

    await expect(
      staff.invite(brand, { email: 'v@example.com', role: 'viewer', departmentIds: [] }),
    ).rejects.toMatchObject({ reason: 'viewer-disabled' });
  });

  it('refuses acting on your own membership', async () => {
    await expect(staff.setActive(brand, MOCK_SELF_ID, false)).rejects.toMatchObject({
      reason: 'self',
    });
    await expect(staff.removeFromBrand(brand, MOCK_SELF_ID)).rejects.toMatchObject({
      reason: 'self',
    });
  });

  it('raises a staff error the screen can tell from an auth one', async () => {
    const error = await staff
      .setActive(brand, MOCK_SELF_ID, false)
      .catch((raised: unknown) => raised);

    expect(isStaffError(error)).toBe(true);
  });
});

describe('invitations', () => {
  it('appears as pending and can be read back through the token', async () => {
    const created = await staff.invite(brand, {
      email: 'new@example.com',
      role: 'agent',
      departmentIds: support === undefined ? [] : [support.id],
    });

    expect(created.status).toBe('invited');
    expect(staff.inviteFor(MOCK_INVITE_TOKEN)).toMatchObject({
      email: 'new@example.com',
      role: 'agent',
      departments: ['Support'],
    });
  });

  it('stops working once it is spent', async () => {
    staff.spendInvite(MOCK_INVITE_TOKEN);

    expect(staff.inviteFor(MOCK_INVITE_TOKEN)).toBeUndefined();
  });

  it('refuses a second invitation to the same address', async () => {
    await expect(
      staff.invite(brand, { email: 'lina@helpdock.com', role: 'agent', departmentIds: [] }),
    ).rejects.toThrow();
  });

  it('removes the row when the invitation is revoked', async () => {
    const created = await staff.invite(brand, {
      email: 'gone@example.com',
      role: 'agent',
      departmentIds: [],
    });

    await staff.revokeInvite(brand, created.userId);

    const { staff: rows } = await staff.listStaff(brand, 'gone@example.com');
    expect(rows).toHaveLength(0);
  });

  it('refuses to resend to somebody who has already accepted', async () => {
    const { staff: rows } = await staff.listStaff(brand, 'omar@helpdock.com');

    await expect(staff.resendInvite(brand, rows[0]?.userId ?? '')).rejects.toThrow();
  });
});

describe('the account a person owns', () => {
  it('refuses a wrong current password and keeps the other browsers', async () => {
    await expect(staff.changePassword('wrong', 'a long enough password')).rejects.toThrow();
    await expect(staff.sessions().then((s) => s.sessions)).resolves.toHaveLength(2);
  });

  it('ends every other browser when the password changes', async () => {
    await staff.changePassword(MOCK_CURRENT_PASSWORD, 'a long enough password');

    const { sessions } = await staff.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.current).toBe(true);
  });

  it('asks for a live code before weakening the second factor', async () => {
    await expect(staff.disableTotp('000000')).rejects.toThrow();
    await expect(staff.regenerateRecoveryCodes('000000')).rejects.toThrow();

    await staff.disableTotp(MOCK_ENROLMENT_CODE);
    await expect(staff.profile().then((p) => p.twoFactorEnabled)).resolves.toBe(false);
  });

  it('hands over ten new recovery codes', async () => {
    const { recoveryCodes } = await staff.regenerateRecoveryCodes(MOCK_ENROLMENT_CODE);

    expect(recoveryCodes).toHaveLength(10);
    await expect(staff.profile().then((p) => p.recoveryCodesLeft)).resolves.toBe(10);
  });

  it('saves a name and a language', async () => {
    const updated = await staff.updateProfile({ name: 'Lina H.', locale: 'ar' });

    expect(updated).toMatchObject({ name: 'Lina H.', locale: 'ar' });
  });

  it('signs one browser out', async () => {
    const { sessions } = await staff.sessions();
    await staff.revokeSession(sessions[1]?.familyId ?? '');

    await expect(staff.sessions().then((s) => s.sessions)).resolves.toHaveLength(1);
  });
});
