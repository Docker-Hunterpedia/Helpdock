import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectAsync } from '../testing/collect.js';
import { zohoCustomValues } from './field-values.js';
import { exportZohoFields, readZohoFields } from './fields-export.js';
import { exportZohoProfiles } from './people-export.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho(structuredClone(zohoCoreFixture));
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

it('reads the documented all-fields envelope for each module without inventing pagination', async () => {
  const { client } = zohoTestConnection(fake);
  const records = (await collectAsync(exportZohoFields(client, null))).flatMap(
    (page) => page.records,
  );
  expect(records).toEqual(
    expect.arrayContaining([
      {
        entity: 'field',
        payload: {
          externalId: 'ticket:9007199254740993701',
          target: 'ticket',
          key: 'cf_plan',
          label: 'Original plan',
          type: 'text',
        },
      },
      expect.objectContaining({
        entity: 'field',
        payload: expect.objectContaining({ target: 'organization', key: 'cf_tier' }),
      }),
      expect.objectContaining({
        entity: 'field',
        payload: expect.objectContaining({ target: 'contact', key: 'zoho_street' }),
      }),
    ]),
  );
  expect(fake.calls.filter((call) => call.path === '/api/v1/fields')).toHaveLength(3);
});

it('normalizes checkboxes, integral numbers, exact dates and array selections without guessing delimiters', async () => {
  fake.fixture.fields = {
    tickets: [
      field('1', 'cf_flag', 'Checkbox'),
      field('2', 'cf_count', 'Number'),
      field('3', 'cf_day', 'Date'),
      {
        ...field('4', 'cf_choices', 'Multiselect'),
        allowedValues: [{ value: 'One, Two' }, { value: 'Three' }],
      },
    ],
  };
  const catalog = await readZohoFields(zohoTestConnection(fake).client, 'ticket');
  expect(
    zohoCustomValues(catalog, {
      cf_flag: 'false',
      cf_count: '12',
      cf_day: '2020-02-29',
      cf_choices: ['One, Two', 'Three'],
    }),
  ).toEqual({
    cf_flag: false,
    cf_count: 12,
    cf_day: '2020-02-29',
    cf_choices: ['One, Two', 'Three'],
  });
  for (const custom of [
    { cf_flag: 'yes' },
    { cf_count: '9007199254740993' },
    { cf_day: '2020-02-30' },
    { cf_choices: 'One, Two,Three' },
    { cf_choices: ['Unknown'] },
    { cf_missing: 'unknown field' },
  ])
    expect(() => zohoCustomValues(catalog, custom)).toThrow();
});

it('preserves currency precision, timezone-bearing source timestamps and structured lookup IDs as text with a review warning', async () => {
  fake.fixture.fields = {
    tickets: [
      field('1', 'cf_money', 'Currency'),
      field('2', 'cf_when', 'DateTime'),
      field('3', 'cf_lookup', 'LookUp'),
    ],
  };
  const log = vi.fn(async () => {});
  const catalog = await readZohoFields(zohoTestConnection(fake, { log }).client, 'ticket');
  expect(catalog.map((item) => item.payload.type)).toEqual(['text', 'text', 'text']);
  expect(
    zohoCustomValues(catalog, {
      cf_money: '9007199254740993.012345',
      cf_when: '2020-01-01T12:00:00+03:00',
      cf_lookup: { name: 'Original', id: '9007199254740993' },
    }),
  ).toEqual({
    cf_money: '9007199254740993.012345',
    cf_when: '2020-01-01T12:00:00+03:00',
    cf_lookup: '{"id":"9007199254740993","name":"Original"}',
  });
  expect(log).toHaveBeenCalledTimes(3);
  expect(() =>
    zohoCustomValues(catalog, { cf_lookup: { id: Number.MAX_SAFE_INTEGER + 1 } }),
  ).toThrow();
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ level: 'warning', message: 'import.field.unsupported-semantics' }),
  );
});

it('uses metadata normalization in hydrated profiles, preserving explicit false and null', async () => {
  fake.fixture.fields = { contacts: [field('1', 'cf_flag', 'Boolean')] };
  fake.fixture.contacts![0]!.cf = { cf_flag: 'false' };
  const records = (
    await collectAsync(exportZohoProfiles(zohoTestConnection(fake).client, 'contact', null))
  ).flatMap((page) => page.records);
  expect(records[0]).toMatchObject({ payload: { custom: { cf_flag: false } } });
  const catalog = await readZohoFields(zohoTestConnection(fake).client, 'contact');
  expect(zohoCustomValues(catalog, { cf_flag: null })).toEqual({ cf_flag: null });
});

it('refuses duplicate metadata keys rather than silently overwriting their definitions', async () => {
  fake.fixture.fields = { tickets: [field('1', 'cf_same', 'Text'), field('2', 'cf_same', 'Text')] };
  await expect(readZohoFields(zohoTestConnection(fake).client, 'ticket')).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('preserves large or empty choice catalogs as text with a review warning', async () => {
  fake.fixture.fields = {
    tickets: [
      {
        ...field('1', 'cf_many', 'Picklist'),
        allowedValues: Array.from({ length: 51 }, (_, index) => ({ value: `Option ${index}` })),
      },
      { ...field('2', 'cf_empty', 'PickList'), allowedValues: [] },
    ],
  };
  const log = vi.fn(async () => {});
  const catalog = await readZohoFields(zohoTestConnection(fake, { log }).client, 'ticket');
  expect(catalog.map((item) => item.payload.type)).toEqual(['text', 'text']);
  expect(zohoCustomValues(catalog, { cf_many: 'Option 50', cf_empty: 'Historical value' })).toEqual(
    { cf_many: 'Option 50', cf_empty: 'Historical value' },
  );
  expect(log).toHaveBeenCalledTimes(2);
});

it('checkpoints large catalogs in bounded pages and refuses changed definitions on resume', async () => {
  fake.fixture.fields = {
    tickets: Array.from({ length: 1010 }, (_, index) =>
      field(String(index + 1), `cf_${index}`, 'Text'),
    ),
  };
  const { client } = zohoTestConnection(fake);
  const iterator = exportZohoFields(client, null);
  const first = await iterator.next();
  expect(first.value?.records).toHaveLength(500);
  await iterator.return(undefined);
  const checkpoint = JSON.parse(JSON.stringify(first.value?.cursor));
  const remainder = await collectAsync(exportZohoFields(client, checkpoint));
  expect(remainder.every((page) => page.records.length <= 500)).toBe(true);
  const ticketFields = [
    ...first.value!.records,
    ...remainder.flatMap((page) => page.records),
  ].filter((record) => record.entity === 'field' && record.payload.target === 'ticket');
  expect(new Set(ticketFields.map((record) => record.payload.externalId)).size).toBe(1013);
  fake.fixture.fields.tickets![0]!.displayLabel = 'Changed source definition';
  await expect(collectAsync(exportZohoFields(client, checkpoint))).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

function field(id: string, apiName: string, type: string) {
  return { id, apiName, type, displayLabel: apiName, isCustomField: true, isEncryptedField: false };
}
