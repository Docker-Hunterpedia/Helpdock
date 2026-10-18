import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
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

it.each([undefined, new Date('2026-01-01T00:00:00Z')])(
  'automatically includes archived history from enabled and disabled departments with since=%s',
  async (since) => {
    const archived = zohoCoreFixture.tickets[2];
    if (!archived) throw new Error('Missing archived fixture');
    fake.fixture.tickets?.push({
      ...archived,
      id: '9007199254740993004',
      departmentId: '9007199254740993402',
    });
    const { client } = zohoTestConnection(fake);
    const records = (await collectAsync(exportZohoTickets(client, null, since))).flatMap(
      (page) => page.records,
    );
    expect(records.map((record) => record.payload.externalId)).toEqual(
      since
        ? [archived.id, '9007199254740993004']
        : [...zohoCoreFixture.tickets.map((ticket) => ticket.id), '9007199254740993004'],
    );
    const archivedReads = fake.calls.filter(
      (call) => call.path === '/api/v1/tickets/archivedTickets',
    );
    expect(archivedReads.map((call) => call.query.departmentId)).toEqual([
      '9007199254740993401',
      '9007199254740993402',
    ]);
    expect(
      archivedReads.every(
        (call) => call.method === 'GET' && call.query.modifiedTimeRange === undefined,
      ),
    ).toBe(true);
  },
);

it('resumes an archive page without losing or repeating committed tickets across a page boundary', async () => {
  const archived = zohoCoreFixture.tickets[2];
  if (!archived) throw new Error('Missing archived fixture');
  fake.fixture.tickets = Array.from({ length: 205 }, (_, index) => ({
    ...archived,
    id: String(10000 + index),
  }));
  const { client } = zohoTestConnection(fake);
  let cursor: ImportCursor | null = null;
  const committed: string[] = [];
  for await (const page of exportZohoTickets(client, null)) {
    committed.push(...page.records.map((record) => record.payload.externalId));
    cursor = page.cursor;
    if (committed.length === 101) break;
  }
  const replacement = zohoTestConnection(fake);
  const remaining = (
    await collectAsync(exportZohoTickets(replacement.client, JSON.parse(JSON.stringify(cursor))))
  ).flatMap((page) => page.records.map((record) => record.payload.externalId));
  expect([...committed, ...remaining]).toEqual(fake.fixture.tickets.map((ticket) => ticket.id));
  expect(
    fake.calls
      .filter(
        (call) =>
          call.path === '/api/v1/tickets/archivedTickets' &&
          call.query.departmentId === archived.departmentId,
      )
      .map((call) => call.query.from),
  ).toEqual(['0', '99', '198']);
});

it.each([5000, 5001])(
  'refuses an unprovable %s-ticket archive instead of claiming a complete history',
  async (count) => {
    const archived = zohoCoreFixture.tickets[2];
    if (!archived) throw new Error('Missing archived fixture');
    fake.fixture.tickets = Array.from({ length: count }, (_, index) => ({
      ...archived,
      id: String(10000 + index),
    }));
    const log = vi.fn();
    const { client } = zohoTestConnection(fake, { log });
    const cursor = zohoTicketScanSchema.parse({
      stage: 'archives',
      archive: {
        enabled: true,
        departmentFrom: 1,
        departmentIds: ['9007199254740993401'],
        departmentOffset: 0,
        departmentsTerminal: true,
        departmentBoundary: '9007199254740993401',
        previousDepartments: null,
        from: 4950,
        ids: [],
        offset: 0,
        terminal: false,
        boundary: '14950',
        previousPage: null,
      },
    });
    await expect(readZohoTicketScan(client, cursor)).rejects.toMatchObject({
      code: 'invalid-response',
    });
    expect(log).toHaveBeenCalledWith({
      level: 'error',
      entity: 'ticket',
      externalId: '9007199254740993401',
      message: 'import.zoho.archive-window-exhausted',
    });
    expect(fake.calls.some((call) => Number(call.query.from) > 4999)).toBe(false);
  },
);

it('detects a shifted archive page at its overlap boundary', async () => {
  const archived = zohoCoreFixture.tickets[2];
  if (!archived) throw new Error('Missing archived fixture');
  fake.fixture.tickets = Array.from({ length: 105 }, (_, index) => ({
    ...archived,
    id: String(10000 + index),
  }));
  const { client } = zohoTestConnection(fake);
  let cursor = initialZohoTicketScan();
  for (let steps = 0; steps < 200; steps++) {
    const next = await readZohoTicketScan(client, cursor);
    if (!next.next) throw new Error('Archive finished before mutation');
    cursor = next.next;
    if (cursor.stage === 'archives' && cursor.archive.offset === 100) break;
  }
  fake.fixture.tickets.unshift({ ...archived, id: '9999' });
  await expect(readZohoTicketScan(client, cursor)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it.each(['department', 'archived-state'] as const)(
  'refuses archive hydration after its %s changes',
  async (change) => {
    const { client } = zohoTestConnection(fake);
    let cursor = initialZohoTicketScan();
    while (cursor.stage !== 'archives' || !cursor.archive.ids.length) {
      const next = await readZohoTicketScan(client, cursor);
      if (!next.next) throw new Error('Missing archive checkpoint');
      cursor = next.next;
    }
    const archived = fake.fixture.tickets?.find((ticket) => ticket.id === '9007199254740993003');
    if (!archived) throw new Error('Missing archived ticket');
    if (change === 'department') archived.departmentId = '9007199254740993402';
    else archived.isArchived = false;
    await expect(collectAsync(exportZohoTickets(client, cursor))).rejects.toMatchObject({
      code: 'invalid-response',
    });
  },
);

it.each([429, 503])('preserves the archive checkpoint after HTTP %s', async (status) => {
  let now = 0;
  const { client } = zohoTestConnection(fake, { now: () => now });
  let cursor = initialZohoTicketScan();
  while (cursor.stage !== 'archives' || !cursor.archive.departmentIds.length) {
    const next = await readZohoTicketScan(client, cursor);
    if (!next.next) throw new Error('Missing archive checkpoint');
    cursor = next.next;
  }
  const snapshot = JSON.parse(JSON.stringify(cursor));
  fake.failNext({
    path: '/api/v1/tickets/archivedTickets',
    status,
    headers: { 'Retry-After': '2' },
  });
  await expect(readZohoTicketScan(client, cursor)).rejects.toMatchObject(
    status === 429 ? { retryAfterMs: 2000 } : { code: 'vendor-unavailable' },
  );
  expect(cursor).toEqual(snapshot);
  now += 2000;
  const records = (await collectAsync(exportZohoTickets(client, snapshot))).flatMap(
    (page) => page.records,
  );
  expect(records.map((record) => record.payload.externalId)).toEqual(['9007199254740993003']);
});
