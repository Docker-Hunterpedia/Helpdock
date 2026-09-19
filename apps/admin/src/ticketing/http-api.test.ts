import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { isTicketingError } from './api.js';
import { HttpTicketingApi } from './http-api.js';

/**
 * The adapter against a stubbed `fetch`: what it sends, what it parses, and
 * what it makes of a refusal. That the endpoints behind it behave is the api's
 * integration suite.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const DEPARTMENT = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';
const TEAM = '0192c3f0-1a2b-7c3d-8e4f-0000000000c1';
const USER = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';

const department = {
  id: DEPARTMENT,
  name: 'Billing',
  nameAr: null,
  sortOrder: 0,
  defaultTeamId: null,
  defaultTeamName: null,
  teamCount: 0,
  memberCount: 0,
};

const team = {
  id: TEAM,
  departmentId: DEPARTMENT,
  name: 'Front line',
  sortOrder: 0,
  members: [],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ticketingFailure = (reason: string, status = 409): Response =>
  json(
    { error: { code: 'conflict', message: 'no', requestId: 'r1', ticketing: { reason } } },
    status,
  );

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpTicketingApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpTicketingApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = (): { url: string; init: RequestInit } => {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('fetch was not called');
  }

  return { url: String(call[0]), init: call[1] as RequestInit };
};

describe('departments', () => {
  it('asks the brand for its departments and parses the list', async () => {
    fetchMock.mockResolvedValue(json({ departments: [department] }));

    const list = await api.departments(BRAND);

    expect(lastCall().url).toBe(`/api/brands/${BRAND}/departments`);
    expect(list.departments[0]?.name).toBe('Billing');
  });

  it('posts a new one', async () => {
    fetchMock.mockResolvedValue(json(department));

    await api.createDepartment(BRAND, { name: 'Billing', nameAr: null });

    const { url, init } = lastCall();
    expect(init.method).toBe('POST');
    expect(url).toBe(`/api/brands/${BRAND}/departments`);
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Billing', nameAr: null });
  });

  it('patches one by id', async () => {
    fetchMock.mockResolvedValue(json({ ...department, name: 'Payments' }));

    const updated = await api.updateDepartment(BRAND, DEPARTMENT, { name: 'Payments' });

    expect(lastCall().url).toBe(`/api/brands/${BRAND}/departments/${DEPARTMENT}`);
    expect(updated.name).toBe('Payments');
  });

  it('sends the whole order to the reorder endpoint', async () => {
    fetchMock.mockResolvedValue(json({ departments: [department] }));

    await api.reorderDepartments(BRAND, [DEPARTMENT]);

    const { url, init } = lastCall();
    expect(url).toBe(`/api/brands/${BRAND}/departments/reorder`);
    expect(JSON.parse(String(init.body))).toEqual({ departmentIds: [DEPARTMENT] });
  });

  it('turns a 204 delete into nothing at all', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(api.deleteDepartment(BRAND, DEPARTMENT)).resolves.toBeUndefined();
    expect(lastCall().init.method).toBe('DELETE');
  });
});

describe('teams and members', () => {
  it('reads, creates, renames and deletes under the department', async () => {
    // A fresh `Response` per call: a body can only be read once, and this test
    // makes four requests.
    fetchMock.mockImplementation(() => json({ teams: [team] }));

    await api.teams(BRAND, DEPARTMENT);
    expect(lastCall().url).toBe(`/api/brands/${BRAND}/departments/${DEPARTMENT}/teams`);

    await api.createTeam(BRAND, DEPARTMENT, 'Front line');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ name: 'Front line' });

    await api.renameTeam(BRAND, DEPARTMENT, TEAM, 'Tier 1');
    expect(lastCall().url).toBe(`/api/brands/${BRAND}/departments/${DEPARTMENT}/teams/${TEAM}`);
    expect(lastCall().init.method).toBe('PATCH');

    await api.deleteTeam(BRAND, DEPARTMENT, TEAM);
    expect(lastCall().init.method).toBe('DELETE');
  });

  it('adds and removes a member on the team’s own path', async () => {
    fetchMock.mockImplementation(() => json({ teams: [team] }));

    await api.addMember(BRAND, DEPARTMENT, TEAM, USER);
    expect(lastCall().url).toBe(
      `/api/brands/${BRAND}/departments/${DEPARTMENT}/teams/${TEAM}/members`,
    );

    await api.removeMember(BRAND, DEPARTMENT, TEAM, USER);
    expect(lastCall().url).toBe(
      `/api/brands/${BRAND}/departments/${DEPARTMENT}/teams/${TEAM}/members/${USER}`,
    );
  });

  it('reads the picker from the eligible-members endpoint', async () => {
    fetchMock.mockResolvedValue(json({ members: [] }));

    await api.eligibleMembers(BRAND, DEPARTMENT);

    expect(lastCall().url).toBe(`/api/brands/${BRAND}/departments/${DEPARTMENT}/eligible-members`);
  });
});

describe('the brand', () => {
  it('reads and patches it', async () => {
    const brand = {
      id: BRAND,
      name: 'Helpdock',
      prefix: 'HD',
      defaultLocale: 'en',
      timezone: 'UTC',
      status: 'active',
      settings: { autoAwaitOnAgentReply: true, reopenPolicy: { kind: 'never' } },
    };
    fetchMock.mockImplementation(() => json(brand));

    expect((await api.brand(BRAND)).prefix).toBe('HD');

    await api.updateBrand(BRAND, { name: 'Renamed' });
    expect(lastCall().init.method).toBe('PATCH');
    expect(lastCall().url).toBe(`/api/brands/${BRAND}`);
  });
});

describe('a response the two sides disagree about', () => {
  it('fails at the adapter rather than three components deep', async () => {
    fetchMock.mockResolvedValue(json({ departments: [{ id: DEPARTMENT, name: 'Billing' }] }));

    await expect(api.departments(BRAND)).rejects.toThrow();
  });
});

describe('a refusal', () => {
  it('arrives as a ticketing error carrying the code, not a sentence', async () => {
    fetchMock.mockResolvedValue(ticketingFailure('last-department'));

    const error = await api.deleteDepartment(BRAND, DEPARTMENT).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(isTicketingError(error) && error.reason).toBe('last-department');
  });

  it('is a permission answer when the actor does not lead the department', async () => {
    fetchMock.mockResolvedValue(ticketingFailure('out-of-scope', 403));

    const error = await api.updateDepartment(BRAND, DEPARTMENT, { name: 'x' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(isTicketingError(error) && error.reason).toBe('out-of-scope');
  });
});
