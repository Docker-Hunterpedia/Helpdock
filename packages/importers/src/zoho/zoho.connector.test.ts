import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectAsync } from '../testing/collect.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';
import { ZohoConnector } from './zoho.connector.js';

let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho(structuredClone(zohoCoreFixture));
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});
function connection() {
  return {
    connector: new ZohoConnector({ apiRoot: fake.root, accountsRoot: fake.root }),
    context: zohoTestConnection(fake).context,
  };
}

it('checks read capabilities under an administrator export profile without confusing its ID with an agent', async () => {
  const { connector, context } = connection();
  expect(await connector.test(context)).toEqual({ ok: true, account: `us:${fake.fixture.orgId}` });
  expect(fake.calls.some((call) => call.path === '/api/v1/myProfile')).toBe(true);
  expect(
    fake.calls.some((call) => call.path === `/api/v1/agents/${fake.fixture.exportProfile!.id}`),
  ).toBe(false);
  expect(fake.calls.every((call) => call.method === 'GET' || call.path === '/oauth/v2/token')).toBe(
    true,
  );
});

it.each(['custom-profile', 'restricted-departments', 'missing-export'] as const)(
  'refuses a %s instead of claiming a complete export connection',
  async (scenario) => {
    const profile = fake.fixture.exportProfile!;
    if (scenario === 'custom-profile') profile.type = 'Custom';
    else if (scenario === 'restricted-departments')
      profile.permissions.setup!.fetchAcrossDepartment = false;
    else profile.permissions.tickets!.export = false;
    const { connector, context } = connection();
    expect(await connector.test(context)).toEqual({ ok: false, reason: 'credentials-refused' });
    expect(fake.calls.some((call) => call.path === '/api/v1/tickets')).toBe(false);
  },
);

it.each([
  { status: 403, reason: 'credentials-refused' },
  { status: 429, reason: 'vendor-unavailable' },
  { status: 503, reason: 'vendor-unavailable' },
] as const)(
  'reports a safe connection failure after contacts HTTP $status',
  async ({ status, reason }) => {
    fake.failNext({
      path: '/api/v1/contacts',
      status,
      headers: { 'Retry-After': '2' },
      json: { message: 'synthetic-sensitive-provider-body' },
    });
    const { connector, context } = connection();
    expect(await connector.test(context)).toEqual({ ok: false, reason });
  },
);

it('extracts native users and ticket tags while reusing one connection token and proposing explicit priority/channel mappings', async () => {
  const { connector, context } = connection();
  const users = (await collectAsync(connector.extract(context, 'user', null))).flatMap(
    (page) => page.records,
  );
  expect(users).toHaveLength(4);
  const tags = (await collectAsync(connector.extract(context, 'tag', null))).flatMap(
    (page) => page.records,
  );
  expect(tags).toEqual([
    { entity: 'tag', payload: { externalId: 'original-tag', name: 'original-tag' } },
  ]);
  const tickets = (await collectAsync(connector.extract(context, 'ticket', null))).flatMap(
    (page) => page.records,
  );
  expect(tickets.find((row) => row.payload.externalId === '9007199254740993001')).toMatchObject({
    entity: 'ticket',
    payload: {
      number: '101',
      status: 'Open',
      tags: ['original-tag'],
      createdAt: '2013-11-01T11:21:07.000Z',
    },
  });
  expect(connector.defaultMappings(tickets)).toEqual([
    { kind: 'priority', externalValue: 'High', target: { priority: 'high' } },
    { kind: 'channel', externalValue: 'EMAIL', target: { channel: 'email' } },
  ]);
  expect(fake.calls.filter((call) => call.path === '/oauth/v2/token')).toHaveLength(1);
});
