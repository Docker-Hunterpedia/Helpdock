import { freshdeskCoreFixture } from './core-fixture.js';
import type { FreshdeskFixture } from './fake-freshdesk.js';
import { freshdeskKnowledgeFixture } from './knowledge-fixture.js';

export const freshdeskReferenceMedia = Buffer.from(
  '%PDF-1.7\nSynthetic Freshdesk migration attachment\n%%EOF\n',
);

/** Native v2 wire rows, including archive-only tickets; no normalized record factories. */
export function freshdeskReferenceFixture(attachmentUrl: (id: number) => string): FreshdeskFixture {
  const tickets = Array.from({ length: 500 }, (_, index) => {
    const id = 10000 + index;
    const created = new Date(Date.UTC(2018 + (index % 5), index % 12, 1, 10));
    return {
      id,
      subject: `Freshdesk reference ${id}`,
      status: index >= 400 ? 5 : 2,
      priority: 1 + (index % 4),
      source: 1,
      requester_id: 20000 + (index % 49),
      responder_id: 301,
      group_id: 401 + (index % 5),
      company_id: 501 + ((index % 49) % 10),
      created_at: created.toISOString(),
      updated_at: new Date(created.getTime() + 2 * 86400000).toISOString(),
      description: `<p>Original question ${index}</p>`,
      description_text: `Original question ${index}`,
      cc_emails: ['freshdesk-copy@example.invalid'],
      tags: ['migration', `team-${index % 5}`],
      custom_fields: { cf_region: index % 2 ? 'south' : 'north' },
      archived: index >= 450,
      stats: {
        closed_at: index >= 400 ? new Date(created.getTime() + 2 * 86400000).toISOString() : null,
      },
      attachments: [
        {
          id: 30000 + index,
          name: `reference-${id}.pdf`,
          content_type: 'application/pdf',
          size: freshdeskReferenceMedia.length,
          attachment_url: attachmentUrl(30000 + index),
        },
      ],
    };
  });
  const contacts = tickets.slice(0, 49).map((ticket, index) => ({
    id: ticket.requester_id,
    name: `Freshdesk customer ${index}`,
    active: true,
    email: `freshdesk-customer-${index}@example.invalid`,
    other_emails: [`freshdesk-secondary-${index}@example.invalid`],
    phone: `+1415555${String(index).padStart(4, '0')}`,
    company_id: ticket.company_id,
    language: index % 2 ? 'ar' : 'en',
    description: `Original contact ${index}`,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    custom_fields: { cf_tier: `contact-plan-${index}` },
  }));
  const knowledge = structuredClone(freshdeskKnowledgeFixture);
  const original = knowledge.articles['702'][0];
  const arabic = knowledge.translations['article:801'].ar;
  if (!original || !arabic) throw new Error('Missing bilingual Freshdesk article templates');
  const articles = Array.from({ length: 20 }, (_, index) => ({
    ...original,
    id: 801 + index,
    title: `Original article ${index}`,
  }));
  const translations: NonNullable<FreshdeskFixture['translations']> = {
    ...knowledge.translations,
    ...Object.fromEntries(
      articles.map((article, index) => [
        `article:${article.id}`,
        { ar: { ...arabic, id: article.id, title: `المقال الأصلي ${index}` } },
      ]),
    ),
  };
  return {
    ...knowledge,
    folders: {
      '601': knowledge.folders['601'].map((folder) => ({
        ...folder,
        articles_count: folder.id === 702 ? 20 : 0,
      })),
    },
    articles: { '702': articles },
    translations,
    tickets,
    contacts: [
      ...contacts,
      {
        id: 29999,
        name: 'Freshdesk copy recipient',
        active: true,
        email: 'freshdesk-copy@example.invalid',
        created_at: '2013-11-01T00:00:00Z',
        updated_at: '2020-01-01T00:00:00Z',
      },
    ],
    agents: structuredClone(freshdeskCoreFixture.agents ?? []),
    companies: Array.from({ length: 10 }, (_, index) => ({
      id: 501 + index,
      name: `Freshdesk company ${index}`,
      domains: [`freshdesk-company-${index}.example.invalid`],
      description: `Original company ${index}`,
      note: `Original company note ${index}`,
      custom_fields: { cf_tier: `company-tier-${index}` },
      created_at: '2013-10-01T00:00:00Z',
      updated_at: '2020-01-01T00:00:00Z',
    })),
    groups: Array.from({ length: 5 }, (_, index) => ({
      id: 401 + index,
      name: `Freshdesk group ${index}`,
    })),
    ticket_fields: [
      {
        id: 801,
        name: 'cf_region',
        label: 'Region',
        type: 'custom_dropdown',
        choices: ['north', 'south'],
        default: false,
      },
    ],
    contact_fields: [
      { id: 802, name: 'cf_tier', label: 'Contact plan', type: 'custom_text', default: false },
    ],
    company_fields: [
      { id: 803, name: 'cf_tier', label: 'Company tier', type: 'custom_text', default: false },
    ],
    conversations: Object.fromEntries(
      tickets.map((ticket, index) => [
        String(ticket.id),
        [
          {
            id: 40000 + index,
            ticket_id: ticket.id,
            user_id: 301,
            incoming: false,
            private: false,
            body: `<p>Original agent reply ${index}</p>`,
            body_text: `Original agent reply ${index}`,
            from_email: 'agent@example.test',
            to_emails: [`freshdesk-customer-${index % 49}@example.invalid`],
            cc_emails: ['freshdesk-copy@example.invalid'],
            created_at: new Date(Date.parse(ticket.created_at) + 86400000).toISOString(),
            updated_at: ticket.updated_at,
            attachments: [],
          },
          {
            id: 50000 + index,
            ticket_id: ticket.id,
            user_id: 301,
            incoming: false,
            private: true,
            body: `<p>Original private note ${index}</p>`,
            body_text: `Original private note ${index}`,
            created_at: new Date(Date.parse(ticket.created_at) + 90000000).toISOString(),
            updated_at: ticket.updated_at,
            attachments: [],
          },
          {
            id: 70000 + index,
            ticket_id: ticket.id,
            user_id: ticket.requester_id,
            incoming: true,
            private: false,
            body: `<p>Original customer follow-up ${index}</p>`,
            body_text: `Original customer follow-up ${index}`,
            from_email: `freshdesk-customer-${index % 49}@example.invalid`,
            to_emails: ['support@example.test'],
            created_at: new Date(Date.parse(ticket.created_at) + 93000000).toISOString(),
            updated_at: ticket.updated_at,
            attachments: [],
          },
        ],
      ]),
    ),
    satisfaction_ratings: tickets.map((ticket, index) => ({
      id: 60000 + index,
      ticket_id: ticket.id,
      survey_id: 701,
      user_id: ticket.requester_id,
      agent_id: 301,
      group_id: ticket.group_id,
      feedback: `Original feedback ${index}`,
      ratings: { default_question: index % 3 === 0 ? 1 : index % 3 === 1 ? 2 : 3 },
      created_at: ticket.updated_at,
      updated_at: ticket.updated_at,
    })),
  };
}

