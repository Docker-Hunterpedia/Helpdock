import type {
  Brand,
  BrandUpdateRequest,
  DepartmentCreateRequest,
  DepartmentSummary,
  DepartmentSummaryList,
  DepartmentUpdateRequest,
  EligibleMember,
  EligibleMemberList,
  Team,
  TeamList,
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

let nextId = 1;

const newId = (kind: string): string => {
  nextId += 1;

  return `0192c3f0-1a2b-7c3d-8e4f-${kind}${String(nextId).padStart(10, '0')}`.slice(0, 36);
};

export class MockTicketingApi implements TicketingApi {
  #departments = seedDepartments();
  #teams: Team[] = [];
  #brand = seedBrand();

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

  // ------------------------------------------------------------------

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
