import type {
  Brand,
  BrandSettings,
  BrandUpdateRequest,
  DepartmentCreateRequest,
  DepartmentSummary,
  DepartmentSummaryList,
  DepartmentUpdateRequest,
  EligibleMember,
  EligibleMemberList,
  ReplyBehaviourUpdateRequest,
  Team,
  TeamList,
  TicketStatus,
  TicketStatusCreateRequest,
  TicketStatusList,
  TicketStatusUpdateRequest,
  TicketStatusUsage,
} from '@helpdock/schemas';
import { defaultBrandSettings } from '@helpdock/schemas';
import { AuthError } from '../auth/api.js';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import { type TicketingApi, TicketingError } from './api.js';

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
    sortOrder: 6,
    color: 'warning',
  },
];

/** Which fields a seeded row refuses, mirroring `status-rules.ts`. */
const FIXED_ON_SYSTEM_ROWS = ['systemState', 'pausesSla', 'awaitingCustomer'] as const;

let nextId = 1;

const newId = (kind: string): string => {
  nextId += 1;

  return `0192c3f0-1a2b-7c3d-8e4f-${kind}${String(nextId).padStart(10, '0')}`.slice(0, 36);
};

export class MockTicketingApi implements TicketingApi {
  #departments = seedDepartments();
  #teams: Team[] = [];
  #brand = seedBrand();
  #statuses = seedStatuses();
  /**
   * How many tickets sit in each status, so the delete confirmation has a
   * number to print. The real count comes from a `COUNT(*)` the api runs.
   */
  #ticketsByStatus: Record<string, number> = {
    '0192c3f0-1a2b-7c3d-8e4f-0000000000e7': 12,
  };

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

    return this.#brand;
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

  // ------------------------------------------------------------------

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
}
