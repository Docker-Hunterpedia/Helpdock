import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectAsync } from '../testing/collect.js';
import { FreshdeskClient } from './client.js';
import { exportFreshdeskFields } from './fields-export.js';
import { freshdeskTestContext } from './testing/context.js';
import { FakeFreshdesk, type FreshdeskFixture } from './testing/fake-freshdesk.js';

let fake: FakeFreshdesk;
let client: FreshdeskClient;
const log = vi.fn(async () => {});
const fixture: FreshdeskFixture = {
  ticket_fields: [
    {
      id: 1,
      name: 'status',
      label: 'Status',
      type: 'default_status',
      default: true,
      choices: { '2': ['Open', 'Open'] },
    },
    { id: 2, name: 'cf_amount', label: 'Amount', type: 'custom_decimal' },
    {
      id: 3,
      name: 'cf_region',
      label: 'Region',
      type: 'custom_dropdown',
      choices: ['north', 'south'],
    },
    {
      id: 4,
      name: 'cf_country',
      label: 'Country',
      type: 'nested_field',
      nested_ticket_fields: [
        { id: 41, name: 'cf_state', label: 'State', level: 2 },
        { id: 42, name: 'cf_city', label: 'City', level: 3 },
      ],
      choices: [{ usa: [{ texas: ['austin'] }] }],
    },
  ],
  contact_fields: [
    {
      id: 2,
      name: 'cf_tier',
      label: 'Tier',
      type: 'custom_dropdown',
      choices: [
        { id: 1, value: 'gold', label: 'Gold', position: 1 },
        { id: 2, value: 'silver', label: 'Silver', position: 2 },
      ],
    },
  ],
  company_fields: [{ id: 2, name: 'cf_renewal', label: 'Renewal', type: 'custom_date' }],
};
beforeEach(async () => {
  log.mockClear();
  fake = new FakeFreshdesk(fixture, {
    authorization: `Basic ${Buffer.from('synthetic-key:X').toString('base64')}`,
    now: 0,
    pageSize: 2,
  });
  await fake.server.start();
  client = new FreshdeskClient(freshdeskTestContext(fake, log), fake.server.root);
});
afterEach(async () => {
  await fake.server.close();
});

it('keeps field namespaces, source keys and both documented choice shapes while skipping built-in definitions', async () => {
  const pages = await collectAsync(exportFreshdeskFields(client, null));
  const records = pages.flatMap((page) => page.records);
  expect(
    records.map((record) => record.payload.externalId).filter((id) => !id.includes(':native:')),
  ).toEqual([
    'ticket:2',
    'ticket:3',
    'ticket:4',
    'ticket:4:nested:41',
    'ticket:4:nested:42',
    'contact:2',
    'organization:2',
  ]);
  expect(records).toContainEqual({
    entity: 'field',
    payload: {
      externalId: 'contact:2',
      target: 'contact',
      key: 'cf_tier',
      label: 'Tier',
      type: 'select',
      options: [
        { value: 'gold', label: 'Gold' },
        { value: 'silver', label: 'Silver' },
      ],
    },
  });
  expect(records).toContainEqual({
    entity: 'field',
    payload: {
      externalId: 'ticket:4:nested:42',
      target: 'ticket',
      key: 'cf_city',
      label: 'City',
      type: 'text',
    },
  });
  expect(log).toHaveBeenCalledWith({
    level: 'warning',
    entity: 'field',
    externalId: 'ticket:4',
    message: 'import.field.unsupported-semantics',
  });
  expect(
    fake.server.calls.some(
      (call) => call.path === '/api/v2/ticket_fields' && call.query.page === '2',
    ),
  ).toBe(true);
});

it('resumes at the next collection/page with no replay of prior field definitions', async () => {
  const iterator = exportFreshdeskFields(client, null);
  const first = await iterator.next();
  await iterator.return(undefined);
  const resumed = await collectAsync(exportFreshdeskFields(client, first.value?.cursor ?? null));
  expect(
    resumed
      .flatMap((page) => page.records)
      .some((record) => record.payload.externalId === 'ticket:2'),
  ).toBe(false);
  expect(
    resumed
      .flatMap((page) => page.records)
      .some((record) => record.payload.externalId === 'organization:2'),
  ).toBe(true);
});

it('preserves dropdown values through a text mapping proposal when the source option set exceeds the destination limit', async () => {
  fake.replaceFixture({
    ticket_fields: [
      {
        id: 5,
        name: 'cf_large',
        label: 'Large choice set',
        type: 'custom_dropdown',
        choices: Array.from({ length: 51 }, (_, index) => `value-${index}`),
      },
    ],
  });
  const pages = await collectAsync(exportFreshdeskFields(client, null));
  expect(pages[0]?.records).toEqual([
    {
      entity: 'field',
      payload: {
        externalId: 'ticket:5',
        target: 'ticket',
        key: 'cf_large',
        label: 'Large choice set',
        type: 'text',
      },
    },
  ]);
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      externalId: 'ticket:5',
      message: 'import.field.unsupported-semantics',
    }),
  );
});

it('refuses an unknown field type with a source warning instead of silently dropping the field', async () => {
  fake.replaceFixture({
    ticket_fields: [{ id: 9, name: 'cf_unknown', label: 'Future type', type: 'future_type' }],
  });
  await expect(collectAsync(exportFreshdeskFields(client, null))).rejects.toMatchObject({
    code: 'invalid-response',
  });
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'ticket:9' }));
});