/** Changes include an old archive and an old rating; creation-time filters must not hide either. */
export function freshdeskReferenceDelta(
  fixture: FreshdeskFixture,
  changedAt: string,
): FreshdeskFixture {
  const conversations = { ...fixture.conversations };
  for (const id of [10000, 10499])
    conversations[String(id)] = [
      ...(conversations[String(id)] ?? []),
      {
        id: 90000 + id,
        ticket_id: id,
        user_id: 301,
        incoming: false,
        private: true,
        body: `<p>Delta note ${id}</p>`,
        body_text: `Delta note ${id}`,
        created_at: changedAt,
        updated_at: changedAt,
        attachments: [],
      },
    ];
  return {
    ...fixture,
    conversations,
    tickets: (fixture.tickets ?? []).map((ticket) =>
      [10000, 10499].includes(ticket.id)
        ? {
            ...ticket,
            subject: `Delta subject ${ticket.id}`,
            status: 5,
            updated_at: changedAt,
            ...(ticket.id === 10000 ? { stats: { closed_at: changedAt } } : {}),
          }
        : ticket,
    ),
    contacts: (fixture.contacts ?? []).map((contact) =>
      contact.id === 20000
        ? { ...contact, description: 'Delta contact description', updated_at: changedAt }
        : contact,
    ),
    companies: (fixture.companies ?? []).map((company) =>
      company.id === 501
        ? { ...company, note: 'Delta company note', updated_at: changedAt }
        : company,
    ),
    satisfaction_ratings: (fixture.satisfaction_ratings ?? []).map((rating) =>
      rating.ticket_id === 10000
        ? { ...rating, feedback: 'Corrected original feedback', updated_at: changedAt }
        : rating,
    ),
  };
}
