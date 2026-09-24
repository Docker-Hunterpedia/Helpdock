import type {
  Brand,
  BrandSettings,
  BrandUpdateRequest,
  CustomFieldCreateRequest,
  CustomFieldDef,
  CustomFieldDefList,
  CustomFieldTarget,
  CustomFieldUpdateRequest,
  CustomFieldUsage,
  DepartmentCreateRequest,
  DepartmentSummary,
  DepartmentSummaryList,
  DepartmentUpdateRequest,
  EligibleMemberList,
  FeedbackSettingsUpdateRequest,
  ReplyBehaviourUpdateRequest,
  TagCreateRequest,
  TagList,
  TagSummary,
  TagUpdateRequest,
  TagUsage,
  TeamList,
  TicketingRefusal,
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

/**
 * Everything the Ticketing settings screens need, and nothing else.
 * `MockTicketingApi` is the fixture the unit tests and the mock Playwright
 * projects run against; `HttpTicketingApi` is the real service (M1-01).
 *
 * The shape mirrors `StaffApi`: one interface, two adapters, and failures that
 * cross as a code rather than as a message, so the sentence a person reads is
 * always a translated string (packages/i18n README).
 */
export interface TicketingApi {
  departments(brandId: string): Promise<DepartmentSummaryList>;
  createDepartment(brandId: string, request: DepartmentCreateRequest): Promise<DepartmentSummary>;
  updateDepartment(
    brandId: string,
    departmentId: string,
    request: DepartmentUpdateRequest,
  ): Promise<DepartmentSummary>;
  deleteDepartment(brandId: string, departmentId: string): Promise<void>;
  /** The whole list in its new order; the server refuses a partial one. */
  reorderDepartments(brandId: string, departmentIds: string[]): Promise<DepartmentSummaryList>;

  teams(brandId: string, departmentId: string): Promise<TeamList>;
  createTeam(brandId: string, departmentId: string, name: string): Promise<TeamList>;
  renameTeam(
    brandId: string,
    departmentId: string,
    teamId: string,
    name: string,
  ): Promise<TeamList>;
  deleteTeam(brandId: string, departmentId: string, teamId: string): Promise<TeamList>;

  eligibleMembers(brandId: string, departmentId: string): Promise<EligibleMemberList>;
  addMember(
    brandId: string,
    departmentId: string,
    teamId: string,
    userId: string,
  ): Promise<TeamList>;
  removeMember(
    brandId: string,
    departmentId: string,
    teamId: string,
    userId: string,
  ): Promise<TeamList>;

  /** The brand's own fields. The Settings screen edits these; M1-01 ships the call. */
  brand(brandId: string): Promise<Brand>;
  updateBrand(brandId: string, request: BrandUpdateRequest): Promise<Brand>;

  // ---------------------------------------------------------------- M1-08

  /** The brand's statuses, in their own order (DOMAIN-RULES §2.1). */
  statuses(brandId: string): Promise<TicketStatusList>;
  createStatus(brandId: string, request: TicketStatusCreateRequest): Promise<TicketStatus>;
  updateStatus(
    brandId: string,
    statusId: string,
    request: TicketStatusUpdateRequest,
  ): Promise<TicketStatus>;
  /**
   * What the confirmation prints before it asks: how many tickets would move,
   * and which status they move to.
   */
  statusUsage(brandId: string, statusId: string): Promise<TicketStatusUsage>;
  deleteStatus(brandId: string, statusId: string): Promise<void>;
  /** The whole list in its new order; the server refuses a partial one. */
  reorderStatuses(brandId: string, statusIds: string[]): Promise<TicketStatusList>;

  /** The two settings of DOMAIN-RULES §2.3 a Team Leader may change. */
  updateReplyBehaviour(
    brandId: string,
    request: ReplyBehaviourUpdateRequest,
  ): Promise<BrandSettings>;

  // ---------------------------------------------------------------- M1-12

  /** The Feedback tab's three toggles: CSAT, time tracking, the composer timer. */
  updateFeedback(brandId: string, request: FeedbackSettingsUpdateRequest): Promise<BrandSettings>;
  // ---------------------------------------------------------------- M1-06

  tags(brandId: string): Promise<TagList>;
  createTag(brandId: string, request: TagCreateRequest): Promise<TagSummary>;
  updateTag(brandId: string, tagId: string, request: TagUpdateRequest): Promise<TagSummary>;
  /** The whole list in its new order; the server refuses a partial one. */
  reorderTags(brandId: string, tagIds: string[]): Promise<TagList>;
  /** Read before the confirmation, so the dialog can say what the delete costs. */
  tagUsage(brandId: string, tagId: string): Promise<TagUsage>;
  deleteTag(brandId: string, tagId: string): Promise<void>;

  customFields(brandId: string, target?: CustomFieldTarget): Promise<CustomFieldDefList>;
  createCustomField(brandId: string, request: CustomFieldCreateRequest): Promise<CustomFieldDef>;
  updateCustomField(
    brandId: string,
    fieldId: string,
    request: CustomFieldUpdateRequest,
  ): Promise<CustomFieldDef>;
  reorderCustomFields(
    brandId: string,
    target: CustomFieldTarget,
    fieldIds: string[],
  ): Promise<CustomFieldDefList>;
  customFieldUsage(brandId: string, fieldId: string): Promise<CustomFieldUsage>;
  deleteCustomField(brandId: string, fieldId: string): Promise<void>;

  ticketTemplates(brandId: string): Promise<TicketTemplateList>;
  createTicketTemplate(
    brandId: string,
    request: TicketTemplateCreateRequest,
  ): Promise<TicketTemplate>;
  updateTicketTemplate(
    brandId: string,
    templateId: string,
    request: TicketTemplateUpdateRequest,
  ): Promise<TicketTemplate>;
  deleteTicketTemplate(brandId: string, templateId: string): Promise<void>;
  /** The template with its placeholders filled, rendered by the api. */
  previewTicketTemplate(brandId: string, templateId: string): Promise<TicketTemplatePreview>;
}

/**
 * A ticketing action refused by a rule rather than by a permission. The
 * `reason` picks the catalog key, so the toast a person reads is a translated
 * string and never an api string.
 */
export class TicketingError extends Error {
  readonly reason: TicketingRefusal;

  constructor(reason: TicketingRefusal) {
    super(`ticketing: ${reason}`);
    this.name = 'TicketingError';
    this.reason = reason;
  }
}

export const isTicketingError = (error: unknown): error is TicketingError =>
  error instanceof TicketingError;
