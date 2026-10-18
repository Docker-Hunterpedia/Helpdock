import type { ImportRecord } from '@helpdock/schemas';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
import type { TicketInventory } from '../ticket-inventory.js';
import { FreshdeskClient } from './client.js';
import { FreshdeskConnector } from './freshdesk.connector.js';
import { initialFreshdeskInventory, readFreshdeskInventory } from './inventory.js';
import { freshdeskTestContext } from './testing/context.js';
import { freshdeskCoreFixture } from './testing/core-fixture.js';
import { FakeFreshdesk } from './testing/fake-freshdesk.js';

const inventory = (mode: TicketInventory['mode'] = 'archives'): TicketInventory => ({
  mode,
  fingerprint: (mode === 'archives' ? 'a' : 'b').repeat(64),
  next: async (after) => (after === null ? { externalId: '9001', location: 'archived' } : null),
});
let fake: FakeFreshdesk;
beforeEach(async () => {
  const parent = freshdeskCoreFixture.tickets?.[0];
  if (!parent) throw new Error('Missing source ticket');
  fake = new FakeFreshdesk(
    {
      ...freshdeskCoreFixture,
      tickets: [
        ...(freshdeskCoreFixture.tickets ?? []),
        {
          ...parent,
          id: 9001,
          archived: true,
          tags: ['archived-tag'],
          description: '<p>Original archived question</p>',
          description_text: 'Original archived question',
        },
      ],
      conversations: {
        ...freshdeskCoreFixture.conversations,
        '9001': [
          {
            id: 90001,
            ticket_id: 9001,
            user_id: 301,
            incoming: false,
            private: true,
            body: '<p>Archived internal note</p>',
            created_at: '2020-01-02T00:00:00Z',
            updated_at: '2020-01-02T00:00:00Z',
          },
          {
            id: 90002,
            ticket_id: 9001,
            user_id: 201,
            incoming: true,
            private: false,
            body: '<p>Archived customer follow-up</p>',
            created_at: '2020-01-03T00:00:00Z',
            updated_at: '2020-01-03T00:00:00Z',
          },
        ],
      },
    },
    {
      authorization: `Basic ${Buffer.from('synthetic-key:X').toString('base64')}`,
      now: Date.parse('2026-10-17T00:00:00Z'),
      pageSize: 1,
    },
  );
  await fake.server.start();
});
afterEach(async () => {
  await fake.server.close();
});

it('appends archive inventory to live tickets and carries full private/public history and tags through the same reader', async () => {
  const connector = new FreshdeskConnector({ apiRoot: fake.server.root, inventory: inventory() });
  const context = freshdeskTestContext(fake);
  const tickets = (await collectAsync(connector.extract(context, 'ticket', null))).flatMap(
    (page) => page.records,
  );
  expect(tickets.map((record) => record.payload.externalId)).toEqual(['1', '2', '3', '9001']);
  expect(tickets.at(-1)).toMatchObject({
    entity: 'ticket',
    payload: {
      externalId: '9001',
      requesterExternalId: '201',
      assigneeExternalId: '301',
      tags: ['archived-tag'],
    },
  });
  const messages = (await collectAsync(connector.extract(context, 'message', null))).flatMap(
    (page) => page.records,
  );
  expect(messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entity: 'message',
        payload: expect.objectContaining({
          externalId: 'ticket:9001:description',
          bodyHtml: '<p>Original archived question</p>',
        }),
      }),
      expect.objectContaining({
        entity: 'message',
        payload: expect.objectContaining({
          externalId: '90001',
          ticketExternalId: '9001',
          authorKind: 'agent',
          public: false,
          createdAt: '2020-01-02T00:00:00Z',
        }),
      }),
      expect.objectContaining({
        entity: 'message',
        payload: expect.objectContaining({
          externalId: '90002',
          ticketExternalId: '9001',
          authorKind: 'customer',
          public: true,
        }),
      }),
    ]),
  );
  const tags = (await collectAsync(connector.extract(context, 'tag', null))).flatMap(
    (page) => page.records,
  );
  expect(tags).toContainEqual({
    entity: 'tag',
    payload: { externalId: 'archived-tag', name: 'archived-tag' },
  });
  expect(
    fake.server.calls.some(
      (call) =>
        call.path === '/api/v2/tickets/archived/9001/conversations' && call.query.page === '2',
    ),
  ).toBe(true);
});

