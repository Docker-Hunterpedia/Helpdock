import type {
  AssignmentAgent,
  AssignmentAgentList,
  AssignmentAgentUpdateRequest,
  Brand,
  BrandSettings,
  BrandUpdateRequest,
  CustomFieldCreateRequest,
  CustomFieldDef,
  CustomFieldDefList,
  CustomFieldTarget,
  CustomFieldUpdateRequest,
  CustomFieldUsage,
  DepartmentAssignment,
  DepartmentAssignmentList,
  DepartmentAssignmentUpdateRequest,
  DepartmentCreateRequest,
  DepartmentSummary,
  DepartmentSummaryList,
  DepartmentUpdateRequest,
  EligibleMemberList,
  ReplyBehaviourUpdateRequest,
  TagCreateRequest,
  TagList,
  TagSummary,
  TagUpdateRequest,
  TagUsage,
  TeamList,
  TicketStatus,
  TicketStatusCreateRequest,
  TicketStatusList,
  TicketStatusUpdateRequest,
  TicketStatusUsage,
  TicketTemplate,
  TicketTemplateCreateRequest,
  TicketTemplateList,
  TicketTemplatePreview,
  TicketTemplateUpdateRequest,
} from '@helpdock/schemas';
import {
  assignmentAgentListSchema,
  assignmentAgentSchema,
  brandSchema,
  brandSettingsSchema,
  customFieldDefListSchema,
  customFieldDefSchema,
  customFieldUsageSchema,
  departmentAssignmentListSchema,
  departmentAssignmentSchema,
  departmentSummaryListSchema,
  departmentSummarySchema,
  eligibleMemberListSchema,
  tagListSchema,
  tagSummarySchema,
  tagUsageSchema,
  teamListSchema,
  ticketStatusListSchema,
  ticketStatusSchema,
  ticketStatusUsageSchema,
  ticketTemplateListSchema,
  ticketTemplatePreviewSchema,
  ticketTemplateSchema,
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

  // ---------------------------------------------------------------- M1-06

  async tags(brandId: string): Promise<TagList> {
    return tagListSchema.parse(await this.#transport.request('GET', this.#tags(brandId)));
  }

  async createTag(brandId: string, request: TagCreateRequest): Promise<TagSummary> {
    return tagSummarySchema.parse(
      await this.#transport.request('POST', this.#tags(brandId), request),
    );
  }

  async updateTag(brandId: string, tagId: string, request: TagUpdateRequest): Promise<TagSummary> {
    return tagSummarySchema.parse(
      await this.#transport.request('PATCH', this.#tag(brandId, tagId), request),
    );
  }

  async reorderTags(brandId: string, tagIds: string[]): Promise<TagList> {
    return tagListSchema.parse(
      await this.#transport.request('POST', `${this.#tags(brandId)}/reorder`, { tagIds }),
    );
  }

  async tagUsage(brandId: string, tagId: string): Promise<TagUsage> {
    return tagUsageSchema.parse(
      await this.#transport.request('GET', `${this.#tag(brandId, tagId)}/usage`),
    );
  }

  async deleteTag(brandId: string, tagId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#tag(brandId, tagId));
  }

  async customFields(brandId: string, target?: CustomFieldTarget): Promise<CustomFieldDefList> {
    const query = target === undefined ? '' : `?target=${encodeURIComponent(target)}`;

    return customFieldDefListSchema.parse(
      await this.#transport.request('GET', `${this.#fields(brandId)}${query}`),
    );
  }

  async createCustomField(
    brandId: string,
    request: CustomFieldCreateRequest,
  ): Promise<CustomFieldDef> {
    return customFieldDefSchema.parse(
      await this.#transport.request('POST', this.#fields(brandId), request),
    );
  }

  async updateCustomField(
    brandId: string,
    fieldId: string,
    request: CustomFieldUpdateRequest,
  ): Promise<CustomFieldDef> {
    return customFieldDefSchema.parse(
      await this.#transport.request('PATCH', this.#field(brandId, fieldId), request),
    );
  }

  async reorderCustomFields(
    brandId: string,
    target: CustomFieldTarget,
    fieldIds: string[],
  ): Promise<CustomFieldDefList> {
    return customFieldDefListSchema.parse(
      await this.#transport.request('POST', `${this.#fields(brandId)}/reorder`, {
        target,
        fieldIds,
      }),
    );
  }

  async customFieldUsage(brandId: string, fieldId: string): Promise<CustomFieldUsage> {
    return customFieldUsageSchema.parse(
      await this.#transport.request('GET', `${this.#field(brandId, fieldId)}/usage`),
    );
  }

  async deleteCustomField(brandId: string, fieldId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#field(brandId, fieldId));
  }

  async ticketTemplates(brandId: string): Promise<TicketTemplateList> {
    return ticketTemplateListSchema.parse(
      await this.#transport.request('GET', this.#templates(brandId)),
    );
  }

  async createTicketTemplate(
    brandId: string,
    request: TicketTemplateCreateRequest,
  ): Promise<TicketTemplate> {
    return ticketTemplateSchema.parse(
      await this.#transport.request('POST', this.#templates(brandId), request),
    );
  }

  async updateTicketTemplate(
    brandId: string,
    templateId: string,
    request: TicketTemplateUpdateRequest,
  ): Promise<TicketTemplate> {
    return ticketTemplateSchema.parse(
      await this.#transport.request('PATCH', this.#template(brandId, templateId), request),
    );
  }

  async deleteTicketTemplate(brandId: string, templateId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#template(brandId, templateId));
  }

  async previewTicketTemplate(brandId: string, templateId: string): Promise<TicketTemplatePreview> {
    return ticketTemplatePreviewSchema.parse(
      await this.#transport.request('GET', `${this.#template(brandId, templateId)}/preview`),
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

  #tags(brandId: string): string {
    return `${this.#brand(brandId)}/tags`;
  }

  #tag(brandId: string, tagId: string): string {
    return `${this.#tags(brandId)}/${encodeURIComponent(tagId)}`;
  }

  // ---------------------------------------------------------------- M1-07

  async assignment(brandId: string): Promise<DepartmentAssignmentList> {
    return departmentAssignmentListSchema.parse(
      await this.#transport.request('GET', this.#assignment(brandId)),
    );
  }

  async updateAssignment(
    brandId: string,
    departmentId: string,
    request: DepartmentAssignmentUpdateRequest,
  ): Promise<DepartmentAssignment> {
    return departmentAssignmentSchema.parse(
      await this.#transport.request(
        'PATCH',
        `${this.#assignment(brandId)}/${encodeURIComponent(departmentId)}`,
        request,
      ),
    );
  }

  async assignmentAgents(brandId: string, departmentId: string): Promise<AssignmentAgentList> {
    return assignmentAgentListSchema.parse(
      await this.#transport.request(
        'GET',
        `${this.#assignment(brandId)}/${encodeURIComponent(departmentId)}/agents`,
      ),
    );
  }

  async updateAssignmentAgent(
    brandId: string,
    departmentId: string,
    userId: string,
    request: AssignmentAgentUpdateRequest,
  ): Promise<AssignmentAgent> {
    return assignmentAgentSchema.parse(
      await this.#transport.request(
        'PATCH',
        `${this.#assignment(brandId)}/${encodeURIComponent(departmentId)}/agents/${encodeURIComponent(userId)}`,
        request,
      ),
    );
  }

  #assignment(brandId: string): string {
    return `${this.#brand(brandId)}/assignment`;
  }

  #fields(brandId: string): string {
    return `${this.#brand(brandId)}/custom-fields`;
  }

  #field(brandId: string, fieldId: string): string {
    return `${this.#fields(brandId)}/${encodeURIComponent(fieldId)}`;
  }

  #templates(brandId: string): string {
    return `${this.#brand(brandId)}/ticket-templates`;
  }

  #template(brandId: string, templateId: string): string {
    return `${this.#templates(brandId)}/${encodeURIComponent(templateId)}`;
  }
}
