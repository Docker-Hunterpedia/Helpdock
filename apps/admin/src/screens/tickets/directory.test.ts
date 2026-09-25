import type { StaffMember } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { assigneeName, shortId } from './directory.js';

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

describe('assigneeName', () => {
  const agents = [{ userId: OMAR, name: 'Omar Nasser' }];

  it('is null for an unassigned ticket', () => {
    expect(assigneeName(null, { agents, staff: [], viewer: VIEWER })).toBeNull();
  });

  it('names the viewer, then whoever the picker read names', () => {
    expect(assigneeName(VIEWER.id, { agents, staff: [], viewer: VIEWER })).toBe('Lina Haddad');
    expect(assigneeName(OMAR, { agents, staff: [], viewer: VIEWER })).toBe('Omar Nasser');
  });

  it('falls back to the staff read for somebody outside the department', () => {
    expect(
      assigneeName(STRANGER, { agents, staff: [member(STRANGER, 'Former')], viewer: VIEWER }),
    ).toBe('Former');
  });

  it('draws somebody nobody can name as a shortened id, never as unassigned', () => {
    expect(assigneeName(STRANGER, { agents: [], staff: [], viewer: VIEWER })).toBe('0192…ff');
  });
});