it('uses a complete inventory instead of a capped list and rescans it during delta without relying on creation dates', async () => {
  const connector = new FreshdeskConnector({
    apiRoot: fake.server.root,
    inventory: inventory('complete'),
  });
  for (const since of [undefined, new Date('2026-10-17T00:00:00Z')]) {
    const records = (
      await collectAsync(connector.extract(freshdeskTestContext(fake), 'ticket', null, since))
    ).flatMap((page) => page.records);
    expect(records).toMatchObject([
      { entity: 'ticket', payload: { externalId: '9001', createdAt: '2020-01-01T10:00:00Z' } },
    ]);
  }
  expect(fake.server.calls.some((call) => call.path === '/api/v2/tickets')).toBe(false);
});

it('resumes within a multi-page archived thread without losing or duplicating messages', async () => {
  const connector = new FreshdeskConnector({
    apiRoot: fake.server.root,
    inventory: inventory('complete'),
  });
  const context = freshdeskTestContext(fake);
  const iterator = connector.extract(context, 'message', null)[Symbol.asyncIterator]();
  const records: ImportRecord[] = [];
  let cursor: ImportCursor | null = null;
  while (true) {
    const page = await iterator.next();
    if (page.done) throw new Error('Source ended before private note');
    records.push(...page.value.records);
    if (page.value.records.some((record) => record.payload.externalId === '90001')) {
      cursor = page.value.cursor;
      break;
    }
  }
  await iterator.return?.();
  for (const page of await collectAsync(
    connector.extract(context, 'message', JSON.parse(JSON.stringify(cursor))),
  ))
    records.push(...page.records);
  expect(records.map((record) => record.payload.externalId)).toEqual([
    'ticket:9001:description',
    '90001',
    '90002',
  ]);
});

it('refuses an altered inventory fingerprint before hydrating another native record', async () => {
  const client = new FreshdeskClient(freshdeskTestContext(fake), fake.server.root);
  const source = inventory('complete');
  await expect(
    readFreshdeskInventory(client, initialFreshdeskInventory(source), {
      ...source,
      fingerprint: 'c'.repeat(64),
    }),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  expect(fake.server.calls).toEqual([]);
});

it.each(['../escape', '0', '9007199254740992'])(
  'refuses an unsafe or lossy native inventory ID: %s',
  async (externalId) => {
    const source: TicketInventory = {
      ...inventory(),
      next: async () => ({ externalId, location: 'auto' }),
    };
    const client = new FreshdeskClient(freshdeskTestContext(fake), fake.server.root);
    await expect(
      readFreshdeskInventory(client, initialFreshdeskInventory(source), source),
    ).rejects.toThrow();
    expect(fake.server.calls).toEqual([]);
  },
);

it('only uses automatic archive fallback on a missing active record, never on an authorization refusal', async () => {
  const source: TicketInventory = {
    ...inventory(),
    next: async (after) => (after ? null : { externalId: '9001', location: 'auto' }),
  };
  const client = new FreshdeskClient(freshdeskTestContext(fake), fake.server.root);
  expect(
    await readFreshdeskInventory(client, initialFreshdeskInventory(source), source),
  ).toMatchObject({ rows: [{ id: 9001, archived: true }] });
  fake.server.failNext({ path: '/api/v2/tickets/9001', status: 403 });
  const count = fake.server.calls.length;
  await expect(
    readFreshdeskInventory(client, initialFreshdeskInventory(source), source),
  ).rejects.toMatchObject({ code: 'credentials-refused' });
  expect(fake.server.calls.slice(count).map((call) => call.path)).toEqual(['/api/v2/tickets/9001']);
});
