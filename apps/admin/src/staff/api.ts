import type {
  DepartmentList,
  PasskeyProof,
  Profile,
  ProfileUpdateRequest,
  RecoveryCodes,
  SecondFactorReset,
  SecondFactorSummary,
  StaffInviteRequest,
  StaffList,
  StaffMember,
  StaffRefusal,
  StaffSessionList,
  StaffUpdateRequest,
  TotpRotationProof,
  TotpRotationStart,
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

  /** Install admins only (#398): what resetting this person's second factor removes, and the digest to confirm. */
  secondFactorSummary(userId: string): Promise<SecondFactorSummary>;
  /** Behind the admin's own step-up and the digest they confirmed; answers what was removed. */
  resetSecondFactor(
    userId: string,
    proof: PasskeyProof,
    digest: string,
  ): Promise<SecondFactorReset>;

  profile(): Promise<Profile>;
  updateProfile(request: ProfileUpdateRequest): Promise<Profile>;
  /** M14-12. Sniffed, cropped square and re-encoded by the api; resolves to the profile with its new URLs. */
  uploadPhoto(file: File): Promise<Profile>;
  removePhoto(): Promise<Profile>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  disableTotp(code: string): Promise<void>;
  /** Step 1 of replacing the authenticator (#373): a step-up proof stages a new secret. */
  startTotpRotation(proof: TotpRotationProof): Promise<TotpRotationStart>;
  /** Step 2: a code from the new app swaps the secret in. */
  confirmTotpRotation(rotationId: string, code: string): Promise<void>;
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
