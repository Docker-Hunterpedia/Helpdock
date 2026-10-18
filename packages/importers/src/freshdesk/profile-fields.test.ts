import { expect, it } from 'vitest';
import { freshdeskContactSchema } from './contracts.js';
import { freshdeskContactRecord } from './people-export.js';
import { freshdeskProfileFields, freshdeskProfileValues } from './profile-fields.js';

it('keeps address, social data and additional company history under explicit field-mapper choices', () => {
  const contact = freshdeskContactSchema.parse({
    id: 1,
    name: 'Source customer',
    active: true,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-02T00:00:00Z',
    address: 'Original address',
    job_title: 'Engineer',
    view_all_tickets: true,
    other_companies: [{ company_id: 11, view_all_tickets: true }],
    tags: ['customer', 'priority'],
    social_handler: [{ platform: 'twitter', handle: 'example' }],
    devices: [{ device_type: 'web', device_model: 'Safari' }],
    custom_fields: { cf_region: 'north' },
  });
  const record = freshdeskContactRecord(contact);
  expect(record).toMatchObject({
    entity: 'contact',
    payload: {
      custom: {
        cf_region: 'north',
        freshdesk_address: 'Original address',
        freshdesk_job_title: 'Engineer',
        freshdesk_view_all_tickets: true,
        freshdesk_other_companies: '[{"company_id":11,"view_all_tickets":true}]',
        freshdesk_tags: '["customer","priority"]',
        freshdesk_social_handler: '[{"handle":"example","platform":"twitter"}]',
        freshdesk_devices: '[{"device_model":"Safari","device_type":"web"}]',
      },
    },
  });
  expect(record.payload).not.toHaveProperty('view_all_tickets');
  const fields = freshdeskProfileFields('contact');
  expect(fields).toContainEqual({
    entity: 'field',
    payload: {
      externalId: 'contact:native:view_all_tickets',
      target: 'contact',
      key: 'freshdesk_view_all_tickets',
      label: 'view_all_tickets',
      type: 'checkbox',
    },
  });
  expect(fields).toContainEqual({
    entity: 'field',
    payload: {
      externalId: 'contact:native:other_companies',
      target: 'contact',
      key: 'freshdesk_other_companies',
      label: 'other_companies',
      type: 'text',
    },
  });
});

it('does not turn a vendor object-key reorder into a changed projected field', () => {
  expect(
    freshdeskProfileValues(
      'contact',
      { social_handler: [{ platform: 'twitter', handle: 'example' }] },
      {},
    ),
  ).toEqual(
    freshdeskProfileValues(
      'contact',
      { social_handler: [{ handle: 'example', platform: 'twitter' }] },
      {},
    ),
  );
});

it('keeps company-specific native fields and source date strings unchanged', () => {
  expect(
    freshdeskProfileValues(
      'organization',
      {
        health_score: 'Happy',
        account_tier: 'Premium',
        renewal_date: '2027-10-17',
        industry: 'Education',
      },
      { cf_market: 'mena' },
    ),
  ).toEqual({
    cf_market: 'mena',
    freshdesk_health_score: 'Happy',
    freshdesk_account_tier: 'Premium',
    freshdesk_renewal_date: '2027-10-17',
    freshdesk_industry: 'Education',
  });
  expect(freshdeskProfileFields('organization')).toContainEqual({
    entity: 'field',
    payload: {
      externalId: 'organization:native:renewal_date',
      target: 'organization',
      key: 'freshdesk_renewal_date',
      label: 'renewal_date',
      type: 'date',
    },
  });
});

it('refuses native/custom key collisions and omits missing values while preserving explicit false', () => {
  expect(() =>
    freshdeskProfileValues(
      'contact',
      { address: 'Native value' },
      { freshdesk_address: 'Custom value' },
    ),
  ).toThrow('invalid-response');
  expect(
    freshdeskProfileValues(
      'contact',
      { address: null, tags: [], devices: undefined, job_title: '', view_all_tickets: false },
      {},
    ),
  ).toEqual({ freshdesk_view_all_tickets: false });
});
