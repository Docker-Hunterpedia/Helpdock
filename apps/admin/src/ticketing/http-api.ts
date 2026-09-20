import type {
  Brand,
  BrandSettings,
  BrandUpdateRequest,
  DepartmentCreateRequest,
  DepartmentSummary,
  DepartmentSummaryList,
  DepartmentUpdateRequest,
  EligibleMemberList,
  ReplyBehaviourUpdateRequest,
  TeamList,
  TicketStatus,
  TicketStatusCreateRequest,
  TicketStatusList,
  TicketStatusUpdateRequest,
  TicketStatusUsage,
} from '@helpdock/schemas';
import {
  brandSchema,
  brandSettingsSchema,
  departmentSummaryListSchema,
  departmentSummarySchema,
  eligibleMemberListSchema,
  teamListSchema,
  ticketStatusListSchema,
  ticketStatusSchema,
  ticketStatusUsageSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { TicketingApi } from './api.js';

/**
 * The real ticketing settings service (M1-01). It shares its
 * {@link HttpTransport} with `HttpAuthApi` and `HttpStaffApi`, so there is one
 * access token and one refresh in the app.
 *
 * Every response is parsed through the schema `apps/api` declared it with, so a
 * shape the two disagree about fails here rather than three components deep.
 */
export class HttpTicketingApi implements TicketingApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async departments(brandId: string): Promise<DepartmentSummaryList> {
    return departmentSummaryListSchema.parse(
      await this.#transport.request('GET', this.#departments(brandId)),
    );
  }

  async createDepartment(
    brandId: string,
    request: DepartmentCreateRequest,
  ): Promise<DepartmentSummary> {
    return departmentSummarySchema.parse(
      await this.#transport.request('POST', this.#departments(brandId), request),
    );
  }

  async updateDepartment(
    brandId: string,
    departmentId: string,
    request: DepartmentUpdateRequest,
  ): Promise<DepartmentSummary> {
    return departmentSummarySchema.parse(
      await this.#transport.request('PATCH', this.#department(brandId, departmentId), request),
    );
  }

  async deleteDepartment(brandId: string, departmentId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#department(brandId, departmentId));
  }

  async reorderDepartments(
    brandId: string,
    departmentIds: string[],
  ): Promise<DepartmentSummaryList> {
    return departmentSummaryListSchema.parse(
      await this.#transport.request('POST', `${this.#departments(brandId)}/reorder`, {
        departmentIds,
      }),
    );
  }

  async teams(brandId: string, departmentId: string): Promise<TeamList> {
    return teamListSchema.parse(
      await this.#transport.request('GET', `${this.#department(brandId, departmentId)}/teams`),
    );
  }

  async createTeam(brandId: string, departmentId: string, name: string): Promise<TeamList> {
    return teamListSchema.parse(
      await this.#transport.request('POST', `${this.#department(brandId, departmentId)}/teams`, {
        name,
      }),
    );
  }

  async renameTeam(
    brandId: string,
    departmentId: string,
    teamId: string,
    name: string,
  ): Promise<TeamList> {
    return teamListSchema.parse(
      await this.#transport.request('PATCH', this.#team(brandId, departmentId, teamId), { name }),
    );
  }

  async deleteTeam(brandId: string, departmentId: string, teamId: string): Promise<TeamList> {
    return teamListSchema.parse(
      await this.#transport.request('DELETE', this.#team(brandId, departmentId, teamId)),
    );
  }

  async eligibleMembers(brandId: string, departmentId: string): Promise<EligibleMemberList> {
    return eligibleMemberListSchema.parse(
      await this.#transport.request(
        'GET',
        `${this.#department(brandId, departmentId)}/eligible-members`,
      ),
    );
  }

  async addMember(
    brandId: string,
    departmentId: string,
    teamId: string,
    userId: string,
  ): Promise<TeamList> {
    return teamListSchema.parse(
      await this.#transport.request(
        'POST',
        `${this.#team(brandId, departmentId, teamId)}/members`,
        { userId },
      ),
    );
  }

  async removeMember(
    brandId: string,
    departmentId: string,
    teamId: string,
    userId: string,
  ): Promise<TeamList> {
    return teamListSchema.parse(
      await this.#transport.request(
        'DELETE',
        `${this.#team(brandId, departmentId, teamId)}/members/${encodeURIComponent(userId)}`,
      ),
    );
  }

  async brand(brandId: string): Promise<Brand> {
    return brandSchema.parse(await this.#transport.request('GET', this.#brand(brandId)));
  }

  async updateBrand(brandId: string, request: BrandUpdateRequest): Promise<Brand> {
    return brandSchema.parse(await this.#transport.request('PATCH', this.#brand(brandId), request));
  }

  // ------------------------------------------------------------------ M1-08

  async statuses(brandId: string): Promise<TicketStatusList> {
    return ticketStatusListSchema.parse(
      await this.#transport.request('GET', this.#statuses(brandId)),
    );
  }

  async createStatus(brandId: string, request: TicketStatusCreateRequest): Promise<TicketStatus> {
    return ticketStatusSchema.parse(
      await this.#transport.request('POST', this.#statuses(brandId), request),
    );
  }

  async updateStatus(
    brandId: string,
    statusId: string,
    request: TicketStatusUpdateRequest,
  ): Promise<TicketStatus> {
    return ticketStatusSchema.parse(
      await this.#transport.request('PATCH', this.#status(brandId, statusId), request),
    );
  }

  async statusUsage(brandId: string, statusId: string): Promise<TicketStatusUsage> {
    return ticketStatusUsageSchema.parse(
      await this.#transport.request('GET', `${this.#status(brandId, statusId)}/usage`),
    );
  }

  async deleteStatus(brandId: string, statusId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#status(brandId, statusId));
  }

  async reorderStatuses(brandId: string, statusIds: string[]): Promise<TicketStatusList> {
    return ticketStatusListSchema.parse(
      await this.#transport.request('POST', `${this.#statuses(brandId)}/reorder`, { statusIds }),
    );
  }

  async updateReplyBehaviour(
    brandId: string,
    request: ReplyBehaviourUpdateRequest,
  ): Promise<BrandSettings> {
    return brandSettingsSchema.parse(
      await this.#transport.request(
        'PATCH',
        `${this.#brand(brandId)}/ticketing/reply-behaviour`,
        request,
      ),
    );
  }

  // ------------------------------------------------------------------

  #statuses(brandId: string): string {
    return `${this.#brand(brandId)}/ticket-statuses`;
  }

  #status(brandId: string, statusId: string): string {
    return `${this.#statuses(brandId)}/${encodeURIComponent(statusId)}`;
  }

  #brand(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}`;
  }

  #departments(brandId: string): string {
    return `${this.#brand(brandId)}/departments`;
  }

  #department(brandId: string, departmentId: string): string {
    return `${this.#departments(brandId)}/${encodeURIComponent(departmentId)}`;
  }

  #team(brandId: string, departmentId: string, teamId: string): string {
    return `${this.#department(brandId, departmentId)}/teams/${encodeURIComponent(teamId)}`;
  }
}
