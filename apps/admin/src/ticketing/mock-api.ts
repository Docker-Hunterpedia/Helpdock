import type {
  AssignmentAgent,
  AssignmentAgentList,
  AssignmentAgentUpdateRequest,
  BlockedSender,
  BlockedSenderCreateRequest,
  BlockedSenderList,
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
  EligibleMember,
  EligibleMemberList,
  FeedbackSettingsUpdateRequest,
  ReplyBehaviourUpdateRequest,
  RetentionOverview,
  RetentionUpdateRequest,
  SpamSettingsUpdateRequest,
  TagCreateRequest,
  TagList,
  TagSummary,
  TagUpdateRequest,
  TagUsage,
  Team,
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
import { defaultBrandSettings, isChoiceField } from '@helpdock/schemas';
import { AuthError } from '../auth/api.js';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import { type TicketingApi, TicketingError } from './api.js';
import {
  MOCK_ASSIGNEES,
  MOCK_OMAR_ID,
  MOCK_SUPPORT_ID,
  MOCK_YARA_ID,
  type MockDepartmentAssignment,
  seedAssignmentSettings,
  worksIn,
} from './mock-assignment.js';
import { MockBlockList } from './mock-block-list.js';

/**
 * The fixture the Ticketing settings run against until an install is in front
 * of them. It is deliberately the whole of `TicketingApi` including the
 * refusals, so the screens and the browser tests exercise the same states the
 * real service produces: a duplicate name, the last department, somebody who
 * cannot reach the department, and a Team Leader's scope.
 *
 * Its departments start as the ones `MockStaffApi` offers in the chip picker,
 * so the two fixtures describe one brand rather than two.
 */

const MEMBERS: readonly EligibleMember[] = [
  {
    userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
    name: 'Lina Haddad',
    email: 'lina@helpdock.com',
    role: 'admin',
  },
  {
    userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000b',
    name: 'Omar Nasser',
    email: 'omar@helpdock.com',
    role: 'team_leader',
  },
  {
    userId: '0192c3f0-1a2b-7c3d-8e4f-00000000000c',
    name: 'Yara Salem',
    email: 'yara@helpdock.com',
    role: 'agent',
  },
];

/** The Arabic names the seeded departments carry, so the `ar` run has copy to draw. */
const ARABIC_NAMES: Readonly<Record<string, string>> = {
  Support: 'الدعم',
  Billing: 'الفوترة',
  Onboarding: 'الانضمام',
};

const seedDepartments = (): DepartmentSummary[] =>
  MOCK_DEPARTMENTS.map((department, index) => ({
    id: department.id,
    name: department.name,
    nameAr: ARABIC_NAMES[department.name] ?? null,
    sortOrder: index,
    defaultTeamId: null,
    defaultTeamName: null,
    teamCount: 0,
    memberCount: 0,
  }));

const seedBrand = (): Brand => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
  name: 'Helpdock',
  prefix: 'HD',
  defaultLocale: 'en',
  timezone: 'UTC',
  status: 'active',
  settings: defaultBrandSettings(),
});

/**
 * The six rows `seedBrandStatuses` writes for every brand, plus one a brand
 * added for itself — so the fixture has a deletable row, a default, and a
 * system row whose flags the editor must refuse to move.
 *
 * The ids are fixed rather than generated, so a Playwright run can name one.
 */
const seedStatuses = (): TicketStatus[] => [
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e1',
    name: 'Open',
    nameAr: 'مفتوحة',
    systemState: 'open',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: true,
    isSystem: true,
    excludedFromReports: false,
    isSpam: false,
    sortOrder: 0,
    color: 'info',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e2',
    name: 'Awaiting customer',
    nameAr: 'بانتظار العميل',
    systemState: 'on_hold',
    pausesSla: true,
    awaitingCustomer: true,
    isDefault: false,
    isSystem: true,
    excludedFromReports: false,
    isSpam: false,
    sortOrder: 1,
    color: 'warning',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e3',
    name: 'Escalated',
    nameAr: 'مُصعَّدة',
    systemState: 'escalated',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: false,
    isSystem: true,
    excludedFromReports: false,
    isSpam: false,
    sortOrder: 2,
    color: 'escalated',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e4',
    name: 'Closed',
    nameAr: 'مغلقة',
    systemState: 'closed',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: false,
    isSystem: true,
    excludedFromReports: false,
    isSpam: false,
    sortOrder: 3,
    color: 'success',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e5',
    name: 'Spam',
    nameAr: 'بريد مزعج',
    systemState: 'closed',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: false,
    isSystem: true,
    excludedFromReports: true,
    isSpam: true,
    sortOrder: 4,
    color: 'danger',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e6',
    name: 'Merged',
    nameAr: 'مدمجة',
    systemState: 'closed',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: false,
    isSystem: true,
    excludedFromReports: true,
    isSpam: false,
    sortOrder: 5,
    color: 'success',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e7',
    name: 'Waiting on supplier',
    nameAr: 'بانتظار المورّد',
    systemState: 'on_hold',
    pausesSla: true,
    awaitingCustomer: false,
    isDefault: false,
    isSystem: false,
    excludedFromReports: false,
    isSpam: false,
    sortOrder: 6,
    color: 'warning',
  },
];

