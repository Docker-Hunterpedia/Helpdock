import { zendeskCoreFixture } from './core-fixture.js';
import type { ZendeskFixture } from './fake-zendesk.js';

export const zendeskReferenceMedia = Buffer.from(
  '%PDF-1.7\nSynthetic migration reference attachment\n%%EOF\n',
);

/** Synthetic documented Support rows plus the core bilingual Guide fixture; no customer data. */
export function zendeskReferenceFixture(attachmentRoot: string): ZendeskFixture {
  const ticket = zendeskCoreFixture.tickets?.[0];
  const company = zendeskCoreFixture.organizations?.[0];
  if (!ticket || !company) throw new Error('Missing Zendesk reference templates');
  const tickets = Array.from({ length: 500 }, (_, index) => {
    const id = 101 + index;
    const created = new Date(Date.UTC(2018 + (index % 5), index % 12, 1, 10));
    return {
      ...ticket,
      id,
      subject: `Reference ticket ${id}`,
      status: index >= 400 ? 'closed' : 'pending',
      custom_status_id: index >= 400 ? null : 701,
      requester_id: 20001 + index,
      organization_id: 401 + (index % 10),
      group_id: 501 + (index % 5),
      priority: ['low', 'normal', 'high', 'urgent'][index % 4],
      tags: ['migration', `team-${index % 5}`],
      created_at: created.toISOString(),
      updated_at: new Date(created.getTime() + 2 * 86400000).toISOString(),
    };
  });
  const customers = tickets.map((source, index) => ({
    id: 20001 + index,
    name: `Customer ${index}`,
    email: `customer-${index}@example.invalid`,
    role: 'end-user',
    suspended: false,
    organization_id: source.organization_id,
    notes: `Original contact note ${index}`,
    details: `Original contact description ${index}`,
    locale: index % 2 ? 'ar' : 'en-US',
    iana_time_zone: 'Asia/Damascus',
    user_fields: { plan: `plan-${index}` },
    created_at: source.created_at,
    updated_at: source.updated_at,
  }));
  const comments = Object.fromEntries(
    tickets.map((source, index) => [
      String(source.id),
      [
        {
          id: source.id * 100 + 1,
          author_id: source.requester_id,
          public: true,
          html_body: `<p>Original question ${index}</p>`,
          plain_body: `Original question ${index}`,
          created_at: source.created_at,
          attachments: [
            {
              id: source.id * 100 + 3,
              file_name: `reference-${source.id}.pdf`,
              content_type: 'application/pdf',
              size: zendeskReferenceMedia.length,
              content_url: `${attachmentRoot}/attachments/token/${source.id * 100 + 3}/file`,
            },
          ],
        },
        {
          id: source.id * 100 + 2,
          author_id: 301,
          public: false,
          html_body: `<p>Private note ${index}</p>`,
          plain_body: `Private note ${index}`,
          created_at: new Date(Date.parse(source.created_at) + 86400000).toISOString(),
          attachments: [],
        },
      ],
    ]),
  );
  const audits = Object.fromEntries(
    tickets.map((source) => [
      String(source.id),
      [
        {
          id: source.id * 1000,
          ticket_id: source.id,
          author_id: 301,
          created_at: source.updated_at,
          events: [
            {
              id: source.id * 1000 + 1,
              type: 'Change',
              field_name: 'status',
              previous_value: 'open',
              value: source.status,
            },
          ],
          metadata: { custom: { original_source: 'synthetic-reference' } },
          via: { channel: 'web' },
        },
      ],
    ]),
  );
  const identities = Object.fromEntries(
    customers.map((source) => [
      String(source.id),
      [
        {
          id: source.id * 10,
          type: 'email',
          value: source.email,
          primary: true,
          verification_method: 'full',
        },
        {
          id: source.id * 10 + 1,
          type: 'email',
          value: `secondary-${source.id}@example.invalid`,
          primary: false,
          verification_method: 'none',
        },
      ],
    ]),
  );
  return {
    ...structuredClone(zendeskCoreFixture),
    tickets,
    users: [...(zendeskCoreFixture.users ?? []), ...customers],
    organizations: Array.from({ length: 10 }, (_, index) => ({
      ...company,
      id: 401 + index,
      name: `Reference company ${index}`,
      domain_names: [`company-${index}.example.invalid`],
      notes: `Company note ${index}`,
    })),
    groups: Array.from({ length: 5 }, (_, index) => ({
      id: 501 + index,
      name: `Reference group ${index}`,
    })),
    comments,
    audits,
    identities: { ...zendeskCoreFixture.identities, ...identities },
    satisfaction_ratings: tickets.map((source) => ({
      id: source.id * 10,
      ticket_id: source.id,
      score: 'good',
      comment: `Feedback ${source.id}`,
      created_at: source.updated_at,
      updated_at: source.updated_at,
      assignee_id: 301,
      requester_id: source.requester_id,
      group_id: source.group_id,
    })),
    survey_responses: [],
  };
}

export function zendeskReferenceDelta(fixture: ZendeskFixture): ZendeskFixture {
  const updatedAt = '2026-10-15T00:00:10Z';
  return {
    ...fixture,
    tickets: fixture.tickets?.map((ticket) =>
      ticket.id === 101
        ? {
            ...ticket,
            subject: 'Delta subject',
            status: 'solved',
            custom_status_id: null,
            updated_at: updatedAt,
          }
        : ticket,
    ),
    users: fixture.users?.map((user) =>
      user.id === 20001 ? { ...user, notes: 'Delta contact note', updated_at: updatedAt } : user,
    ),
    organizations: fixture.organizations?.map((company) =>
      company.id === 401
        ? { ...company, notes: 'Delta company note', updated_at: updatedAt }
        : company,
    ),
    comments: {
      ...fixture.comments,
      '101': [
        ...(fixture.comments?.['101'] ?? []),
        {
          id: 10104,
          author_id: 301,
          public: false,
          body: 'Delta internal note',
          created_at: updatedAt,
          attachments: [],
        },
      ],
    },
    audits: {
      ...fixture.audits,
      '101': [
        ...(fixture.audits?.['101'] ?? []),
        {
          id: 999999,
          ticket_id: 101,
          author_id: 301,
          created_at: updatedAt,
          events: [
            {
              id: 999998,
              type: 'Change',
              field_name: 'status',
              previous_value: 'pending',
              value: 'solved',
            },
          ],
        },
      ],
    },
    satisfaction_ratings: fixture.satisfaction_ratings?.map((rating) =>
      rating.ticket_id === 101
        ? { ...rating, comment: 'Corrected old feedback', updated_at: updatedAt }
        : rating,
    ),
  };
}
