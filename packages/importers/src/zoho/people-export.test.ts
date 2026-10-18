import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
import { zohoAccountSchema } from './people-contracts.js';
import {
  exportZohoAgents,
  exportZohoDepartments,
  exportZohoProfiles,
  zohoAccountRecord,
} from './people-export.js';
import { zohoNativeFields, zohoNativeValues } from './profile-fields.js';
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

it('hydrates full contact details with primary/secondary identities, company links, original dates and native/custom fields', async () => {
  const { client } = zohoTestConnection(fake);
  const records = (await collectAsync(exportZohoProfiles(client, 'contact', null))).flatMap(
    (page) => page.records,
  );
  expect(records).toEqual([
    expect.objectContaining({
      entity: 'contact',
      payload: expect.objectContaining({
        externalId: '9007199254740993201',
        name: 'Original Customer',
        emails: ['customer@example.test', 'alternate@example.test'],
        phones: ['+15550000001', '+15550000002'],
        organizationExternalId: '9007199254740993501',
        description: 'Original full contact history',
        createdAt: '2013-11-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        custom: expect.objectContaining({
          cf_plan: 'Original plan',
          zoho_street: 'Original address',
          zoho_isDeleted: false,
          zoho_zohoCRMContact: '{"id":"9007199254740993991","type":"contacts_leads"}',
        }),
      }),
    }),
    expect.objectContaining({
      entity: 'contact',
      payload: expect.objectContaining({
        externalId: '9007199254740993202',
        name: 'Original Copy recipient',
        emails: ['cc@example.test'],
        organizationExternalId: '9007199254740993501',
        description: 'Original secondary ticket participant',
      }),
    }),
  ]);
  expect(fake.calls.some((call) => call.path === '/api/v1/contacts/9007199254740993201')).toBe(
    true,
  );
});

it('retains company metadata without treating a website as verified domain ownership or applying a source SLA', async () => {
  const { client } = zohoTestConnection(fake);
  const records = (await collectAsync(exportZohoProfiles(client, 'organization', null))).flatMap(
    (page) => page.records,
  );
  expect(records[0]).toMatchObject({
    entity: 'organization',
    payload: {
      name: 'Original company',
      domains: [],
      description: 'Original full company history',
      custom: {
        cf_tier: 'Original tier',
        zoho_website: 'www.company.example',
        zoho_annualrevenue: '12345.67',
        zoho_associatedSLAIds: '["9007199254740993881"]',
      },
    },
  });
});

it('reads every agent state and disabled departments as mapping data without carrying source role permissions into local roles', async () => {
  const { client } = zohoTestConnection(fake);
  const agents = (await collectAsync(exportZohoAgents(client, null))).flatMap(
    (page) => page.records,
  );
  expect(agents).toHaveLength(4);
  expect(agents.map((record) => (record.entity === 'user' ? record.payload.active : null))).toEqual(
    [true, false, false, false],
  );
  expect(agents[2]).toMatchObject({
    entity: 'user',
    payload: {
      externalId: '9007199254740993303',
      active: false,
      email: 'agent3@example.test',
      role: 'Admin',
      groups: ['9007199254740993401', '9007199254740993402'],
    },
  });
  const departments = (await collectAsync(exportZohoDepartments(client, null))).flatMap(
    (page) => page.records,
  );
  expect(departments).toHaveLength(2);
  expect(departments[1]).toMatchObject({
    entity: 'group',
    payload: { externalId: '9007199254740993402', name: 'Disabled legacy support' },
  });
});

it('passes the 200-record boundary before switching agent states or department visibility', async () => {
  const sourceAgent = zohoCoreFixture.agents[0];
  if (!sourceAgent) throw new Error('Missing agent fixture');
  fake.fixture.agents = Array.from({ length: 201 }, (_, index) => ({
    ...sourceAgent,
    id: String(10000 + index),
  }));
  fake.fixture.departments = [
    ...Array.from({ length: 201 }, (_, index) => ({
      id: String(20000 + index),
      name: `Department ${index}`,
      isEnabled: true,
    })),
    { id: '30000', name: 'Historical disabled department', isEnabled: false },
  ];
  const { client } = zohoTestConnection(fake);
  const agents = (await collectAsync(exportZohoAgents(client, null))).flatMap(
    (page) => page.records,
  );
  expect(agents.map((record) => record.payload.externalId)).toEqual(
    fake.fixture.agents.map((agent) => agent.id),
  );
  const departments = (await collectAsync(exportZohoDepartments(client, null))).flatMap(
    (page) => page.records,
  );
  expect(departments.map((record) => record.payload.externalId)).toEqual(
    fake.fixture.departments.map((department) => department.id),
  );
});

