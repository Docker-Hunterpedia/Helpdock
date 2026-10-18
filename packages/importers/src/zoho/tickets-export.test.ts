import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
import type { TicketInventory } from '../ticket-inventory.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';
import { initialZohoTicketScan, readZohoTicketScan, zohoTicketScanSchema } from './ticket-scan.js';
import { exportZohoTickets } from './tickets-export.js';

let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho(structuredClone(zohoCoreFixture));
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});
const archivedId = '9007199254740993003';
function inventory(mode: TicketInventory['mode'] = 'archives'): TicketInventory {
  return {
    mode,
    fingerprint: 'a'.repeat(64),
    next: async (after) =>
      after === null ? { externalId: archivedId, location: 'archived' } : null,
  };
}

it('hydrates active and archived tickets with original IDs, numbers, references, dates, fields and tags', async () => {
  const { client } = zohoTestConnection(fake);
  const records = (
    await collectAsync(exportZohoTickets(client, null, undefined, inventory()))
  ).flatMap((page) => page.records);
  expect(records.map((record) => record.payload.externalId)).toEqual(
    zohoCoreFixture.tickets.map((ticket) => ticket.id),
  );
  expect(records[0]).toMatchObject({
    entity: 'ticket',
    payload: {
      externalId: '9007199254740993001',
      number: '101',
      requesterExternalId: '9007199254740993201',
      assigneeExternalId: '9007199254740993301',
      groupExternalId: '9007199254740993401',
      organizationExternalId: '9007199254740993501',
      ccExternalIds: ['9007199254740993202'],
      createdAt: '2013-11-01T11:21:07.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      tags: ['original-tag'],
      custom: { cf_plan: 'Original plan' },
    },
  });
  expect(records[2]).toMatchObject({
    entity: 'ticket',
    payload: {
      status: 'Completed by support',
      statusLabel: 'Completed by support',
      closedAt: '2020-01-03T00:00:00.000Z',
    },
  });
  expect(fake.calls.every((call) => call.method === 'GET' || call.path === '/oauth/v2/token')).toBe(
    true,
  );
});

it('resumes a serialized checkpoint without re-emitting a committed ticket', async () => {
  const { client } = zohoTestConnection(fake);
  let cursor: ImportCursor | null = null;
  for await (const page of exportZohoTickets(client, null, undefined, inventory())) {
    cursor = page.cursor;
    if (page.records.length) break;
  }
  const resumed = (
    await collectAsync(
      exportZohoTickets(client, JSON.parse(JSON.stringify(cursor)), undefined, inventory()),
    )
  ).flatMap((page) => page.records);
  expect(resumed.map((record) => record.payload.externalId)).toEqual([
    '9007199254740993002',
    archivedId,
  ]);
});

it('checkpoints the fixed delta end before HTTP, then selects changed live records and rescans its archive inventory', async () => {
  const { client } = zohoTestConnection(fake);
  const iterator = exportZohoTickets(
    client,
    null,
    new Date('2020-01-02T00:00:00.000Z'),
    inventory(),
  );
  const first = await iterator.next();
  expect(fake.calls).toEqual([]);
  expect(first.value?.cursor).toMatchObject({
    stage: 'active',
    window: { start: '2020-01-02T00:00:00.000Z' },
  });
  await iterator.return(undefined);
  const records = (
    await collectAsync(
      exportZohoTickets(client, first.value?.cursor ?? null, undefined, inventory()),
    )
  ).flatMap((page) => page.records);
  expect(records.map((record) => record.payload.externalId)).toEqual([
    '9007199254740993002',
    archivedId,
  ]);
});

