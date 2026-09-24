import { DEFAULT_CONTENT_POLICY } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { isAuthError } from '../auth/api.js';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import { isTicketingError } from './api.js';
import { MockTicketingApi } from './mock-api.js';

/**
 * The fixture has to produce the same states the real service does, refusals
 * included, or every screen test and every mock browser run would be exercising
 * a service that is nicer than the one an install has.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const firstDepartmentId = (): string => MOCK_DEPARTMENTS[0]?.id ?? '';

const refusalOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  if (!isTicketingError(error)) {
    throw new Error('expected a ticketing refusal');
  }

  return error.reason;
};

describe('departments', () => {
  it('starts as the departments the staff chip picker offers', async () => {
    const api = new MockTicketingApi();

    const { departments } = await api.departments(BRAND);

    expect(departments.map((row) => row.name)).toEqual(MOCK_DEPARTMENTS.map((row) => row.name));
  });

  it('adds one at the end and refuses a name already taken', async () => {
    const api = new MockTicketingApi();

    const created = await api.createDepartment(BRAND, { name: 'Sales' });
    expect(created.sortOrder).toBe(MOCK_DEPARTMENTS.length);

    expect(await refusalOf(api.createDepartment(BRAND, { name: 'sales' }))).toBe('name-taken');
  });

  it('lets a department keep its own name in another case', async () => {
    const api = new MockTicketingApi();

    const renamed = await api.updateDepartment(BRAND, firstDepartmentId(), { name: 'SUPPORT' });

    expect(renamed.name).toBe('SUPPORT');
  });

  it('refuses the last department', async () => {
    const api = new MockTicketingApi();
    const { departments } = await api.departments(BRAND);

    for (const row of departments.slice(1)) {
      await api.deleteDepartment(BRAND, row.id);
    }

    expect(await refusalOf(api.deleteDepartment(BRAND, firstDepartmentId()))).toBe(
      'last-department',
    );
  });

  it('reorders by the list it is given', async () => {
    const api = new MockTicketingApi();
    const before = (await api.departments(BRAND)).departments.map((row) => row.id);

    const { departments } = await api.reorderDepartments(BRAND, [...before].reverse());

    expect(departments.map((row) => row.id)).toEqual([...before].reverse());
  });

  it('refuses a partial order, as the api does, rather than reordering half of it', async () => {
    const api = new MockTicketingApi();

    const error = await api.reorderDepartments(BRAND, [firstDepartmentId()]).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(isAuthError(error)).toBe(true);
  });
});

describe('teams', () => {
  it('creates, counts and refuses a duplicate name inside one department', async () => {
    const api = new MockTicketingApi();
    const departmentId = firstDepartmentId();

    await api.createTeam(BRAND, departmentId, 'Front line');
    expect(await refusalOf(api.createTeam(BRAND, departmentId, 'front line'))).toBe('name-taken');

    const [department] = (await api.departments(BRAND)).departments;
    expect(department?.teamCount).toBe(1);
  });

  it('allows the same name in another department', async () => {
    const api = new MockTicketingApi();
    const [first, second] = (await api.departments(BRAND)).departments;

    await api.createTeam(BRAND, first?.id ?? '', 'Front line');
    const { teams } = await api.createTeam(BRAND, second?.id ?? '', 'Front line');

    expect(teams.map((team) => team.name)).toEqual(['Front line']);
  });

  it('names the default team so the list can print it', async () => {
    const api = new MockTicketingApi();
    const departmentId = firstDepartmentId();
    const { teams } = await api.createTeam(BRAND, departmentId, 'Front line');

    await api.updateDepartment(BRAND, departmentId, { defaultTeamId: teams[0]?.id ?? '' });

    const [department] = (await api.departments(BRAND)).departments;
    expect(department?.defaultTeamName).toBe('Front line');
  });

  it('clears the default team when that team is deleted', async () => {
    const api = new MockTicketingApi();
    const departmentId = firstDepartmentId();
    const { teams } = await api.createTeam(BRAND, departmentId, 'Front line');
    const teamId = teams[0]?.id ?? '';

    await api.updateDepartment(BRAND, departmentId, { defaultTeamId: teamId });
    await api.deleteTeam(BRAND, departmentId, teamId);

    const [department] = (await api.departments(BRAND)).departments;
    expect(department?.defaultTeamId).toBeNull();
  });

  it('renames a team and refuses a sibling’s name', async () => {
    const api = new MockTicketingApi();
    const departmentId = firstDepartmentId();
    await api.createTeam(BRAND, departmentId, 'Front line');
    const { teams } = await api.createTeam(BRAND, departmentId, 'Tier 2');
    const tier2 = teams.find((team) => team.name === 'Tier 2')?.id ?? '';

    expect(await refusalOf(api.renameTeam(BRAND, departmentId, tier2, 'Front line'))).toBe(
      'name-taken',
    );

    const renamed = await api.renameTeam(BRAND, departmentId, tier2, 'Tier two');
    expect(renamed.teams.map((team) => team.name)).toContain('Tier two');
  });
});

describe('members', () => {
  it('adds somebody once and counts them on the department', async () => {
    const api = new MockTicketingApi();
    const departmentId = firstDepartmentId();
    const { teams } = await api.createTeam(BRAND, departmentId, 'Front line');
    const teamId = teams[0]?.id ?? '';
    const { members } = await api.eligibleMembers(BRAND, departmentId);
    const userId = members[0]?.userId ?? '';

    await api.addMember(BRAND, departmentId, teamId, userId);
    const twice = await api.addMember(BRAND, departmentId, teamId, userId);

    expect(twice.teams[0]?.members).toHaveLength(1);
    expect((await api.departments(BRAND)).departments[0]?.memberCount).toBe(1);
  });

  it('refuses somebody the picker never offered', async () => {
    const api = new MockTicketingApi();
    const departmentId = firstDepartmentId();
    const { teams } = await api.createTeam(BRAND, departmentId, 'Front line');

    expect(await refusalOf(api.addMember(BRAND, departmentId, teams[0]?.id ?? '', 'nobody'))).toBe(
      'not-eligible',
    );
  });

  it('removes somebody and leaves the team behind', async () => {
    const api = new MockTicketingApi();
    const departmentId = firstDepartmentId();
    const { teams } = await api.createTeam(BRAND, departmentId, 'Front line');
    const teamId = teams[0]?.id ?? '';
    const userId = (await api.eligibleMembers(BRAND, departmentId)).members[0]?.userId ?? '';

    await api.addMember(BRAND, departmentId, teamId, userId);
    const removed = await api.removeMember(BRAND, departmentId, teamId, userId);

    expect(removed.teams[0]?.members).toEqual([]);
    expect(removed.teams).toHaveLength(1);
  });

  it('answers a department or a team that is not this brand’s the way the api does', async () => {
    const api = new MockTicketingApi();

    // A 404 with no refusal code, which the transport turns into `unavailable`
    // — not a ticketing refusal the screen would word differently.
    for (const call of [
      api.teams(BRAND, 'elsewhere'),
      api.deleteTeam(BRAND, firstDepartmentId(), 'elsewhere'),
    ]) {
      const error = await call.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(isAuthError(error)).toBe(true);
    }
  });
});

describe('the brand', () => {
  it('starts on the DOMAIN-RULES §2.3 defaults and keeps what is sent', async () => {
    const api = new MockTicketingApi();

    expect((await api.brand(BRAND)).settings.reopenPolicy).toEqual({
      kind: 'within_days',
      days: 7,
    });

    const updated = await api.updateBrand(BRAND, {
      name: 'Renamed',
      // Sent whole, as the endpoint requires: a half-sent object would silently
      // reset the key it left out, which is why `contentPolicy` is here too.
      settings: {
        autoAwaitOnAgentReply: false,
        reopenPolicy: { kind: 'never' },
        contentPolicy: DEFAULT_CONTENT_POLICY,
        offerBlockSender: true,
        csatEnabled: true,
        timeTrackingEnabled: false,
        timerStartsWithComposer: false,
      },
    });

    expect(updated).toMatchObject({
      name: 'Renamed',
      prefix: 'HD',
      settings: { autoAwaitOnAgentReply: false },
    });
  });
});

describe('assignment (M1-07)', () => {
  it('lists every department with its settings and rotation counts', async () => {
    const { departments } = await new MockTicketingApi().assignment(BRAND);

    expect(departments.map((row) => row.mode)).toEqual(['round_robin', 'skill_based', 'manual']);
    expect(departments[0]).toMatchObject({ loadCap: 8, agentsInRotation: 3, agentsOnline: 1 });
  });

  it('keeps what is saved, and leaves alone what the request did not name', async () => {
    const api = new MockTicketingApi();
    const saved = await api.updateAssignment(BRAND, firstDepartmentId(), { loadCap: null });

    expect(saved).toMatchObject({ loadCap: null, mode: 'round_robin' });
  });

  it('lists who can work a department, and changes rotation and skills', async () => {
    const api = new MockTicketingApi();
    const { agents } = await api.assignmentAgents(BRAND, firstDepartmentId());
    const sami = agents.find((agent) => agent.name === 'Sami Aziz');
    expect(sami?.inRotation).toBe(true);

    const updated = await api.updateAssignmentAgent(
      BRAND,
      firstDepartmentId(),
      sami?.userId ?? '',
      {
        inRotation: false,
        skillTagIds: ['0192c3f0-1a2b-7c3d-8e4f-000000000102'],
      },
    );
    expect(updated).toMatchObject({ inRotation: false, skills: [{ name: 'VIP' }] });
  });

  it('refuses somebody who cannot work the department', async () => {
    expect(
      await refusalOf(
        new MockTicketingApi().updateAssignmentAgent(
          BRAND,
          MOCK_DEPARTMENTS[2]?.id ?? '',
          '0192c3f0-1a2b-7c3d-8e4f-00000000000c',
          { inRotation: true },
        ),
      ),
    ).toBe('not-eligible');
  });
});