it('refuses a profile detail that does not match the native ID supplied by its saved list', async () => {
  const contact = zohoCoreFixture.contacts[0];
  if (!contact) throw new Error('Missing contact fixture');
  fake.failNext({
    path: `/api/v1/contacts/${contact.id}`,
    status: 200,
    json: { ...contact, id: '999999' },
  });
  const { client } = zohoTestConnection(fake);
  await expect(collectAsync(exportZohoProfiles(client, 'contact', null))).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('resumes a 101-contact snapshot after an interrupted detail without skipping the next page', async () => {
  const original = zohoCoreFixture.contacts[0];
  if (!original) throw new Error('Missing source contact');
  fake.fixture.contacts = Array.from({ length: 101 }, (_, index) => ({
    ...original,
    id: String(10000 + index),
    email: `contact${index}@example.test`,
    secondaryEmail: null,
  }));
  const { client } = zohoTestConnection(fake);
  let cursor: ImportCursor | null = null;
  const committed: string[] = [];
  for await (const page of exportZohoProfiles(client, 'contact', null)) {
    cursor = page.cursor;
    committed.push(...page.records.map((record) => record.payload.externalId));
    if (committed.length === 17) break;
  }
  const resumed = zohoTestConnection(fake);
  const remaining = (
    await collectAsync(
      exportZohoProfiles(resumed.client, 'contact', JSON.parse(JSON.stringify(cursor))),
    )
  ).flatMap((page) => page.records.map((record) => record.payload.externalId));
  expect([...committed, ...remaining]).toEqual(fake.fixture.contacts.map((contact) => contact.id));
});

it('retains accessible deleted source profiles with explicit flags and a review warning, without requesting deletion', async () => {
  const contact = fake.fixture.contacts?.[0];
  if (!contact) throw new Error('Missing source contact');
  contact.isDeleted = true;
  const log = vi.fn();
  const { client } = zohoTestConnection(fake, { log });
  const records = (await collectAsync(exportZohoProfiles(client, 'contact', null))).flatMap(
    (page) => page.records,
  );
  expect(records[0]).toMatchObject({
    entity: 'contact',
    payload: { custom: { zoho_isDeleted: true } },
  });
  expect(log).toHaveBeenCalledWith({
    entity: 'contact',
    externalId: contact.id,
    level: 'warning',
    message: 'import.profile.inactive-source',
  });
  expect(fake.calls.every((call) => call.method === 'GET' || call.path === '/oauth/v2/token')).toBe(
    true,
  );
});

it('keeps native field identities explicit, rejects collisions and does not change compound values when object keys are reordered', () => {
  expect(zohoNativeFields('organization')).toContainEqual({
    entity: 'field',
    payload: {
      externalId: 'organization:native:associatedSLAIds',
      target: 'organization',
      key: 'zoho_associatedSLAIds',
      label: 'associatedSLAIds',
      type: 'text',
    },
  });
  expect(
    zohoNativeValues(
      'contact',
      { zohoCRMContact: { id: '123', type: 'contacts' }, isDeleted: false },
      {},
    ),
  ).toEqual(
    zohoNativeValues(
      'contact',
      { isDeleted: false, zohoCRMContact: { type: 'contacts', id: '123' } },
      {},
    ),
  );
  expect(() =>
    zohoNativeValues('contact', { street: 'Native street' }, { zoho_street: 'Conflicting field' }),
  ).toThrow('invalid-response');
});

it('keeps numeric metadata as text without permitting rounded numeric native IDs', () => {
  const account = zohoCoreFixture.accounts[0];
  expect(
    zohoAccountRecord(zohoAccountSchema.parse({ ...account, annualrevenue: 19.5 })),
  ).toMatchObject({
    entity: 'organization',
    payload: { custom: { zoho_annualrevenue: '19.5' } },
  });
  expect(
    zohoAccountSchema.safeParse({ ...account, associatedSLAIds: [Number.MAX_SAFE_INTEGER + 1] })
      .success,
  ).toBe(false);
});
