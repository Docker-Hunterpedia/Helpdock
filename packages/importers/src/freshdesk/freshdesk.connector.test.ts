import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectAsync } from '../testing/collect.js';
import { FreshdeskConnector } from './freshdesk.connector.js';
import { freshdeskTestContext } from './testing/context.js';
import { freshdeskCoreFixture } from './testing/core-fixture.js';
import { FakeFreshdesk } from './testing/fake-freshdesk.js';

let fake: FakeFreshdesk;
let connector: FreshdeskConnector;
beforeEach(async () => {
  fake = new FakeFreshdesk(freshdeskCoreFixture, {
    authorization: `Basic ${Buffer.from('synthetic-key:X').toString('base64')}`,
    now: Date.parse('2026-10-17T00:00:00Z'),
    pageSize: 2,
  });
  await fake.server.start();
  connector = new FreshdeskConnector({ apiRoot: fake.server.root });
});
afterEach(async () => {
  await fake.server.close();
});

it('requires global ticket scope and an administrator export probe', async () => {
  expect(await connector.test(freshdeskTestContext(fake))).toEqual({ ok: true, account: 'demo' });
  expect(fake.server.calls.map((call) => call.path)).toEqual([
    '/api/v2/agents/me',
    '/api/v2/agents',
  ]);
  fake.server.failNext({ path: '/api/v2/agents', status: 403 });
  expect(await connector.test(freshdeskTestContext(fake))).toEqual({
    ok: false,
    reason: 'credentials-refused',
  });
  fake.replaceFixture({
    ...freshdeskCoreFixture,
    agents: (freshdeskCoreFixture.agents ?? []).map((agent) => ({ ...agent, ticket_scope: 2 })),
  });
  const calls = fake.server.calls.length;
  expect(await connector.test(freshdeskTestContext(fake))).toEqual({
    ok: false,
    reason: 'credentials-refused',
  });
  expect(fake.server.calls.slice(calls).map((call) => call.path)).toEqual(['/api/v2/agents/me']);
});

it('keeps stable status IDs with source labels across resumable mapping-metadata pages', async () => {
  fake.replaceFixture({
    ...freshdeskCoreFixture,
    ticket_fields: [
      { id: 91, name: 'subject', type: 'default_subject', label: 'Subject' },
      { id: 92, name: 'priority', type: 'default_priority', label: 'Priority' },
      {
        id: 93,
        name: 'status',
        type: 'default_status',
        label: 'Status',
        choices: { '2': ['Open', 'Open'], '9': ['Waiting for supplier', 'In progress'] },
      },
    ],
    tickets: (freshdeskCoreFixture.tickets ?? []).map((ticket) => ({
      ...ticket,
      status: ticket.id === 1 ? 9 : 2,
    })),
  });
  const context = freshdeskTestContext(fake);
  const iterator = connector.extract(context, 'ticket', null)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (!first.value?.cursor || first.done) throw new Error('Missing status metadata checkpoint');
  await iterator.return?.();
  const pages = await collectAsync(
    connector.extract(context, 'ticket', JSON.parse(JSON.stringify(first.value.cursor))),
  );
  expect(pages.flatMap((page) => page.records)).toMatchObject([
    { payload: { externalId: '1', status: '9', statusLabel: 'Waiting for supplier' } },
    { payload: { externalId: '2', status: '2', statusLabel: 'Open' } },
    { payload: { externalId: '3', status: '2', statusLabel: 'Open' } },
  ]);
  expect(pages.at(-1)?.cursor).toBeNull();
});

it('does not silently fall back to another survey API after an access refusal', async () => {
  fake.server.failNext({ path: '/api/v2/customer-satisfaction/surveys', status: 403 });
  await expect(
    collectAsync(connector.extract(freshdeskTestContext(fake), 'csat', null)),
  ).rejects.toMatchObject({ code: 'credentials-refused' });
  expect(fake.server.calls.some((call) => call.path.startsWith('/api/v2/surveys/'))).toBe(false);
  const context = freshdeskTestContext(fake);
  context.credentials.csatApi = 'legacy';
  expect(
    (await collectAsync(connector.extract(context, 'csat', null))).flatMap((page) => page.records),
  ).toEqual([]);
  expect(fake.server.calls.at(-1)?.path).toBe('/api/v2/surveys/satisfaction_ratings');
});

it('only proposes documented priority/channel values, leaving confirmation to the brand administrator', async () => {
  const pages = await collectAsync(connector.extract(freshdeskTestContext(fake), 'ticket', null));
  const records = pages.flatMap((page) => page.records);
  expect(connector.defaultMappings(records)).toEqual(
    expect.arrayContaining([
      { kind: 'priority', externalValue: '1', target: { priority: 'low' } },
      { kind: 'channel', externalValue: '1', target: { channel: 'email' } },
    ]),
  );
  expect(
    connector
      .defaultMappings(records)
      .some((mapping) => mapping.kind === 'agent' || mapping.kind === 'status'),
  ).toBe(false);
});
