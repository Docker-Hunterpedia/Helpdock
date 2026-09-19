import type {
  DepartmentList,
  Profile,
  ProfileUpdateRequest,
  RecoveryCodes,
  StaffInviteRequest,
  StaffList,
  StaffMember,
  StaffSessionList,
  StaffUpdateRequest,
} from '@helpdock/schemas';
import {
  departmentListSchema,
  profileSchema,
  recoveryCodesSchema,
  staffListSchema,
  staffMemberSchema,
  staffSessionListSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { StaffApi } from './api.js';

/**
 * The real staff service (M0-06). It shares its {@link HttpTransport} with
 * `HttpAuthApi`, so there is one access token and one refresh in the app.
 *
 * Every response is parsed through the schema `apps/api` declared it with, so a
 * shape the two disagree about fails here rather than three components deep.
 */
export class HttpStaffApi implements StaffApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async listStaff(brandId: string, search?: string): Promise<StaffList> {
    const query =
      search === undefined || search.trim() === ''
        ? ''
        : `?search=${encodeURIComponent(search.trim())}`;

    return staffListSchema.parse(
      await this.#transport.request('GET', `${this.#brand(brandId)}/staff${query}`),
    );
  }

  async departments(brandId: string): Promise<DepartmentList> {
    return departmentListSchema.parse(
      await this.#transport.request('GET', `${this.#brand(brandId)}/departments`),
    );
  }

  async invite(brandId: string, request: StaffInviteRequest): Promise<StaffMember> {
    return staffMemberSchema.parse(
      await this.#transport.request('POST', `${this.#brand(brandId)}/staff/invites`, request),
    );
  }

  async resendInvite(brandId: string, userId: string): Promise<void> {
    await this.#transport.request('POST', `${this.#brand(brandId)}/staff/invites/${userId}/resend`);
  }

  async revokeInvite(brandId: string, userId: string): Promise<void> {
    await this.#transport.request('DELETE', `${this.#brand(brandId)}/staff/invites/${userId}`);
  }

  async updateStaff(
    brandId: string,
    userId: string,
    request: StaffUpdateRequest,
  ): Promise<StaffMember> {
    return staffMemberSchema.parse(
      await this.#transport.request('PATCH', `${this.#brand(brandId)}/staff/${userId}`, request),
    );
  }

  async setActive(brandId: string, userId: string, active: boolean): Promise<StaffMember> {
    return staffMemberSchema.parse(
      await this.#transport.request(
        'POST',
        `${this.#brand(brandId)}/staff/${userId}/${active ? 'reactivate' : 'deactivate'}`,
      ),
    );
  }

  async removeFromBrand(brandId: string, userId: string): Promise<void> {
    await this.#transport.request('DELETE', `${this.#brand(brandId)}/staff/${userId}/role`);
  }

  // ------------------------------------------------------------------
  // The account the person owns
  // ------------------------------------------------------------------

  async profile(): Promise<Profile> {
    return profileSchema.parse(await this.#transport.request('GET', '/me/profile'));
  }

  async updateProfile(request: ProfileUpdateRequest): Promise<Profile> {
    return profileSchema.parse(await this.#transport.request('PATCH', '/me/profile', request));
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.#transport.request('POST', '/me/password', { currentPassword, newPassword });
  }

  async disableTotp(code: string): Promise<void> {
    await this.#transport.request('POST', '/me/totp/disable', { code });
  }

  async regenerateRecoveryCodes(code: string): Promise<RecoveryCodes> {
    return recoveryCodesSchema.parse(
      await this.#transport.request('POST', '/me/recovery-codes/regenerate', { code }),
    );
  }

  async sessions(): Promise<StaffSessionList> {
    return staffSessionListSchema.parse(await this.#transport.request('GET', '/me/sessions'));
  }

  async revokeSession(familyId: string): Promise<void> {
    await this.#transport.request('DELETE', `/me/sessions/${familyId}`);
  }

  #brand(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}`;
  }
}