it('uses complete inventories for full and delta imports without relying on list or search ceilings', async () => {
  const { client } = zohoTestConnection(fake);
  for (const since of [undefined, new Date('2026-01-01T00:00:00Z')]) {
    const records = (
      await collectAsync(exportZohoTickets(client, null, since, inventory('complete')))
    ).flatMap((page) => page.records);
    expect(records.map((record) => record.payload.externalId)).toEqual([archivedId]);
  }
  expect(
    fake.calls.some((call) => ['/api/v1/tickets', '/api/v1/tickets/search'].includes(call.path)),
  ).toBe(false);
});

it('refuses changed inventory fingerprints before reading a native ticket', async () => {
  const { client } = zohoTestConnection(fake);
  await expect(
    collectAsync(
      exportZohoTickets(
        client,
        { stage: 'inventory', fingerprint: 'b'.repeat(64), after: null },
        undefined,
        inventory(),
      ),
    ),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  expect(fake.calls).toEqual([]);
});

it.each([429, 503])('does not consume a ticket when its read fails with %s', async (status) => {
  let now = 0;
  const { client } = zohoTestConnection(fake, { now: () => now });
  const cursor = initialZohoTicketScan(inventory('complete'));
  fake.failNext({ path: `/api/v1/tickets/${archivedId}`, status, headers: { 'Retry-After': '2' } });
  await expect(
    collectAsync(exportZohoTickets(client, cursor, undefined, inventory('complete'))),
  ).rejects.toMatchObject(status === 429 ? { retryAfterMs: 2000 } : { code: 'vendor-unavailable' });
  now += 2000;
  const records = (
    await collectAsync(exportZohoTickets(client, cursor, undefined, inventory('complete')))
  ).flatMap((page) => page.records);
  expect(records.map((record) => record.payload.externalId)).toEqual([archivedId]);
});

it('scans beyond the search ceiling in immutable creation order, including timestamp ties', async () => {
  const at = '2020-01-01T00:00:00.000Z';
  fake.fixture.tickets = Array.from({ length: 5100 }, (_, index) => ({
    id: String(10000 + index),
    createdTime: at,
    modifiedTime: at,
  }));
  const { client } = zohoTestConnection(fake);
  let scan = zohoTicketScanSchema.parse({
    stage: 'active',
    from: 4900,
    ids: [],
    offset: 0,
    terminal: false,
    lastTime: null,
    pending: [],
    window: { start: at, end: at },
  });
  const seen = new Set<string>();
  for (let steps = 0; steps < 1000; steps++) {
    const next = await readZohoTicketScan(client, scan);
    if (next.id) seen.add(next.id);
    if (next.next === null) break;
    scan = next.next;
    if (scan.stage !== 'active') break;
  }
  expect([...seen].sort()).toEqual(
    fake.fixture.tickets
      .slice(4900)
      .map((ticket) => ticket.id)
      .sort(),
  );
  expect(
    fake.calls
      .filter((call) => call.path.includes('/tickets'))
      .every((call) => call.path === '/api/v1/tickets' && call.query.sortBy === 'createdTime'),
  ).toBe(true);
});

it('does not lose an unchanged delta boundary ticket when an earlier result leaves the modified-time window', async () => {
  const at = '2020-01-01T00:00:00.000Z';
  fake.fixture.tickets = Array.from({ length: 101 }, (_, index) => ({
    id: String(10000 + index),
    createdTime: at,
    modifiedTime: at,
  }));
  const { client } = zohoTestConnection(fake);
  let scan = initialZohoTicketScan(undefined, new Date(at), new Date('2020-01-02T00:00:00Z'));
  const seen: string[] = [];
  for (let steps = 0; steps < 200; steps++) {
    const next = await readZohoTicketScan(client, scan);
    if (next.id) seen.push(next.id);
    if (seen.length === 100) {
      const first = fake.fixture.tickets[0];
      if (first) first.modifiedTime = '2030-01-01T00:00:00.000Z';
    }
    if (next.next?.stage !== 'active') break;
    scan = next.next;
  }
  expect(new Set(seen)).toEqual(new Set(fake.fixture.tickets.map((ticket) => ticket.id)));
});
