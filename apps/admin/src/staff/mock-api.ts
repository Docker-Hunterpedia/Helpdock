import type {
  Department,
  DepartmentList,
  Profile,
  ProfileUpdateRequest,
  PublicInvite,
  RecoveryCodes,
  StaffInviteRequest,
  StaffList,
  StaffMember,
  StaffSessionList,
  StaffUpdateRequest,
} from '@helpdock/schemas';
import { AuthError } from '../auth/api.js';
import { type StaffApi, StaffError } from './api.js';

/**
 * The fixture the staff screens, the security page and the invite screen run
 * against until an install is in front of them. It is deliberately the whole of
 * `StaffApi` including the refusals, so the screens and the browser tests
 * exercise the same states the real service produces: a pending invitation, a
 * deactivated row, your own row with no actions, and every rule in
 * DOMAIN-RULES §12 that answers "no".
 *
 * `MockAuthApi` holds one of these, so an invitation sent on the staff screen
 * is the invitation the accept screen reads.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

export const MOCK_DEPARTMENTS: readonly Department[] = [
  { id: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1', name: 'Support' },
  { id: '0192c3f0-1a2b-7c3d-8e4f-0000000000d2', name: 'Billing' },
  { id: '0192c3f0-1a2b-7c3d-8e4f-0000000000d3', name: 'Onboarding' },
];

const [SUPPORT, BILLING] = MOCK_DEPARTMENTS;

/** The signed-in person. Their own row offers no actions. */
export const MOCK_SELF_ID = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';

/** A live invitation the accept screen can read; `MOCK_EXPIRED_INVITE` cannot. */
export const MOCK_INVITE_TOKEN = 'mock-invite-token';
export const MOCK_EXPIRED_INVITE_TOKEN = 'expired-invite-token';

export const MOCK_CURRENT_PASSWORD = 'correct horse';
export const MOCK_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const MOCK_ENROLMENT_CODE = '482913';

const recoveryCodes = (seed: string): string[] =>
  Array.from({ length: 10 }, (_unused, index) => `RC-${seed}${index}-${1000 + index * 7}`);

const iso = (daysFromNow: number): string =>
  new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();

const member = (
  overrides: Partial<StaffMember> & Pick<StaffMember, 'userId' | 'name' | 'email'>,
): StaffMember => ({
  role: 'agent',
  departments: [],
  status: 'active',
  twoFactorEnabled: false,
  installAdmin: false,
  lastActiveAt: null,
  invitedAt: null,
  invitationExpiresAt: null,
  deactivatedAt: null,
  self: false,
  ...overrides,
});

const seedStaff = (): StaffMember[] => [
  member({
    userId: MOCK_SELF_ID,
    name: 'Lina Haddad',
    email: 'lina@helpdock.com',
    role: 'admin',
    departments: 'all',
    twoFactorEnabled: true,
    installAdmin: true,
    lastActiveAt: iso(0),
    self: true,
  }),
  member({
    userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000b',
    name: 'Omar Nasser',
    email: 'omar@helpdock.com',
    role: 'teamLeader',
    departments: SUPPORT === undefined ? [] : [SUPPORT],
    twoFactorEnabled: true,
    lastActiveAt: iso(-1),
  }),
  member({
    userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000c',
    name: 'Yara Salem',
    email: 'yara@helpdock.com',
    role: 'agent',
    departments: [SUPPORT, BILLING].filter((department) => department !== undefined),
    lastActiveAt: iso(-3),
  }),
  member({
    userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000d',
    name: 'karim',
    email: 'karim@helpdock.com',
    role: 'agent',
    departments: SUPPORT === undefined ? [] : [SUPPORT],
    status: 'invited',
    invitedAt: iso(-3),
    invitationExpiresAt: iso(4),
  }),
  member({
    userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000e',
    name: 'Dana Fares',
    email: 'dana@helpdock.com',
    role: 'viewer',
    departments: 'all',
    status: 'deactivated',
    deactivatedAt: iso(-18),
  }),
];