/** Which fields a seeded row refuses, mirroring `status-rules.ts`. */
const FIXED_ON_SYSTEM_ROWS = ['systemState', 'pausesSla', 'awaitingCustomer'] as const;

/**
 * Three tags, three field definitions across the three targets, and two
 * templates. Enough for a list with something in it, an Arabic label on every
 * row so the `ar` run has copy to draw, and one of each shape the editors have
 * to handle: a choice field with options, a required field, and a template that
 * names a department.
 */
const seedTags = (): TagSummary[] => [
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000101',
    name: 'Refund',
    nameAr: 'استرداد',
    color: 'info',
    sortOrder: 0,
    ticketCount: 12,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000102',
    name: 'VIP',
    nameAr: 'كبار العملاء',
    color: 'escalated',
    sortOrder: 1,
    ticketCount: 3,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000103',
    name: 'Bug',
    nameAr: 'خلل',
    color: 'warning',
    sortOrder: 2,
    ticketCount: 0,
  },
];

const seedFields = (): CustomFieldDef[] => [
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000201',
    target: 'ticket',
    key: 'tier',
    label: 'Plan tier',
    labelAr: 'فئة الاشتراك',
    type: 'select',
    options: ['gold', 'silver', 'bronze'],
    required: true,
    agentVisible: true,
    sortOrder: 0,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000202',
    target: 'ticket',
    key: 'renews_on',
    label: 'Renews on',
    labelAr: 'يتجدد في',
    type: 'date',
    options: [],
    required: false,
    agentVisible: true,
    sortOrder: 1,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000205',
    target: 'ticket',
    key: 'order_id',
    label: 'Order id',
    labelAr: 'رقم الطلب',
    type: 'text',
    options: [],
    required: false,
    agentVisible: true,
    sortOrder: 2,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000203',
    target: 'contact',
    key: 'seats',
    label: 'Seats',
    labelAr: 'المقاعد',
    type: 'number',
    options: [],
    required: false,
    agentVisible: false,
    sortOrder: 0,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000204',
    target: 'account',
    key: 'strategic',
    label: 'Strategic account',
    labelAr: 'حساب استراتيجي',
    type: 'checkbox',
    options: [],
    required: false,
    agentVisible: true,
    sortOrder: 0,
  },
];

/**
 * What the fixture claims is already stored against a definition. Only the
 * seeded `tier` field has any, so the two refusals that need populated rows —
 * a type change and an option removal — can be reached, while anything a test
 * creates is free to be edited.
 */
const SEEDED_FIELD_USAGE: Readonly<
  Record<string, { rows: number; optionRows: Record<string, number> }>
> = {
  tier: { rows: 7, optionRows: { gold: 4, silver: 3 } },
};

const seedTemplates = (): TicketTemplate[] => [
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000301',
    name: 'Refund request',
    departmentId: MOCK_DEPARTMENTS[1]?.id ?? null,
    priority: 'high',
    subject: 'Refund for {{contact.name}}',
    bodyText: 'Hello {{contact.first_name}},\n\nWe have started your refund.\n\n{{brand.name}}',
    defaultTagIds: ['0192c3f0-1a2b-7c3d-8e4f-000000000101'],
    customDefaults: { tier: 'gold' },
    usageCount: 24,
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000302',
    name: 'Password reset',
    departmentId: null,
    priority: 'medium',
    subject: 'Password reset',
    bodyText: 'Hello {{contact.first_name}},\n\nHere is how to reset your password.',
    defaultTagIds: [],
    customDefaults: {},
    usageCount: 5,
  },
];

/** The brand the fixture speaks for, for the placeholders the preview fills. */
const MOCK_PLACEHOLDER_VALUES: ReadonlyMap<string, string> = new Map([
  ['brand.name', 'Helpdock'],
  ['contact.name', 'Mona Khalil'],
  ['contact.first_name', 'Mona'],
  ['contact.last_name', 'Khalil'],
  ['contact.email', 'mona@example.com'],
]);

