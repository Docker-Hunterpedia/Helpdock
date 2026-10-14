import type { ZendeskFixture } from './fake-zendesk.js';

export const zendeskCoreFixture: ZendeskFixture = {
  tickets: [
    {
      id: 101,
      subject: 'Original question',
      status: 'pending',
      custom_status_id: 701,
      priority: 'normal',
      requester_id: 201,
      assignee_id: 301,
      group_id: 501,
      organization_id: 401,
      email_cc_ids: [202],
      tags: ['migration'],
      custom_fields: [{ id: 801, value: 'north' }],
      created_at: '2020-01-01T10:00:00Z',
      updated_at: '2020-01-02T10:00:00Z',
      via: { channel: 'email' },
    },
  ],
  users: [
    {
      id: 201,
      name: 'Original customer',
      email: 'customer@example.invalid',
      role: 'end-user',
      phone: '+15551234567',
      suspended: false,
      updated_at: '2020-01-02T10:00:00Z',
    },
    {
      id: 202,
      name: 'Original CC',
      email: 'cc@example.invalid',
      role: 'end-user',
      suspended: false,
      updated_at: '2020-01-02T10:00:00Z',
    },
    {
      id: 301,
      name: 'Original agent',
      email: 'agent@example.invalid',
      role: 'admin',
      suspended: true,
      updated_at: '2020-01-02T10:00:00Z',
    },
  ],
  organizations: [
    {
      id: 401,
      name: 'Original company',
      domain_names: ['example.invalid', 'other.invalid'],
      notes: 'Account note',
      details: 'Original description',
      organization_fields: { region: 'north' },
      created_at: '2019-01-01T00:00:00Z',
      updated_at: '2020-01-02T10:00:00Z',
    },
  ],
  groups: [{ id: 501, name: 'Original support team' }],
  identities: {
    '201': [
      {
        id: 601,
        type: 'email',
        value: 'customer@example.invalid',
        primary: true,
        verification_method: 'full',
      },
      {
        id: 602,
        type: 'email',
        value: 'secondary@example.invalid',
        primary: false,
        verification_method: 'none',
      },
      { id: 603, type: 'twitter', value: 'original-handle', verification_method: 'low' },
    ],
    '301': [],
    '202': [],
  },
};
