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

// --------------------------------------------------------------------- M1-06

const TAG = '0192c3f0-1a2b-7c3d-8e4f-000000000101';
const FIELD = '0192c3f0-1a2b-7c3d-8e4f-000000000201';
const TEMPLATE = '0192c3f0-1a2b-7c3d-8e4f-000000000301';

const tag = { id: TAG, name: 'Refund', nameAr: null, color: 'info', sortOrder: 0, ticketCount: 2 };

const field = {
  id: FIELD,
  target: 'ticket',
  key: 'tier',
  label: 'Plan tier',
  labelAr: null,
  type: 'select',
  options: ['gold'],
  required: false,
  agentVisible: true,
  sortOrder: 0,
};

const template = {
  id: TEMPLATE,
  name: 'Refund request',
  departmentId: null,
  priority: 'medium',
  subject: 'Refund',
  bodyText: 'Hello',
  defaultTagIds: [],
  customDefaults: {},
  usageCount: 0,
};

describe('tags', () => {
  it('asks the brand for its tags and parses the list', async () => {
    fetchMock.mockResolvedValue(json({ tags: [tag] }));

    await expect(api.tags(BRAND)).resolves.toEqual({ tags: [tag] });
    expect(lastCall().url).toContain(`/brands/${BRAND}/tags`);
  });

  it('creates one', async () => {
    fetchMock.mockResolvedValue(json(tag));

    await api.createTag(BRAND, { name: 'Refund', color: 'info' });

    expect(lastCall().init.method).toBe('POST');
  });

  it('updates one', async () => {
    fetchMock.mockResolvedValue(json(tag));

    await api.updateTag(BRAND, TAG, { color: 'success' });

    expect(lastCall().url).toContain(`/tags/${TAG}`);
    expect(lastCall().init.method).toBe('PATCH');
  });

  it('sends the whole order', async () => {
    fetchMock.mockResolvedValue(json({ tags: [tag] }));

    await api.reorderTags(BRAND, [TAG]);

    expect(lastCall().url).toContain('/tags/reorder');
    expect(String(lastCall().init.body)).toContain(TAG);
  });

  it('reads the usage before a delete', async () => {
    fetchMock.mockResolvedValue(json({ tagId: TAG, ticketCount: 4 }));

    await expect(api.tagUsage(BRAND, TAG)).resolves.toEqual({ tagId: TAG, ticketCount: 4 });
    expect(lastCall().url).toContain(`/tags/${TAG}/usage`);
  });

  it('deletes one', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api.deleteTag(BRAND, TAG);

    expect(lastCall().init.method).toBe('DELETE');
  });

  it('turns a duplicate name into the refusal the screen knows', async () => {
    fetchMock.mockResolvedValue(ticketingFailure('name-taken'));

    const failure = await api
      .createTag(BRAND, { name: 'Refund', color: 'info' })
      .catch((error: unknown) => error);

    expect(isTicketingError(failure)).toBe(true);
  });
});

describe('custom fields', () => {
  it('asks for every target at once when none is named', async () => {
    fetchMock.mockResolvedValue(json({ fields: [field] }));

    await expect(api.customFields(BRAND)).resolves.toEqual({ fields: [field] });
    expect(lastCall().url).not.toContain('target=');
  });

  it('narrows to one target when one is', async () => {
    fetchMock.mockResolvedValue(json({ fields: [field] }));

    await api.customFields(BRAND, 'contact');

    expect(lastCall().url).toContain('target=contact');
  });

  it('creates one', async () => {
    fetchMock.mockResolvedValue(json(field));

    await api.createCustomField(BRAND, {
      target: 'ticket',
      key: 'tier',
      label: 'Plan tier',
      type: 'select',
      options: ['gold'],
      required: false,
      agentVisible: true,
    });

    expect(lastCall().init.method).toBe('POST');
  });

  it('carries force on an update, which is how an option in use is removed', async () => {
    fetchMock.mockResolvedValue(json(field));

    await api.updateCustomField(BRAND, FIELD, { options: [], force: true });

    expect(String(lastCall().init.body)).toContain('"force":true');
  });

  it('sends the target with a reorder, because each target has its own order', async () => {
    fetchMock.mockResolvedValue(json({ fields: [field] }));

    await api.reorderCustomFields(BRAND, 'ticket', [FIELD]);

    expect(String(lastCall().init.body)).toContain('"target":"ticket"');
  });

  it('reads the usage, options included', async () => {
    fetchMock.mockResolvedValue(json({ fieldId: FIELD, rows: 3, optionRows: { gold: 2 } }));

    await expect(api.customFieldUsage(BRAND, FIELD)).resolves.toEqual({
      fieldId: FIELD,
      rows: 3,
      optionRows: { gold: 2 },
    });
  });

  it('deletes one', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api.deleteCustomField(BRAND, FIELD);

    expect(lastCall().init.method).toBe('DELETE');
  });
});