const seedProfile = (): Profile => ({
  id: MOCK_SELF_ID,
  name: 'Lina Haddad',
  email: 'lina@helpdock.com',
  locale: 'en',
  twoFactorEnabled: true,
  recoveryCodesLeft: 8,
  twoFactorRequired: false,
});

const seedSessions = (): StaffSessionList => ({
  sessions: [
    {
      familyId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/141',
      startedAt: iso(-2),
      lastUsedAt: iso(0),
      current: true,
    },
    {
      familyId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f2',
      userAgent: 'Mozilla/5.0 (iPhone) Safari/26',
      startedAt: iso(-9),
      lastUsedAt: iso(-1),
      current: false,
    },
  ],
});

let nextUserId = 1;

export class MockStaffApi implements StaffApi {
  #staff = seedStaff();
  #profile = seedProfile();
  #sessions = seedSessions();
  #viewerEnabled = true;
  /** Tokens the accept screen can read, mapped to what they stand for. */
  readonly #invites = new Map<string, PublicInvite>([
    [
      MOCK_INVITE_TOKEN,
      {
        email: 'karim@helpdock.com',
        inviterName: 'Lina Haddad',
        brandName: 'Helpdock',
        role: 'agent',
        departments: ['Support'],
        expiresAt: iso(4),
      },
    ],
  ]);

  /** The install toggle, so a test can prove the Viewer card disappears. */
  setViewerEnabled(enabled: boolean): void {
    this.#viewerEnabled = enabled;
  }

  async listStaff(_brandId: string, search?: string): Promise<StaffList> {
    const term = search?.trim().toLowerCase() ?? '';
    const matches = (row: StaffMember): boolean =>
      term === '' ||
      row.name.toLowerCase().includes(term) ||
      row.email.toLowerCase().includes(term);

    return { staff: this.#staff.filter(matches), viewerEnabled: this.#viewerEnabled };
  }

  async departments(_brandId: string): Promise<DepartmentList> {
    return { departments: [...MOCK_DEPARTMENTS] };
  }

  async invite(_brandId: string, request: StaffInviteRequest): Promise<StaffMember> {
    this.#assertAssignable(request.role);

    if (this.#staff.some((row) => row.email.toLowerCase() === request.email.toLowerCase())) {
      throw new AuthError('unavailable');
    }

    nextUserId += 1;
    const created = member({
      userId: `0192c3f0-1a2b-7c3d-8e4f-${String(nextUserId).padStart(12, '0')}`,
      name: request.email.split('@')[0] ?? request.email,
      email: request.email,
      role: request.role,
      departments: this.#resolve(request),
      status: 'invited',
      invitedAt: iso(0),
      invitationExpiresAt: iso(7),
    });

    this.#staff = [...this.#staff, created];
    this.#invites.set(MOCK_INVITE_TOKEN, {
      email: created.email,
      inviterName: this.#profile.name,
      brandName: 'Helpdock',
      role: created.role,
      departments: created.departments === 'all' ? [] : created.departments.map((d) => d.name),
      expiresAt: created.invitationExpiresAt ?? iso(7),
    });

    return created;
  }

  async resendInvite(_brandId: string, userId: string): Promise<void> {
    const row = this.#require(userId);
    if (row.status !== 'invited') {
      throw new AuthError('unavailable');
    }

    this.#replace({ ...row, invitedAt: iso(0), invitationExpiresAt: iso(7) });
  }

  async revokeInvite(_brandId: string, userId: string): Promise<void> {
    const row = this.#require(userId);
    if (row.status !== 'invited') {
      throw new AuthError('unavailable');
    }

    this.#staff = this.#staff.filter((candidate) => candidate.userId !== userId);
  }

  async updateStaff(
    _brandId: string,
    userId: string,
    request: StaffUpdateRequest,
  ): Promise<StaffMember> {
    const row = this.#assertNotSelf(this.#require(userId));
    if (request.role !== undefined) {
      this.#assertAssignable(request.role);
    }

    const updated: StaffMember = {
      ...row,
      ...(request.role === undefined ? {} : { role: request.role }),
      ...(request.departmentIds === undefined
        ? {}
        : {
            departments: this.#resolve({
              role: request.role ?? row.role,
              departmentIds: request.departmentIds,
            }),
          }),
    };

    this.#replace(updated);
    return updated;
  }

  async setActive(_brandId: string, userId: string, active: boolean): Promise<StaffMember> {
    const row = this.#assertNotSelf(this.#require(userId));
    if (!active && row.installAdmin) {
      throw new StaffError('last-install-admin');
    }

    const updated: StaffMember = {
      ...row,
      status: active ? 'active' : 'deactivated',
      deactivatedAt: active ? null : iso(0),
    };

    this.#replace(updated);
    return updated;
  }

  async removeFromBrand(_brandId: string, userId: string): Promise<void> {
    this.#assertNotSelf(this.#require(userId));
    this.#staff = this.#staff.filter((candidate) => candidate.userId !== userId);
  }

  // ------------------------------------------------------------------

  async profile(): Promise<Profile> {
    return this.#profile;
  }

  async updateProfile(request: ProfileUpdateRequest): Promise<Profile> {
    this.#profile = {
      ...this.#profile,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.locale === undefined ? {} : { locale: request.locale }),
    };

    return this.#profile;
  }

  async changePassword(currentPassword: string, _newPassword: string): Promise<void> {
    if (currentPassword !== MOCK_CURRENT_PASSWORD) {
      throw new AuthError('invalid-credentials');
    }

    this.#sessions = { sessions: this.#sessions.sessions.filter((session) => session.current) };
  }

  async disableTotp(code: string): Promise<void> {
    this.#assertCode(code);
    this.#profile = { ...this.#profile, twoFactorEnabled: false, recoveryCodesLeft: 0 };
  }

  async regenerateRecoveryCodes(code: string): Promise<RecoveryCodes> {
    this.#assertCode(code);
    this.#profile = { ...this.#profile, recoveryCodesLeft: 10 };

    return { recoveryCodes: recoveryCodes('NEW') };
  }

  async sessions(): Promise<StaffSessionList> {
    return this.#sessions;
  }

  async revokeSession(familyId: string): Promise<void> {
    this.#sessions = {
      sessions: this.#sessions.sessions.filter((session) => session.familyId !== familyId),
    };
  }

  // ------------------------------------------------------------------
  // Shared with `MockAuthApi`, which owns the invite and enrolment screens
  // ------------------------------------------------------------------

  inviteFor(token: string): PublicInvite | undefined {
    return this.#invites.get(token);
  }

  spendInvite(token: string): void {
    this.#invites.delete(token);
  }

  markTotpEnabled(): RecoveryCodes {
    this.#profile = { ...this.#profile, twoFactorEnabled: true, recoveryCodesLeft: 10 };

    return { recoveryCodes: recoveryCodes('AB') };
  }

  // ------------------------------------------------------------------

  #require(userId: string): StaffMember {
    const row = this.#staff.find((candidate) => candidate.userId === userId);
    if (row === undefined) {
      throw new AuthError('unavailable');
    }

    return row;
  }

  #assertNotSelf(row: StaffMember): StaffMember {
    if (row.self) {
      throw new StaffError('self');
    }

    return row;
  }

  #assertAssignable(role: StaffMember['role']): void {
    if (role === 'viewer' && !this.#viewerEnabled) {
      throw new StaffError('viewer-disabled');
    }
  }

  #assertCode(code: string): void {
    if (code !== MOCK_ENROLMENT_CODE) {
      throw new AuthError('totp-mismatch');
    }
  }

  #replace(updated: StaffMember): void {
    this.#staff = this.#staff.map((row) => (row.userId === updated.userId ? updated : row));
  }

  #resolve({
    role,
    departmentIds,
  }: {
    readonly role: StaffMember['role'];
    readonly departmentIds: readonly string[];
  }): StaffMember['departments'] {
    if (role === 'admin') {
      return 'all';
    }
    if (departmentIds.length === 0) {
      return role === 'agent' ? [] : 'all';
    }

    return MOCK_DEPARTMENTS.filter((department) => departmentIds.includes(department.id));
  }
}

/** The brand every fixture row belongs to, for a test that has to name one. */
export const MOCK_STAFF_BRAND_ID = BRAND;
