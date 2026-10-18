import type { FreshdeskFixture } from './fake-freshdesk.js';

const created_at = '2020-01-01T10:00:00Z';
export const freshdeskCoreFixture: FreshdeskFixture = {
  tickets: [1, 2, 3].map((id) => ({
    id,
    subject: `Historical ticket ${id}`,
    status: 2,
    priority: id,
    source: 1,
    requester_id: 201,
    responder_id: 301,
    group_id: 401,
    company_id: 501,
    created_at,
    updated_at: `2020-01-0${id + 1}T10:00:00Z`,
    description: '<p>Original question</p>',
    description_text: 'Original question',
    cc_emails: ['cc@example.test'],
    tags: ['history'],
    custom_fields: { cf_region: 'north' },
  })),
  contacts: [
    {
      id: 201,
      name: 'Original customer',
      active: true,
      email: 'customer@example.test',
      other_emails: ['alternate@example.test', 'customer@example.test'],
      phone: '+15550000001',
      mobile: '+15550000002',
      language: 'ar',
      time_zone: 'Asia/Riyadh',
      unique_external_id: 'crm-201',
      description: 'Original customer details',
      custom_fields: { cf_tier: 'gold' },
      company_id: 501,
      created_at,
      updated_at: created_at,
    },
  ],
  agents: [
    {
      id: 301,
      ticket_scope: 1,
      group_ids: [401],
      role_ids: [1],
      type: 'support_agent',
      contact: {
        name: 'Former agent',
        active: false,
        email: 'agent@example.test',
        created_at,
        updated_at: created_at,
      },
      created_at,
      updated_at: created_at,
    },
  ],
  companies: [
    {
      id: 501,
      name: 'Source company',
      domains: ['example.test'],
      created_at,
      updated_at: created_at,
    },
  ],
  groups: [{ id: 401, name: 'Billing' }],
  conversations: {
    '1': [
      {
        id: 1001,
        ticket_id: 1,
        user_id: 301,
        incoming: false,
        private: true,
        body: '<p>Internal historical note</p>',
        created_at,
        updated_at: created_at,
      },
    ],
  },
};
