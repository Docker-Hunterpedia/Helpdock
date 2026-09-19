import type { DbTransaction, Department, Team } from '@helpdock/db';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DepartmentActor } from './department-scope.js';
import type { DepartmentsRepository } from './departments.repository.js';
import { type DepartmentContext, DepartmentsService } from './departments.service.js';
import { TicketingFailure } from './ticketing-failure.js';

/**
 * The decisions the service makes before it writes anything: who may act, what
 * a name may be, which team may become a default, and whether a reorder
 * describes the list it claims to.
 *
 * The repository is an in-memory stand-in rather than a mock per call, because
 * half of these rules are about what the *next* read sees — renaming a
 * department and then being refused the same name is the point — and a stub
 * that only records calls cannot show that.
 */

const BRAND = '0199f4b2-6a91-7c27-9a1f-00000000000f';
const BILLING = '0199f4b2-6a91-7c27-9a1f-0000000000a1';
const TECHNICAL = '0199f4b2-6a91-7c27-9a1f-0000000000a2';
const FRONT_LINE = '0199f4b2-6a91-7c27-9a1f-0000000000c1';
const ADMIN = '0199f4b2-6a91-7c27-9a1f-0000000000b1';
const AGENT = '0199f4b2-6a91-7c27-9a1f-0000000000b2';
const OUTSIDER = '0199f4b2-6a91-7c27-9a1f-0000000000b3';

