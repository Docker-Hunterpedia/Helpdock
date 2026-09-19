import type {
  DepartmentList,
  Profile,
  ProfileUpdateRequest,
  RecoveryCodes,
  StaffInviteRequest,
  StaffList,
  StaffMember,
  StaffRefusal,
  StaffSessionList,
  StaffUpdateRequest,
} from '@helpdock/schemas';

/**
 * Everything the staff screens and the security page need, and nothing else.
 * `MockStaffApi` is the fixture the unit tests and the mock Playwright projects
 * run against; `HttpStaffApi` is the real service (M0-06).
 *
 * The shape mirrors `AuthApi`: one interface, two adapters, and failures that
 * cross as a code rather than as a message, so the sentence a person reads is
 * always a translated string (packages/i18n README).
 */
export interface StaffApi {
  listStaff(brandId: string, search?: string): Promise<StaffList>;
  /** The chip picker's options. Empty until M1-01 creates departments. */
  departments(brandId: string): Promise<DepartmentList>;

  invite(brandId: string, request: StaffInviteRequest): Promise<StaffMember>;
  resendInvite(brandId: string, userId: string): Promise<void>;
  revokeInvite(brandId: string, userId: string): Promise<void>;

  updateStaff(brandId: string, userId: string, request: StaffUpdateRequest): Promise<StaffMember>;
  setActive(brandId: string, userId: string, active: boolean): Promise<StaffMember>;
  removeFromBrand(brandId: string, userId: string): Promise<void>;

  profile(): Promise<Profile>;
  updateProfile(request: ProfileUpdateRequest): Promise<Profile>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  disableTotp(code: string): Promise<void>;
  regenerateRecoveryCodes(code: string): Promise<RecoveryCodes>;

  sessions(): Promise<StaffSessionList>;
  revokeSession(familyId: string): Promise<void>;
}

/**
 * A staff action refused by a rule rather than by a permission. The `reason`
 * picks the catalog key, so the toast a person reads is a translated string and
 * never an api string.
 */
export class StaffError extends Error {
  readonly reason: StaffRefusal;

  constructor(reason: StaffRefusal) {
    super(`staff: ${reason}`);
    this.name = 'StaffError';
    this.reason = reason;
  }
}

export const isStaffError = (error: unknown): error is StaffError => error instanceof StaffError;
