import type { StaffMember } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { assignableStaff, shortId } from './directory.js';

const VIEWER = { id: '0192c3f0-1a2b-7c3d-8e4f-00000000000a', name: 'Lina Haddad' };
const OMAR = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';
const STRANGER = '0192c3f0-1a2b-7c3d-8e4f-0000000000ff';

const member = (userId: string, name: string, status: StaffMember['status'] = 'active') =>
  ({
    userId,
    name,
    email: `${name}@example.com`,
    role: 'agent',
    departments: [],
    status,
    twoFactorEnabled: false,
    installAdmin: false,
    lastActiveAt: null,
    invitedAt: null,
    invitationExpiresAt: null,
    deactivatedAt: null,
    self: false,
  }) as StaffMember;

describe('shortId', () => {
  it('is enough of a uuid to tell two apart', () => {
    expect(shortId('0192c3f0-1a2b-7c3d-8e4f-0000000000ff')).toBe('0192…ff');
  });

  it('leaves something already short alone', () => {
    expect(shortId('abcd')).toBe('abcd');
  });
});

describe('assignableStaff', () => {
  it('offers the colleagues the staff read returned', () => {
    const offered = assignableStaff(
      [member(VIEWER.id, 'Lina'), member(OMAR, 'Omar')],
      VIEWER,
      null,
    );

    expect(offered.map((person) => person.userId)).toEqual([VIEWER.id, OMAR]);
  });

  it('offers the viewer themselves when the staff read was refused', () => {
    // `GET /staff` declares `staff:manage`, which an Agent does not hold.
    expect(assignableStaff([], VIEWER, null)).toEqual([{ userId: VIEWER.id, name: 'Lina Haddad' }]);
  });

  it('leaves out somebody who no longer works here', () => {
    const offered = assignableStaff([member(OMAR, 'Omar', 'deactivated')], VIEWER, null);

    expect(offered.map((person) => person.userId)).toEqual([VIEWER.id]);
  });

  it('shows the current assignee as a shortened id when nothing can name them', () => {
    const offered = assignableStaff([], VIEWER, STRANGER);

    expect(offered.at(-1)).toEqual({ userId: STRANGER, name: '0192…ff' });
  });

  it('does not repeat an assignee the staff read already named', () => {
    const offered = assignableStaff([member(OMAR, 'Omar')], VIEWER, OMAR);

    expect(offered.filter((person) => person.userId === OMAR)).toHaveLength(1);
  });
});