const department = (id: string, name: string, sortOrder: number): Department => ({
  id,
  brandId: BRAND,
  name,
  nameAr: null,
  defaultTeamId: null,
  sortOrder,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const team = (id: string, departmentId: string, name: string): Team => ({
  id,
  brandId: BRAND,
  departmentId,
  name,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

interface Member {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: 'admin' | 'team_leader' | 'agent' | 'viewer';
  readonly departmentIds: string[] | null;
}

class FakeRepository {
  departments: Department[] = [];
  teams: Team[] = [];
  memberships: { teamId: string; userId: string }[] = [];
  roles: Member[] = [];

  list() {
    return Promise.resolve(
      [...this.departments]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((row) => ({
          department: row,
          defaultTeamName: this.teams.find((entry) => entry.id === row.defaultTeamId)?.name ?? null,
          teamCount: this.teams.filter((entry) => entry.departmentId === row.id).length,
          memberCount: new Set(
            this.memberships
              .filter((entry) =>
                this.teams.some(
                  (candidate) => candidate.id === entry.teamId && candidate.departmentId === row.id,
                ),
              )
              .map((entry) => entry.userId),
          ).size,
        })),
    );
  }

  find(_tx: DbTransaction, id: string) {
    return Promise.resolve(this.departments.find((row) => row.id === id));
  }

  countDepartments() {
    return Promise.resolve(this.departments.length);
  }

  nextSortOrder() {
    return Promise.resolve(this.departments.length);
  }

  create(
    _tx: DbTransaction,
    values: { brandId: string; name: string; nameAr: string | null; sortOrder: number },
  ) {
    const row: Department = {
      ...department(`created-${this.departments.length}`, values.name, values.sortOrder),
      nameAr: values.nameAr,
    };
    this.departments.push(row);
    return Promise.resolve(row);
  }

  update(_tx: DbTransaction, id: string, changes: Partial<Department>) {
    this.departments = this.departments.map((row) =>
      row.id === id ? { ...row, ...changes } : row,
    );
    return Promise.resolve();
  }

  delete(_tx: DbTransaction, id: string) {
    this.departments = this.departments.filter((row) => row.id !== id);
    return Promise.resolve();
  }

  reorder(_tx: DbTransaction, ids: readonly string[]) {
    this.departments = this.departments.map((row) => {
      const position = ids.indexOf(row.id);
      return position === -1 ? row : { ...row, sortOrder: position };
    });
    return Promise.resolve();
  }

  nameTaken(_tx: DbTransaction, name: string, { exceptId }: { exceptId?: string } = {}) {
    return Promise.resolve(
      this.departments.some(
        (row) => row.name.toLowerCase() === name.toLowerCase() && row.id !== exceptId,
      ),
    );
  }

  teamsOf(_tx: DbTransaction, departmentId: string) {
    return Promise.resolve(
      this.teams
        .filter((row) => row.departmentId === departmentId)
        .map((row) => ({
          team: row,
          members: this.memberships
            .filter((entry) => entry.teamId === row.id)
            .map((entry) => {
              const person = this.roles.find((candidate) => candidate.id === entry.userId);
              return {
                id: entry.userId,
                name: person?.name ?? '',
                role: person?.role ?? ('agent' as const),
              };
            }),
        })),
    );
  }

  findTeam(_tx: DbTransaction, where: { departmentId: string; teamId: string }) {
    return Promise.resolve(
      this.teams.find((row) => row.id === where.teamId && row.departmentId === where.departmentId),
    );
  }

  nextTeamSortOrder() {
    return Promise.resolve(0);
  }

  createTeam(
    _tx: DbTransaction,
    values: { brandId: string; departmentId: string; name: string; sortOrder: number },
  ) {
    const row = team(`team-${this.teams.length}`, values.departmentId, values.name);
    this.teams.push(row);
    return Promise.resolve(row);
  }

  renameTeam(_tx: DbTransaction, teamId: string, name: string) {
    this.teams = this.teams.map((row) => (row.id === teamId ? { ...row, name } : row));
    return Promise.resolve();
  }

  deleteTeam(_tx: DbTransaction, teamId: string) {
    this.teams = this.teams.filter((row) => row.id !== teamId);
    return Promise.resolve();
  }

  teamNameTaken(
    _tx: DbTransaction,
    departmentId: string,
    name: string,
    { exceptId }: { exceptId?: string } = {},
  ) {
    return Promise.resolve(
      this.teams.some(
        (row) =>
          row.departmentId === departmentId &&
          row.name.toLowerCase() === name.toLowerCase() &&
          row.id !== exceptId,
      ),
    );
  }

  brandRoles() {
    return Promise.resolve(this.roles);
  }

  brandRoleOf(_tx: DbTransaction, userId: string) {
    return Promise.resolve(this.roles.find((row) => row.id === userId));
  }

  addMember(_tx: DbTransaction, values: { teamId: string; userId: string }) {
    if (
      !this.memberships.some(
        (entry) => entry.teamId === values.teamId && entry.userId === values.userId,
      )
    ) {
      this.memberships.push({ teamId: values.teamId, userId: values.userId });
    }
    return Promise.resolve();
  }

  removeMember(_tx: DbTransaction, where: { teamId: string; userId: string }) {
    this.memberships = this.memberships.filter(
      (entry) => !(entry.teamId === where.teamId && entry.userId === where.userId),
    );
    return Promise.resolve();
  }
}

const auditRows: { action: string; targetId: string }[] = [];

const tx = {
  insert: () => ({
    values: (row: { action: string; targetId: string }) => {
      auditRows.push(row);
      return Promise.resolve();
    },
  }),
} as unknown as DbTransaction;

const actor = (
  role: DepartmentActor['role'],
  departmentIds: DepartmentActor['departmentIds'] = 'all',
): DepartmentActor => ({ userId: ADMIN, role, departmentIds });

let repository: FakeRepository;
let service: DepartmentsService;

const contextFor = (which: DepartmentActor): DepartmentContext => ({
  tx,
  brandId: BRAND,
  actor: which,
});

const refusalOf = async (promise: Promise<unknown>): Promise<TicketingFailure> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(TicketingFailure);
  return error as TicketingFailure;
};

beforeEach(() => {
  auditRows.length = 0;
  repository = new FakeRepository();
  repository.departments = [
    department(BILLING, 'Billing', 0),
    department(TECHNICAL, 'Technical', 1),
  ];
  repository.teams = [team(FRONT_LINE, BILLING, 'Front line')];
  repository.roles = [
    { id: ADMIN, name: 'Admin', email: 'admin@example.com', role: 'admin', departmentIds: null },
    {
      id: AGENT,
      name: 'Agent',
      email: 'agent@example.com',
      role: 'agent',
      departmentIds: [BILLING],
    },
    {
      id: OUTSIDER,
      name: 'Outsider',
      email: 'outsider@example.com',
      role: 'agent',
      departmentIds: [TECHNICAL],
    },
  ];
  service = new DepartmentsService(repository as unknown as DepartmentsRepository);
});

describe('list', () => {
  it('counts the teams and the distinct people in them', async () => {
    repository.memberships = [{ teamId: FRONT_LINE, userId: AGENT }];

    const { departments } = await service.list(tx);

    expect(departments[0]).toMatchObject({ name: 'Billing', teamCount: 1, memberCount: 1 });
    expect(departments[1]).toMatchObject({ name: 'Technical', teamCount: 0, memberCount: 0 });
  });
});

describe('create', () => {
  it('refuses a team leader: which departments a brand has is the brand', async () => {
    const failure = await refusalOf(
      service.create(contextFor(actor('team_leader', 'all')), { name: 'Sales' }),
    );

    expect(failure.reason).toBe('out-of-scope');
    expect(repository.departments).toHaveLength(2);
  });

  it('refuses a name another department already carries, whatever its case', async () => {
    const failure = await refusalOf(
      service.create(contextFor(actor('admin')), { name: 'billing' }),
    );

    expect(failure.reason).toBe('name-taken');
  });

  it('adds one at the end of the list and audits it', async () => {
    const created = await service.create(contextFor(actor('admin')), { name: 'Sales' });

    expect(created).toMatchObject({ name: 'Sales', sortOrder: 2, teamCount: 0, memberCount: 0 });
    expect(auditRows).toEqual([expect.objectContaining({ action: 'department.created' })]);
  });
});

describe('update', () => {
  it('lets a team leader rename a department they lead', async () => {
    const updated = await service.update(contextFor(actor('team_leader', [BILLING])), BILLING, {
      name: 'Billing and payments',
    });

    expect(updated.name).toBe('Billing and payments');
    expect(auditRows).toEqual([expect.objectContaining({ action: 'department.updated' })]);
  });

  it('refuses a team leader outside their scope', async () => {
    const failure = await refusalOf(
      service.update(contextFor(actor('team_leader', [BILLING])), TECHNICAL, { name: 'Tech' }),
    );

    expect(failure.reason).toBe('out-of-scope');
  });

  it('allows a rename that only changes the case of its own name', async () => {
    const updated = await service.update(contextFor(actor('admin')), BILLING, { name: 'BILLING' });

    expect(updated.name).toBe('BILLING');
  });

  it('refuses a rename onto another department’s name', async () => {
    const failure = await refusalOf(
      service.update(contextFor(actor('admin')), BILLING, { name: 'Technical' }),
    );

    expect(failure.reason).toBe('name-taken');
  });

  it('refuses a default team that belongs to another department', async () => {
    await expect(
      service.update(contextFor(actor('admin')), TECHNICAL, { defaultTeamId: FRONT_LINE }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets the default team be cleared', async () => {
    await service.update(contextFor(actor('admin')), BILLING, { defaultTeamId: FRONT_LINE });
    const cleared = await service.update(contextFor(actor('admin')), BILLING, {
      defaultTeamId: null,
    });

    expect(cleared.defaultTeamId).toBeNull();
  });

  it('answers 404 for a department this brand does not have', async () => {
    await expect(
      service.update(contextFor(actor('admin')), 'not-here', { name: 'Nope' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('remove', () => {
  it('refuses a team leader', async () => {
    const failure = await refusalOf(
      service.remove(contextFor(actor('team_leader', [BILLING])), BILLING),
    );

    expect(failure.reason).toBe('out-of-scope');
  });

  it('refuses the brand’s last department', async () => {
    repository.departments = [department(BILLING, 'Billing', 0)];

    const failure = await refusalOf(service.remove(contextFor(actor('admin')), BILLING));

    expect(failure.reason).toBe('last-department');
    expect(repository.departments).toHaveLength(1);
  });

  it('deletes one of several and audits it', async () => {
    await service.remove(contextFor(actor('admin')), TECHNICAL);

    expect(repository.departments.map((row) => row.name)).toEqual(['Billing']);
    expect(auditRows).toEqual([expect.objectContaining({ action: 'department.deleted' })]);
  });
});

describe('reorder', () => {
  it('writes dense positions in the order it was given', async () => {
    const { departments } = await service.reorder(contextFor(actor('admin')), {
      departmentIds: [TECHNICAL, BILLING],
    });

    expect(departments.map((row) => [row.name, row.sortOrder])).toEqual([
      ['Technical', 0],
      ['Billing', 1],
    ]);
  });

  it('refuses a partial order rather than reordering half the list', async () => {
    await expect(
      service.reorder(contextFor(actor('admin')), { departmentIds: [BILLING] }),
    ).rejects.toThrow(/every department/);
  });

  it('refuses an order that names a department twice', async () => {
    await expect(
      service.reorder(contextFor(actor('admin')), { departmentIds: [BILLING, BILLING] }),
    ).rejects.toThrow(/twice/);
  });

  it('refuses an order naming a department the brand does not have', async () => {
    // The stale-client case: the right number of ids, one of them gone.
    await expect(
      service.reorder(contextFor(actor('admin')), {
        departmentIds: [BILLING, '0199f4b2-6a91-7c27-9a1f-0000000000ff'],
      }),
    ).rejects.toThrow(/every department/);
  });

  it('refuses a team leader', async () => {
    const failure = await refusalOf(
      service.reorder(contextFor(actor('team_leader', 'all')), {
        departmentIds: [TECHNICAL, BILLING],
      }),
    );

    expect(failure.reason).toBe('out-of-scope');
  });
});

describe('teams', () => {
  it('refuses a team leader creating a team outside their scope', async () => {
    const failure = await refusalOf(
      service.createTeam(contextFor(actor('team_leader', [BILLING])), TECHNICAL, {
        name: 'Tier 2',
      }),
    );

    expect(failure.reason).toBe('out-of-scope');
  });

  it('lets a team leader add a team to a department they lead', async () => {
    const { teams } = await service.createTeam(
      contextFor(actor('team_leader', [BILLING])),
      BILLING,
      { name: 'Tier 2' },
    );

    expect(teams.map((row) => row.name)).toEqual(['Front line', 'Tier 2']);
    expect(auditRows).toEqual([expect.objectContaining({ action: 'team.created' })]);
  });

  it('refuses a second team with the same name in one department', async () => {
    const failure = await refusalOf(
      service.createTeam(contextFor(actor('admin')), BILLING, { name: 'front line' }),
    );

    expect(failure.reason).toBe('name-taken');
  });

  it('allows the same team name in a different department', async () => {
    const { teams } = await service.createTeam(contextFor(actor('admin')), TECHNICAL, {
      name: 'Front line',
    });

    expect(teams.map((row) => row.name)).toEqual(['Front line']);
  });

  it('renames a team and audits it', async () => {
    const { teams } = await service.renameTeam(
      contextFor(actor('admin')),
      { departmentId: BILLING, teamId: FRONT_LINE },
      { name: 'Tier 1' },
    );

    expect(teams.map((row) => row.name)).toEqual(['Tier 1']);
    expect(auditRows).toEqual([expect.objectContaining({ action: 'team.updated' })]);
  });

  it('lets a team keep its own name in another case', async () => {
    const { teams } = await service.renameTeam(
      contextFor(actor('admin')),
      { departmentId: BILLING, teamId: FRONT_LINE },
      { name: 'FRONT LINE' },
    );

    expect(teams.map((row) => row.name)).toEqual(['FRONT LINE']);
  });

  it('refuses a rename onto a sibling’s name', async () => {
    await service.createTeam(contextFor(actor('admin')), BILLING, { name: 'Tier 2' });
    const [, tier2] = repository.teams;

    const failure = await refusalOf(
      service.renameTeam(
        contextFor(actor('admin')),
        { departmentId: BILLING, teamId: tier2?.id ?? '' },
        { name: 'Front line' },
      ),
    );

    expect(failure.reason).toBe('name-taken');
  });

  it('refuses a team leader renaming a team outside their scope', async () => {
    repository.teams.push(team('technical-team', TECHNICAL, 'Tier 1'));

    const failure = await refusalOf(
      service.renameTeam(
        contextFor(actor('team_leader', [BILLING])),
        { departmentId: TECHNICAL, teamId: 'technical-team' },
        { name: 'Mine now' },
      ),
    );

    expect(failure.reason).toBe('out-of-scope');
  });

  it('answers 404 for a team that belongs to another department', async () => {
    await expect(
      service.deleteTeam(contextFor(actor('admin')), {
        departmentId: TECHNICAL,
        teamId: FRONT_LINE,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes a team and audits it', async () => {
    const { teams } = await service.deleteTeam(contextFor(actor('admin')), {
      departmentId: BILLING,
      teamId: FRONT_LINE,
    });

    expect(teams).toEqual([]);
    expect(auditRows).toEqual([expect.objectContaining({ action: 'team.deleted' })]);
  });
});

describe('membership', () => {
  it('refuses a team leader the picker of a department they do not lead', async () => {
    const failure = await refusalOf(
      service.eligibleMembers(contextFor(actor('team_leader', [BILLING])), TECHNICAL),
    );

    expect(failure.reason).toBe('out-of-scope');
  });

  it('offers only staff whose scope reaches the department', async () => {
    const { members } = await service.eligibleMembers(contextFor(actor('admin')), BILLING);

    expect(members.map((member) => member.userId)).toEqual([ADMIN, AGENT]);
  });

  it('never lets a team list carry an address', async () => {
    await service.addMember(
      contextFor(actor('admin')),
      { departmentId: BILLING, teamId: FRONT_LINE },
      AGENT,
    );

    const { teams } = await service.teams(tx, BILLING);

    expect(teams[0]?.members[0]).not.toHaveProperty('email');
  });

  it('adds an eligible person and lists them on the team', async () => {
    const { teams } = await service.addMember(
      contextFor(actor('admin')),
      { departmentId: BILLING, teamId: FRONT_LINE },
      AGENT,
    );

    expect(teams[0]?.members.map((member) => member.userId)).toEqual([AGENT]);
    expect(auditRows).toEqual([expect.objectContaining({ action: 'team.member.added' })]);
  });

  it('refuses somebody with no role in this brand at all', async () => {
    const failure = await refusalOf(
      service.addMember(
        contextFor(actor('admin')),
        { departmentId: BILLING, teamId: FRONT_LINE },
        '0199f4b2-6a91-7c27-9a1f-0000000000fe',
      ),
    );

    expect(failure.reason).toBe('not-eligible');
  });

  it('refuses somebody whose departments do not reach this one', async () => {
    const failure = await refusalOf(
      service.addMember(
        contextFor(actor('admin')),
        { departmentId: BILLING, teamId: FRONT_LINE },
        OUTSIDER,
      ),
    );

    expect(failure.reason).toBe('not-eligible');
  });

  it('refuses a team leader adding somebody to a department they do not lead', async () => {
    repository.teams.push(team('technical-team', TECHNICAL, 'Tier 1'));

    const failure = await refusalOf(
      service.addMember(
        contextFor(actor('team_leader', [BILLING])),
        { departmentId: TECHNICAL, teamId: 'technical-team' },
        OUTSIDER,
      ),
    );

    expect(failure.reason).toBe('out-of-scope');
  });

  it('removes somebody and audits it', async () => {
    repository.memberships = [{ teamId: FRONT_LINE, userId: AGENT }];

    const { teams } = await service.removeMember(
      contextFor(actor('admin')),
      { departmentId: BILLING, teamId: FRONT_LINE },
      AGENT,
    );

    expect(teams[0]?.members).toEqual([]);
    expect(auditRows).toEqual([expect.objectContaining({ action: 'team.member.removed' })]);
  });
});