const MOCK_PLACEHOLDER = /\{\{\s*([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\}\}/gi;

/**
 * The api's renderer, in miniature: a name it knows is replaced, one it does
 * not is left spelled out and reported. It is a `Map` here for the same reason
 * it is one there — an object would answer `constructor`.
 */
const renderMock = (text: string): { text: string; unknown: string[] } => {
  const unknown = new Set<string>();
  const rendered = text.replace(MOCK_PLACEHOLDER, (match, name: string) => {
    const value = MOCK_PLACEHOLDER_VALUES.get(name.toLowerCase());
    if (value === undefined) {
      unknown.add(name.toLowerCase());
      return match;
    }

    return value;
  });

  return { text: rendered, unknown: [...unknown] };
};

/** Sort order first, then name, as every list in this module is ordered. */
const byOrder = (a: TagSummary, b: TagSummary): number =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

let nextId = 1;

const newId = (kind: string): string => {
  nextId += 1;

  return `0192c3f0-1a2b-7c3d-8e4f-${kind}${String(nextId).padStart(10, '0')}`.slice(0, 36);
};

/**
 * The Data retention card as the artboard draws it: closed tickets kept 730
 * days, and a last run at 03:00 that removed 74 rows. The preview counts are
 * fixed numbers; the real ones are `COUNT(*)`s the api runs.
 */
const seedRetention = (): RetentionOverview => ({
  settings: {
    closedTickets: { kind: 'days', days: 730 },
    spamTicketDays: 30,
    aiCallDays: 90,
    searchLogDays: 180,
    auditLogDays: 730,
    visitorSessionDays: 30,
  },
  preview: {
    closedTickets: 12,
    spamTickets: 62,
    aiCalls: null,
    searchLog: null,
    auditLog: 0,
    visitorSessions: null,
  },
  lastRun: {
    at: '2026-09-24T03:00:00.000Z',
    counts: { closedTickets: 12, spamTickets: 62, auditLog: 0, outbox: 0 },
    total: 74,
  },
});

export class MockTicketingApi implements TicketingApi {
  #departments = seedDepartments();
  #teams: Team[] = [];
  #brand = seedBrand();
  #retention = seedRetention();
  #statuses = seedStatuses();
  #tags = seedTags();
  #fields = seedFields();
  #templates = seedTemplates();
  /** M1-11. Shared with `MockTicketsApi` when `createApis` builds the pair. */
  readonly #blockList: MockBlockList;
  /**
   * How many tickets sit in each status, so the delete confirmation has a
   * number to print. The real count comes from a `COUNT(*)` the api runs.
   */
  #ticketsByStatus: Record<string, number> = {
    '0192c3f0-1a2b-7c3d-8e4f-0000000000e7': 12,
  };
  /** M1-07. Keyed by department; then `${departmentId}:${userId}` for the per-agent rows. */
  #assignment = seedAssignmentSettings();
  #rotation = new Map<string, boolean>([[`${MOCK_SUPPORT_ID}:${MOCK_OMAR_ID}`, true]]);
  #skills = new Map<string, string[]>([
    [`${MOCK_SUPPORT_ID}:${MOCK_YARA_ID}`, ['0192c3f0-1a2b-7c3d-8e4f-000000000101']],
  ]);

  constructor(blockList: MockBlockList = new MockBlockList()) {
    this.#blockList = blockList;
  }

  async departments(_brandId: string): Promise<DepartmentSummaryList> {
    return { departments: this.#sorted().map((row) => this.#withCounts(row)) };
  }

  async createDepartment(
    _brandId: string,
    request: DepartmentCreateRequest,
  ): Promise<DepartmentSummary> {
    this.#assertNameFree(request.name);

    const created: DepartmentSummary = {
      id: newId('dd'),
      name: request.name,
      nameAr: request.nameAr ?? null,
      sortOrder: this.#departments.length,
      defaultTeamId: null,
      defaultTeamName: null,
      teamCount: 0,
      memberCount: 0,
    };
    this.#departments.push(created);

    return created;
  }

  async updateDepartment(
    _brandId: string,
    departmentId: string,
    request: DepartmentUpdateRequest,
  ): Promise<DepartmentSummary> {
    const department = this.#require(departmentId);
    if (
      request.name !== undefined &&
      request.name.toLowerCase() !== department.name.toLowerCase()
    ) {
      this.#assertNameFree(request.name, departmentId);
    }

    const updated: DepartmentSummary = {
      ...department,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
      ...(request.defaultTeamId === undefined ? {} : { defaultTeamId: request.defaultTeamId }),
    };
    this.#departments = this.#departments.map((row) => (row.id === departmentId ? updated : row));

    return this.#withCounts(updated);
  }

  async deleteDepartment(_brandId: string, departmentId: string): Promise<void> {
    this.#require(departmentId);
    if (this.#departments.length <= 1) {
      throw new TicketingError('last-department');
    }

    this.#departments = this.#departments.filter((row) => row.id !== departmentId);
    this.#teams = this.#teams.filter((team) => team.departmentId !== departmentId);
  }

  async reorderDepartments(
    brandId: string,
    departmentIds: string[],
  ): Promise<DepartmentSummaryList> {
    // The api refuses anything but a permutation of the whole list rather than
    // half-reordering a stale client's view; so does this.
    const unique = new Set(departmentIds);
    if (
      unique.size !== departmentIds.length ||
      unique.size !== this.#departments.length ||
      this.#departments.some((row) => !unique.has(row.id))
    ) {
      throw new AuthError('unavailable');
    }

    this.#departments = this.#departments.map((row) => ({
      ...row,
      sortOrder: departmentIds.indexOf(row.id),
    }));

    return this.departments(brandId);
  }

  async teams(_brandId: string, departmentId: string): Promise<TeamList> {
    this.#require(departmentId);

    return { teams: this.#teamsOf(departmentId) };
  }

  async createTeam(_brandId: string, departmentId: string, name: string): Promise<TeamList> {
    this.#require(departmentId);
    if (
      this.#teamsOf(departmentId).some((team) => team.name.toLowerCase() === name.toLowerCase())
    ) {
      throw new TicketingError('name-taken');
    }

    this.#teams.push({
      id: newId('cc'),
      departmentId,
      name,
      sortOrder: this.#teamsOf(departmentId).length,
      members: [],
    });

    return this.teams(_brandId, departmentId);
  }

  async renameTeam(
    brandId: string,
    departmentId: string,
    teamId: string,
    name: string,
  ): Promise<TeamList> {
    const team = this.#requireTeam(departmentId, teamId);
    if (
      name.toLowerCase() !== team.name.toLowerCase() &&
      this.#teamsOf(departmentId).some(
        (candidate) =>
          candidate.id !== teamId && candidate.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new TicketingError('name-taken');
    }

    this.#teams = this.#teams.map((row) => (row.id === teamId ? { ...row, name } : row));

    return this.teams(brandId, departmentId);
  }

  async deleteTeam(brandId: string, departmentId: string, teamId: string): Promise<TeamList> {
    this.#requireTeam(departmentId, teamId);
    this.#teams = this.#teams.filter((row) => row.id !== teamId);
    this.#departments = this.#departments.map((row) =>
      row.defaultTeamId === teamId ? { ...row, defaultTeamId: null } : row,
    );

    return this.teams(brandId, departmentId);
  }

  async eligibleMembers(_brandId: string, departmentId: string): Promise<EligibleMemberList> {
    this.#require(departmentId);

    return { members: [...MEMBERS] };
  }

  async addMember(
    brandId: string,
    departmentId: string,
    teamId: string,
    userId: string,
  ): Promise<TeamList> {
    this.#requireTeam(departmentId, teamId);
    const person = MEMBERS.find((member) => member.userId === userId);
    if (person === undefined) {
      throw new TicketingError('not-eligible');
    }

    this.#teams = this.#teams.map((row) =>
      row.id === teamId && !row.members.some((member) => member.userId === userId)
        ? {
            ...row,
            // The team list never carries an address; the picker does.
            members: [
              ...row.members,
              { userId: person.userId, name: person.name, role: person.role },
            ],
          }
        : row,
    );

    return this.teams(brandId, departmentId);
  }

  async removeMember(
    brandId: string,
    departmentId: string,
    teamId: string,
    userId: string,
  ): Promise<TeamList> {
    this.#requireTeam(departmentId, teamId);
    this.#teams = this.#teams.map((row) =>
      row.id === teamId
        ? { ...row, members: row.members.filter((member) => member.userId !== userId) }
        : row,
    );

    return this.teams(brandId, departmentId);
  }

  async brand(_brandId: string): Promise<Brand> {
    return this.#brand;
  }

  async updateBrand(_brandId: string, request: BrandUpdateRequest): Promise<Brand> {
    this.#brand = {
      ...this.#brand,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.defaultLocale === undefined ? {} : { defaultLocale: request.defaultLocale }),
      ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
      ...(request.settings === undefined ? {} : { settings: request.settings }),
    };
    this.#blockList.offerBlockSender = this.#brand.settings.offerBlockSender;

    return this.#brand;
  }

  // ------------------------------------------------------------------ M1-14

  async retention(_brandId: string): Promise<RetentionOverview> {
    return this.#retention;
  }

  async updateRetention(
    _brandId: string,
    request: RetentionUpdateRequest,
  ): Promise<RetentionOverview> {
    const closedCount = seedRetention().preview.closedTickets;
    this.#retention = {
      ...this.#retention,
      settings: request,
      preview: {
        ...this.#retention.preview,
        closedTickets: request.closedTickets.kind === 'never' ? null : closedCount,
      },
    };

    return this.#retention;
  }

  // ------------------------------------------------------------------ M1-08

  async statuses(_brandId: string): Promise<TicketStatusList> {
    return { statuses: this.#sortedStatuses() };
  }

  async createStatus(_brandId: string, request: TicketStatusCreateRequest): Promise<TicketStatus> {
    this.#assertStatusNameFree(request.name);

    const created: TicketStatus = {
      id: newId('ee'),
      name: request.name,
      nameAr: request.nameAr ?? null,
      systemState: request.systemState,
      pausesSla: request.pausesSla,
      awaitingCustomer: request.awaitingCustomer,
      isDefault: false,
      isSystem: false,
      excludedFromReports: false,
      isSpam: false,
      sortOrder: this.#statuses.length,
      color: request.color,
    };
    this.#statuses.push(created);

    return created;
  }

  async updateStatus(
    _brandId: string,
    statusId: string,
    request: TicketStatusUpdateRequest,
  ): Promise<TicketStatus> {
    const status = this.#requireStatus(statusId);
    // The same rules `apps/api/src/tickets/lifecycle/status-rules.ts` applies,
    // written out rather than imported because `apps/*` never import each other
    // (ARCHITECTURE §2). The screens and the browser tests therefore meet the
    // refusals the real service produces.
    if (status.isSystem && FIXED_ON_SYSTEM_ROWS.some((field) => request[field] !== undefined)) {
      throw new TicketingError('status-state-fixed');
    }
    if (request.isDefault === true && (request.systemState ?? status.systemState) !== 'open') {
      throw new TicketingError('default-must-be-open');
    }
    if (status.isDefault && request.systemState !== undefined && request.systemState !== 'open') {
      throw new TicketingError('default-must-be-open');
    }
    if (request.name !== undefined && request.name.toLowerCase() !== status.name.toLowerCase()) {
      this.#assertStatusNameFree(request.name, statusId);
    }

    const updated: TicketStatus = {
      ...status,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
      ...(request.systemState === undefined ? {} : { systemState: request.systemState }),
      ...(request.pausesSla === undefined ? {} : { pausesSla: request.pausesSla }),
      ...(request.awaitingCustomer === undefined
        ? {}
        : { awaitingCustomer: request.awaitingCustomer }),
      ...(request.color === undefined ? {} : { color: request.color }),
      ...(request.isDefault === undefined ? {} : { isDefault: request.isDefault }),
    };

    this.#statuses = this.#statuses.map((row) => {
      if (row.id === statusId) {
        return updated;
      }
      return request.isDefault === true ? { ...row, isDefault: false } : row;
    });

    return updated;
  }

  async statusUsage(_brandId: string, statusId: string): Promise<TicketStatusUsage> {
    const status = this.#requireStatus(statusId);
    const fallback = this.#defaultStatus();

    return {
      statusId: status.id,
      ticketCount: this.#ticketsByStatus[status.id] ?? 0,
      fallbackStatusId: fallback.id,
      fallbackName: fallback.name,
    };
  }

  async deleteStatus(_brandId: string, statusId: string): Promise<void> {
    const status = this.#requireStatus(statusId);
    if (status.isSystem) {
      throw new TicketingError('status-is-system');
    }
    if (status.isDefault) {
      throw new TicketingError('status-is-default');
    }

    const fallback = this.#defaultStatus();
    this.#ticketsByStatus[fallback.id] =
      (this.#ticketsByStatus[fallback.id] ?? 0) + (this.#ticketsByStatus[statusId] ?? 0);
    delete this.#ticketsByStatus[statusId];
    this.#statuses = this.#statuses.filter((row) => row.id !== statusId);
  }

  async reorderStatuses(brandId: string, statusIds: string[]): Promise<TicketStatusList> {
    this.#statuses = this.#statuses.map((row) => ({
      ...row,
      sortOrder: statusIds.indexOf(row.id) === -1 ? row.sortOrder : statusIds.indexOf(row.id),
    }));

    return this.statuses(brandId);
  }

  async updateReplyBehaviour(
    _brandId: string,
    request: ReplyBehaviourUpdateRequest,
  ): Promise<BrandSettings> {
    this.#brand = {
      ...this.#brand,
      settings: {
        ...this.#brand.settings,
        ...(request.autoAwaitOnAgentReply === undefined
          ? {}
          : { autoAwaitOnAgentReply: request.autoAwaitOnAgentReply }),
        ...(request.reopenPolicy === undefined ? {} : { reopenPolicy: request.reopenPolicy }),
      },
    };

    return this.#brand.settings;
  }

  // ---------------------------------------------------------------- M1-12

  async updateFeedback(
    _brandId: string,
    request: FeedbackSettingsUpdateRequest,
  ): Promise<BrandSettings> {
    const changes = Object.fromEntries(
      Object.entries(request).filter(([, value]) => value !== undefined),
    );
    this.#brand = { ...this.#brand, settings: { ...this.#brand.settings, ...changes } };

    return this.#brand.settings;
  }

  // ---------------------------------------------------------------- M1-06

  async tags(_brandId: string): Promise<TagList> {
    return { tags: [...this.#tags].sort(byOrder) };
  }

  async createTag(_brandId: string, request: TagCreateRequest): Promise<TagSummary> {
    this.#assertTagNameFree(request.name);

    const created: TagSummary = {
      id: newId('11'),
      name: request.name,
      nameAr: request.nameAr ?? null,
      color: request.color,
      sortOrder: this.#tags.length,
      ticketCount: 0,
    };
    this.#tags.push(created);

    return created;
  }

  async updateTag(_brandId: string, tagId: string, request: TagUpdateRequest): Promise<TagSummary> {
    const tag = this.#requireTag(tagId);
    if (request.name !== undefined && request.name.toLowerCase() !== tag.name.toLowerCase()) {
      this.#assertTagNameFree(request.name, tagId);
    }

    const updated: TagSummary = {
      ...tag,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
      ...(request.color === undefined ? {} : { color: request.color }),
    };
    this.#tags = this.#tags.map((row) => (row.id === tagId ? updated : row));

    return updated;
  }

  async reorderTags(brandId: string, tagIds: string[]): Promise<TagList> {
    // The api refuses anything but a permutation of the whole list rather than
    // half-reordering a stale client's view; so does this.
    const unique = new Set(tagIds);
    if (
      unique.size !== tagIds.length ||
      unique.size !== this.#tags.length ||
      this.#tags.some((row) => !unique.has(row.id))
    ) {
      throw new AuthError('unavailable');
    }

    this.#tags = this.#tags.map((row) => ({ ...row, sortOrder: tagIds.indexOf(row.id) }));

    return this.tags(brandId);
  }

  async tagUsage(_brandId: string, tagId: string): Promise<TagUsage> {
    return { tagId, ticketCount: this.#requireTag(tagId).ticketCount };
  }

  async deleteTag(_brandId: string, tagId: string): Promise<void> {
    this.#requireTag(tagId);
    this.#tags = this.#tags.filter((row) => row.id !== tagId);
    // A template's defaults lose a tag the brand no longer has, exactly as the
    // api filters them on the way out.
    this.#templates = this.#templates.map((template) => ({
      ...template,
      defaultTagIds: template.defaultTagIds.filter((id) => id !== tagId),
    }));
  }

  async customFields(_brandId: string, target?: CustomFieldTarget): Promise<CustomFieldDefList> {
    const fields = [...this.#fields]
      .filter((field) => target === undefined || field.target === target)
      .sort((a, b) => a.target.localeCompare(b.target) || a.sortOrder - b.sortOrder);

    return { fields };
  }

  async createCustomField(
    _brandId: string,
    request: CustomFieldCreateRequest,
  ): Promise<CustomFieldDef> {
    if (
      this.#fields.some((field) => field.target === request.target && field.key === request.key)
    ) {
      throw new TicketingError('name-taken');
    }

    const created: CustomFieldDef = {
      id: newId('22'),
      target: request.target,
      key: request.key,
      label: request.label,
      labelAr: request.labelAr ?? null,
      type: request.type,
      options: [...request.options],
      required: request.required,
      agentVisible: request.agentVisible,
      sortOrder: this.#fields.filter((field) => field.target === request.target).length,
    };
    this.#fields.push(created);

    return created;
  }

  async updateCustomField(
    _brandId: string,
    fieldId: string,
    request: CustomFieldUpdateRequest,
  ): Promise<CustomFieldDef> {
    const field = this.#requireField(fieldId);
    const used = this.#fieldUsage(field);

    if (request.type !== undefined && request.type !== field.type && used.rows > 0) {
      throw new TicketingError('field-in-use');
    }

    if (request.options !== undefined && isChoiceField(field.type)) {
      const kept = new Set(request.options);
      const inUse = field.options.filter(
        (option) => !kept.has(option) && (used.optionRows[option] ?? 0) > 0,
      );
      if (inUse.length > 0 && !request.force) {
        throw new TicketingError('option-in-use');
      }
    }

    const updated: CustomFieldDef = {
      ...field,
      ...(request.label === undefined ? {} : { label: request.label }),
      ...(request.labelAr === undefined ? {} : { labelAr: request.labelAr }),
      ...(request.type === undefined ? {} : { type: request.type }),
      ...(request.options === undefined ? {} : { options: [...request.options] }),
      ...(request.required === undefined ? {} : { required: request.required }),
      ...(request.agentVisible === undefined ? {} : { agentVisible: request.agentVisible }),
    };
    this.#fields = this.#fields.map((row) => (row.id === fieldId ? updated : row));

    return updated;
  }

  async reorderCustomFields(
    brandId: string,
    target: CustomFieldTarget,
    fieldIds: string[],
  ): Promise<CustomFieldDefList> {
    const ofTarget = this.#fields.filter((field) => field.target === target);
    const unique = new Set(fieldIds);
    if (
      unique.size !== fieldIds.length ||
      unique.size !== ofTarget.length ||
      ofTarget.some((field) => !unique.has(field.id))
    ) {
      throw new AuthError('unavailable');
    }

    this.#fields = this.#fields.map((field) =>
      field.target === target ? { ...field, sortOrder: fieldIds.indexOf(field.id) } : field,
    );

    return this.customFields(brandId);
  }

  async customFieldUsage(_brandId: string, fieldId: string): Promise<CustomFieldUsage> {
    const field = this.#requireField(fieldId);
    const usage = this.#fieldUsage(field);

    return { fieldId, rows: usage.rows, optionRows: usage.optionRows };
  }

  async deleteCustomField(_brandId: string, fieldId: string): Promise<void> {
    this.#requireField(fieldId);
    this.#fields = this.#fields.filter((row) => row.id !== fieldId);
  }

  async ticketTemplates(_brandId: string): Promise<TicketTemplateList> {
    return { templates: [...this.#templates].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async createTicketTemplate(
    _brandId: string,
    request: TicketTemplateCreateRequest,
  ): Promise<TicketTemplate> {
    this.#assertTemplateNameFree(request.name);

    const created: TicketTemplate = {
      id: newId('33'),
      name: request.name,
      departmentId: request.departmentId ?? null,
      priority: request.priority,
      subject: request.subject,
      bodyText: request.bodyText,
      defaultTagIds: [...request.defaultTagIds],
      customDefaults: { ...request.customDefaults },
      usageCount: 0,
    };
    this.#templates.push(created);

    return created;
  }

  async updateTicketTemplate(
    _brandId: string,
    templateId: string,
    request: TicketTemplateUpdateRequest,
  ): Promise<TicketTemplate> {
    const template = this.#requireTemplate(templateId);
    if (request.name !== undefined && request.name.toLowerCase() !== template.name.toLowerCase()) {
      this.#assertTemplateNameFree(request.name, templateId);
    }

    const updated: TicketTemplate = {
      ...template,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.departmentId === undefined ? {} : { departmentId: request.departmentId }),
      ...(request.priority === undefined ? {} : { priority: request.priority }),
      ...(request.subject === undefined ? {} : { subject: request.subject }),
      ...(request.bodyText === undefined ? {} : { bodyText: request.bodyText }),
      ...(request.defaultTagIds === undefined ? {} : { defaultTagIds: [...request.defaultTagIds] }),
      ...(request.customDefaults === undefined
        ? {}
        : { customDefaults: { ...request.customDefaults } }),
    };
    this.#templates = this.#templates.map((row) => (row.id === templateId ? updated : row));

    return updated;
  }

  async deleteTicketTemplate(_brandId: string, templateId: string): Promise<void> {
    this.#requireTemplate(templateId);
    this.#templates = this.#templates.filter((row) => row.id !== templateId);
  }

  /**
   * The same rule the api's renderer follows: a name it knows is replaced, one
   * it does not is left spelled out and reported, so the editor's preview
   * behaves here as it does against a real install.
   */
  async previewTicketTemplate(
    _brandId: string,
    templateId: string,
  ): Promise<TicketTemplatePreview> {
    const template = this.#requireTemplate(templateId);
    const subject = renderMock(template.subject);
    const body = renderMock(template.bodyText);

    return {
      subject: subject.text,
      bodyText: body.text,
      unknownPlaceholders: [...new Set([...subject.unknown, ...body.unknown])],
    };
  }

  // ---------------------------------------------------------------- M1-11

  async blockedSenders(_brandId: string): Promise<BlockedSenderList> {
    return { senders: this.#blockList.list() };
  }

  async blockSender(_brandId: string, request: BlockedSenderCreateRequest): Promise<BlockedSender> {
    return this.#blockList.block(request, { idempotent: false });
  }

  async unblockSender(_brandId: string, blockedSenderId: string): Promise<void> {
    this.#blockList.unblock(blockedSenderId);
  }

  async updateSpamSettings(
    _brandId: string,
    request: SpamSettingsUpdateRequest,
  ): Promise<BrandSettings> {
    this.#blockList.offerBlockSender = request.offerBlockSender;
    this.#brand = {
      ...this.#brand,
      settings: { ...this.#brand.settings, offerBlockSender: request.offerBlockSender },
    };

    return this.#brand.settings;
  }

  // ------------------------------------------------------------------

  // ---------------------------------------------------------------- M1-07

  async assignment(_brandId: string): Promise<DepartmentAssignmentList> {
    return {
      departments: this.#sorted().map((department) => this.#assignmentOf(department)),
    };
  }

  async updateAssignment(
    _brandId: string,
    departmentId: string,
    request: DepartmentAssignmentUpdateRequest,
  ): Promise<DepartmentAssignment> {
    const department = this.#require(departmentId);
    const current = this.#settingsOf(departmentId);
    this.#assignment[departmentId] = {
      mode: request.mode ?? current.mode,
      loadCap: request.loadCap === undefined ? current.loadCap : request.loadCap,
      autoUnassignOffline: request.autoUnassignOffline ?? current.autoUnassignOffline,
      autoUnassignAfterMinutes:
        request.autoUnassignAfterMinutes ?? current.autoUnassignAfterMinutes,
      onUnassign: request.onUnassign ?? current.onUnassign,
    };

    return this.#assignmentOf(department);
  }

  async assignmentAgents(_brandId: string, departmentId: string): Promise<AssignmentAgentList> {
    this.#require(departmentId);

    return {
      departmentId,
      loadCap: this.#settingsOf(departmentId).loadCap,
      agents: MOCK_ASSIGNEES.filter((assignee) => worksIn(assignee, departmentId)).map((assignee) =>
        this.#agentOf(departmentId, assignee.userId),
      ),
    };
  }

  async updateAssignmentAgent(
    _brandId: string,
    departmentId: string,
    userId: string,
    request: AssignmentAgentUpdateRequest,
  ): Promise<AssignmentAgent> {
    this.#require(departmentId);
    const assignee = MOCK_ASSIGNEES.find((row) => row.userId === userId);
    if (assignee === undefined || !worksIn(assignee, departmentId)) {
      throw new TicketingError('not-eligible');
    }

    const key = `${departmentId}:${userId}`;
    if (request.inRotation !== undefined) {
      this.#rotation.set(key, request.inRotation);
    }
    if (request.skillTagIds !== undefined) {
      this.#skills.set(key, [...new Set(request.skillTagIds)]);
    }

    return this.#agentOf(departmentId, userId);
  }

  #settingsOf(departmentId: string): MockDepartmentAssignment {
    return (
      this.#assignment[departmentId] ?? {
        mode: 'manual',
        loadCap: null,
        autoUnassignOffline: false,
        autoUnassignAfterMinutes: 15,
        onUnassign: 'leave_unassigned',
      }
    );
  }

  #inRotation(departmentId: string, userId: string): boolean {
    const role = MOCK_ASSIGNEES.find((row) => row.userId === userId)?.role;

    return this.#rotation.get(`${departmentId}:${userId}`) ?? role === 'agent';
  }

  #assignmentOf(department: DepartmentSummary): DepartmentAssignment {
    const settings = this.#settingsOf(department.id);
    const rotating = MOCK_ASSIGNEES.filter(
      (assignee) =>
        worksIn(assignee, department.id) && this.#inRotation(department.id, assignee.userId),
    );

    return {
      departmentId: department.id,
      name: department.name,
      nameAr: department.nameAr,
      mode: settings.mode,
      loadCap: settings.loadCap,
      autoUnassignOffline: settings.autoUnassignOffline,
      autoUnassignAfterMinutes: settings.autoUnassignAfterMinutes,
      onUnassign: settings.onUnassign,
      agentsInRotation: rotating.length,
      agentsOnline: rotating.filter((assignee) => assignee.presence === 'online').length,
    };
  }

  #agentOf(departmentId: string, userId: string): AssignmentAgent {
    const assignee = MOCK_ASSIGNEES.find((row) => row.userId === userId);
    /* c8 ignore next 3 -- every caller has just found this person. */
    if (assignee === undefined) {
      throw new TicketingError('not-eligible');
    }
    const skillIds = this.#skills.get(`${departmentId}:${userId}`) ?? [];

    return {
      userId,
      name: assignee.name,
      role: assignee.role,
      presence: assignee.presence,
      openCount: assignee.open[departmentId] ?? 0,
      inRotation: this.#inRotation(departmentId, userId),
      skills: this.#tags
        .filter((tag) => skillIds.includes(tag.id))
        .map((tag) => ({ id: tag.id, name: tag.name, nameAr: tag.nameAr, color: tag.color })),
      // The session is Lina, an Admin, who may change every row.
      editable: true,
    };
  }

  #sortedStatuses(): TicketStatus[] {
    return [...this.#statuses].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
  }

  #requireStatus(statusId: string): TicketStatus {
    const status = this.#statuses.find((row) => row.id === statusId);
    if (status === undefined) {
      throw new AuthError('unavailable');
    }

    return status;
  }

  #defaultStatus(): TicketStatus {
    const status = this.#statuses.find((row) => row.isDefault);
    /* c8 ignore next 3 -- the seed always carries one, and nothing here clears the last. */
    if (status === undefined) {
      throw new AuthError('unavailable');
    }

    return status;
  }

  #assertStatusNameFree(name: string, exceptId?: string): void {
    if (
      this.#statuses.some(
        (row) => row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new TicketingError('name-taken');
    }
  }

  #sorted(): DepartmentSummary[] {
    return [...this.#departments].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
  }

  #teamsOf(departmentId: string): Team[] {
    return this.#teams
      .filter((team) => team.departmentId === departmentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  #withCounts(department: DepartmentSummary): DepartmentSummary {
    const teams = this.#teamsOf(department.id);

    return {
      ...department,
      defaultTeamName: teams.find((team) => team.id === department.defaultTeamId)?.name ?? null,
      teamCount: teams.length,
      memberCount: new Set(teams.flatMap((team) => team.members.map((member) => member.userId)))
        .size,
    };
  }

  /**
   * The api answers 404 for a department this brand does not have — the same
   * answer for "no such id" and "not yours" — and the transport turns a body
   * with no refusal code into `AuthError('unavailable')`. The fixture has to
   * produce that, or a screen test would be written against a refusal the real
   * service never sends.
   */
  #require(departmentId: string): DepartmentSummary {
    const department = this.#departments.find((row) => row.id === departmentId);
    if (department === undefined) {
      throw new AuthError('unavailable');
    }

    return department;
  }

  #requireTeam(departmentId: string, teamId: string): Team {
    this.#require(departmentId);
    const team = this.#teams.find((row) => row.id === teamId && row.departmentId === departmentId);
    if (team === undefined) {
      throw new AuthError('unavailable');
    }

    return team;
  }

  #assertNameFree(name: string, exceptId?: string): void {
    if (
      this.#departments.some(
        (row) => row.name.toLowerCase() === name.toLowerCase() && row.id !== exceptId,
      )
    ) {
      throw new TicketingError('name-taken');
    }
  }

  #requireTag(tagId: string): TagSummary {
    const tag = this.#tags.find((row) => row.id === tagId);
    if (tag === undefined) {
      throw new AuthError('unavailable');
    }

    return tag;
  }

  #assertTagNameFree(name: string, exceptId?: string): void {
    if (
      this.#tags.some((row) => row.name.toLowerCase() === name.toLowerCase() && row.id !== exceptId)
    ) {
      throw new TicketingError('name-taken');
    }
  }

  #requireField(fieldId: string): CustomFieldDef {
    const field = this.#fields.find((row) => row.id === fieldId);
    if (field === undefined) {
      throw new AuthError('unavailable');
    }

    return field;
  }

  /**
   * Stable, made-up usage, so the two refusals only a populated install
   * produces have a shape here too: the seeded `tier` field is on rows and its
   * `gold` option is in use, and anything a test creates is on none.
   */
  #fieldUsage(field: CustomFieldDef): { rows: number; optionRows: Record<string, number> } {
    return SEEDED_FIELD_USAGE[field.key] ?? { rows: 0, optionRows: {} };
  }

  #requireTemplate(templateId: string): TicketTemplate {
    const template = this.#templates.find((row) => row.id === templateId);
    if (template === undefined) {
      throw new AuthError('unavailable');
    }

    return template;
  }

  #assertTemplateNameFree(name: string, exceptId?: string): void {
    if (
      this.#templates.some(
        (row) => row.name.toLowerCase() === name.toLowerCase() && row.id !== exceptId,
      )
    ) {
      throw new TicketingError('name-taken');
    }
  }
}