describe('ticket templates', () => {
  it('asks the brand for its templates', async () => {
    fetchMock.mockResolvedValue(json({ templates: [template] }));

    await expect(api.ticketTemplates(BRAND)).resolves.toEqual({ templates: [template] });
  });

  it('creates one', async () => {
    fetchMock.mockResolvedValue(json(template));

    await api.createTicketTemplate(BRAND, {
      name: 'Refund request',
      priority: 'medium',
      subject: 'Refund',
      bodyText: 'Hello',
      defaultTagIds: [],
      customDefaults: {},
    });

    expect(lastCall().init.method).toBe('POST');
  });

  it('updates one', async () => {
    fetchMock.mockResolvedValue(json(template));

    await api.updateTicketTemplate(BRAND, TEMPLATE, { priority: 'high' });

    expect(lastCall().url).toContain(`/ticket-templates/${TEMPLATE}`);
  });

  it('deletes one', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api.deleteTicketTemplate(BRAND, TEMPLATE);

    expect(lastCall().init.method).toBe('DELETE');
  });

  it('asks the api to render the preview rather than filling it here', async () => {
    fetchMock.mockResolvedValue(
      json({ subject: 'Refund for Mona', bodyText: 'Hello Mona', unknownPlaceholders: [] }),
    );

    await expect(api.previewTicketTemplate(BRAND, TEMPLATE)).resolves.toMatchObject({
      subject: 'Refund for Mona',
    });
    expect(lastCall().url).toContain('/preview');
  });
});

describe('the block list (M1-11)', () => {
  const BLOCKED = '0192c3f0-1a2b-7c3d-8e4f-0000000bb001';
  const row = {
    id: BLOCKED,
    kind: 'domain',
    value: 'promo-deals.biz',
    createdByName: 'Lina',
    sourceTicketId: null,
    droppedCount: 112,
    lastDroppedAt: null,
    createdAt: '2026-09-12T09:00:00.000Z',
  };

  it('reads the list', async () => {
    fetchMock.mockResolvedValue(json({ senders: [row] }));

    const { senders } = await api.blockedSenders(BRAND);

    expect(lastCall().url).toBe(`/api/brands/${BRAND}/blocked-senders`);
    expect(senders[0]?.droppedCount).toBe(112);
  });

  it('blocks a sender with the kind and the value as typed', async () => {
    fetchMock.mockResolvedValue(json(row, 201));

    await api.blockSender(BRAND, { kind: 'domain', value: '@Promo-Deals.biz' });

    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      kind: 'domain',
      value: '@Promo-Deals.biz',
    });
  });

  it('turns the brand’s own domain into the refusal the card draws', async () => {
    fetchMock.mockResolvedValue(ticketingFailure('sender-is-own'));

    const error = await api
      .blockSender(BRAND, { kind: 'domain', value: 'helpdock.com' })
      .catch((caught: unknown) => caught);

    expect(isTicketingError(error) && error.reason).toBe('sender-is-own');
  });

  it('unblocks by id', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api.unblockSender(BRAND, BLOCKED);

    expect(lastCall().url).toBe(`/api/brands/${BRAND}/blocked-senders/${BLOCKED}`);
    expect(lastCall().init.method).toBe('DELETE');
  });

  it('saves the Spam tab’s setting on its own narrow route', async () => {
    fetchMock.mockResolvedValue(json({ offerBlockSender: false }));

    const settings = await api.updateSpamSettings(BRAND, { offerBlockSender: false });

    expect(lastCall().url).toBe(`/api/brands/${BRAND}/ticketing/spam-settings`);
    expect(lastCall().init.method).toBe('PATCH');
    expect(settings.offerBlockSender).toBe(false);
  });
});
