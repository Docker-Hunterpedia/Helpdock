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
  TotpRotationProof,
  TotpRotationStart,
} from '@helpdock/schemas';
import {
  normalisePhone,
  PROFILE_PHOTO_MAX_BYTES,
  PROFILE_PHOTO_MIME_TYPES,
  publicNameOf,
} from '@helpdock/schemas';
import { AuthError } from '../auth/api.js';
import { type StaffApi, StaffError } from './api.js';

/** The one password the fixtures answer `password-breached` for, as the api's bundled list would. */
export const MOCK_BREACHED_PASSWORD = 'passwordpassword';

export const assertNotMockBreached = (password: string): void => {
  if (password.toLowerCase() === MOCK_BREACHED_PASSWORD) {
    throw new AuthError('password-breached');
  }
};

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
/** What every rotation start answers, so a confirm can name it (and a second cannot). */
/** A confirmation code the fixture answers as stale: the factors changed since the rotation began. */
export const MOCK_STALE_ROTATION_CODE = '999999';
export const MOCK_ROTATION_ID = '0192c3f0-1a2b-7c3d-8e4f-0000000000f0';

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
  recoveryCodeProofAllowed: true,
  publicName: null,
  displayName: 'Lina',
  jobTitleEn: 'Billing specialist',
  jobTitleAr: 'أخصائية الفوترة',
  phone: '+966551234567',
  timeZone: 'Asia/Riyadh',
  photo: null,
});

/** What the api's sniff reads: the first bytes of a PNG, a JPEG or a WebP. */
const looksLikeImage = (head: Uint8Array): boolean => {
  const at = (offset: number, bytes: readonly number[]): boolean =>
    bytes.every((byte, index) => head[offset + index] === byte);

  return (
    at(0, [0x89, 0x50, 0x4e, 0x47]) ||
    at(0, [0xff, 0xd8, 0xff]) ||
    (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]))
  );
};

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('unreadable'));
    };
    reader.readAsDataURL(file);
  });

const seedSessions = (): StaffSessionList => ({
  sessions: [
    {
      familyId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
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
  /** The rotation id a start answered, so a confirm can be refused as spent. */
  #stagedRotationId: string | null = null;
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
    let phone = request.phone === undefined ? this.#profile.phone : request.phone;
    if (request.phone !== undefined && request.phone !== null) {
      const normalised = normalisePhone(request.phone);
      if (!normalised.ok) {
        throw new StaffError('invalid-phone');
      }
      phone = normalised.value;
    }
    const next = {
      ...this.#profile,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.locale === undefined ? {} : { locale: request.locale }),
      ...(request.publicName === undefined ? {} : { publicName: request.publicName }),
      ...(request.jobTitleEn === undefined ? {} : { jobTitleEn: request.jobTitleEn }),
      ...(request.jobTitleAr === undefined ? {} : { jobTitleAr: request.jobTitleAr }),
      ...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
      phone,
    };
    this.#profile = {
      ...next,
      displayName: publicNameOf({ fullName: next.name, publicName: next.publicName }),
    };

    return this.#profile;
  }

  async uploadPhoto(file: File): Promise<Profile> {
    if (file.size > PROFILE_PHOTO_MAX_BYTES) {
      throw new StaffError('photo-too-large');
    }
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (
      !(PROFILE_PHOTO_MIME_TYPES as readonly string[]).includes(file.type) ||
      !looksLikeImage(head)
    ) {
      throw new StaffError('photo-unsupported-type');
    }
    const url = await readAsDataUrl(file);
    this.#profile = { ...this.#profile, photo: { small: url, large: url } };

    return this.#profile;
  }

  async removePhoto(): Promise<Profile> {
    this.#profile = { ...this.#profile, photo: null };

    return this.#profile;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (currentPassword !== MOCK_CURRENT_PASSWORD) {
      throw new AuthError('invalid-credentials');
    }
    assertNotMockBreached(newPassword);

    this.#sessions = { sessions: this.#sessions.sessions.filter((session) => session.current) };
  }

  async disableTotp(code: string): Promise<void> {
    this.#assertCode(code);
    this.#profile = { ...this.#profile, twoFactorEnabled: false, recoveryCodesLeft: 0 };
  }

  /** Plays a break-glass account under SSO enforcement: no recovery code may start a replacement. */
  barRecoveryCodeProofs(): void {
    this.#profile = { ...this.#profile, recoveryCodeProofAllowed: false };
  }

  async startTotpRotation(proof: TotpRotationProof): Promise<TotpRotationStart> {
    if (proof.recoveryCode !== undefined && !this.#profile.recoveryCodeProofAllowed) {
      throw new AuthError('recovery-code-not-allowed');
    }
    if (!this.#profile.twoFactorEnabled) {
      throw new AuthError('totp-not-enabled');
    }
    // The same proofs the api takes, with the fixture's one password and code.
    if (proof.code !== undefined) {
      this.#assertCode(proof.code);
    } else if (proof.recoveryCode !== undefined) {
      if (proof.currentPassword !== undefined && proof.currentPassword !== MOCK_CURRENT_PASSWORD) {
        throw new AuthError('invalid-credentials');
      }
    } else if (proof.passkey === undefined) {
      throw new AuthError('invalid-credentials');
    }

    this.#stagedRotationId = MOCK_ROTATION_ID;

    return {
      rotationId: MOCK_ROTATION_ID,
      secret: MOCK_TOTP_SECRET,
      uri: `otpauth://totp/Helpdock:lina@helpdock.com?secret=${MOCK_TOTP_SECRET}&issuer=Helpdock`,
    };
  }

  async confirmTotpRotation(rotationId: string, code: string): Promise<void> {
    if (rotationId !== this.#stagedRotationId || this.#profile.twoFactorEnabled === false) {
      throw new AuthError('challenge-expired');
    }
    if (code === MOCK_STALE_ROTATION_CODE) {
      this.#stagedRotationId = null;
      throw new AuthError('challenge-expired');
    }
    this.#assertCode(code);
    this.#stagedRotationId = null;
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
