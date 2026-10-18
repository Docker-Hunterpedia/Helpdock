import { zohoArticleFixture } from './article-fixture.js';
import { zohoCoreFixture } from './core-fixture.js';
import type { FakeZoho } from './fake-zoho.js';
import { zohoKnowledgeFixture } from './knowledge-fixture.js';

type Fixture = ConstructorParameters<typeof FakeZoho>[0];
type Assets = {
  ticket: (locator: { ticketId: string; messageId: string; attachmentId: string }) => string;
  article: (locator: { articleId: string; locale: string; resourceId: string }) => string;
};
export const zohoReferenceMedia = Buffer.from(
  '%PDF-1.7\nSynthetic Zoho migration attachment\n%%EOF\n',
);

function nativeId(family: string, index: number): string {
  return `900719925474${family}${String(index).padStart(4, '0')}`;
}

/** Long native IDs, archives, original mail, private notes and independently versioned KB copies. */
export function zohoReferenceFixture(assets: Assets): Fixture {
  const template = zohoCoreFixture.tickets[0];
  const copyContact = zohoCoreFixture.contacts[1];
  if (!template || !copyContact) throw new Error('Missing native Zoho reference templates');
  const departments = Array.from({ length: 5 }, (_, index) => ({
    id: nativeId('400', index),
    name: `Zoho department ${index}`,
    isEnabled: index !== 4,
  }));
  const tickets = Array.from({ length: 500 }, (_, index) => {
    const created = new Date(Date.UTC(2018 + (index % 5), index % 12, 1, 10));
    const accountId = nativeId('200', (index % 49) % 10),
      contactId = nativeId('100', index % 49);
    return {
      ...template,
      id: nativeId('000', index),
      ticketNumber: String(10000 + index),
      subject: `Zoho reference ${10000 + index}`,
      status: index >= 400 ? 'Closed' : 'Open',
      statusType: index >= 400 ? 'Closed' : 'Open',
      priority: ['Low', 'Medium', 'High'][index % 3],
      channel: 'EMAIL',
      contactId,
      accountId,
      departmentId: nativeId('400', index % 5),
      assigneeId: '9007199254740993301',
      contact: {
        id: contactId,
        email: `zoho-customer-${index % 49}@example.invalid`,
        account: { id: accountId },
      },
      description: `<p>Original question ${index}</p>`,
      secondaryContacts: [copyContact.id],
      cf: { cf_plan: `ticket-plan-${index}` },
      createdTime: created.toISOString(),
      modifiedTime: new Date(created.getTime() + 2 * 86400000).toISOString(),
      closedTime: index >= 400 ? new Date(created.getTime() + 2 * 86400000).toISOString() : null,
      isArchived: index >= 450,
    };
  });
  const contacts = tickets.slice(0, 49).map((ticket, index) => ({
    id: ticket.contactId,
    firstName: 'Zoho',
    lastName: `Customer ${index}`,
    email: `zoho-customer-${index}@example.invalid`,
    secondaryEmail: `zoho-secondary-${index}@example.invalid`,
    phone: `+1415555${String(index).padStart(4, '0')}`,
    accountId: ticket.accountId,
    language: index % 2 ? 'ar' : 'en',
    description: `Original contact ${index}`,
    cf: { cf_plan: `contact-plan-${index}` },
    createdTime: ticket.createdTime,
    modifiedTime: ticket.modifiedTime,
    isDeleted: false,
    isTrashed: false,
    isSpam: false,
  }));
  const threads: NonNullable<Fixture['threads']> = {};
  const comments: NonNullable<Fixture['comments']> = {};
  const originalMail: NonNullable<Fixture['originalMail']> = {};
  for (const [index, ticket] of tickets.entries()) {
    const questionId = nativeId('600', index),
      replyId = nativeId('610', index);
    const replyTime = new Date(Date.parse(ticket.createdTime) + 86400000).toISOString();
    const attachmentId = nativeId('900', index);
    threads[ticket.id] = [
      {
        id: questionId,
        createdTime: ticket.createdTime,
        visibility: 'public',
        direction: 'in',
        isDescriptionThread: true,
        status: 'SUCCESS',
        content: `<p>Original question ${index}</p>`,
        plainText: `Original question ${index}`,
        contentType: 'html',
        isContentTruncated: false,
        author: {
          id: ticket.contactId,
          type: 'END_USER',
          name: `Zoho Customer ${index}`,
          email: ticket.contact.email,
        },
        channel: 'EMAIL',
        fromEmailAddress: ticket.contact.email,
        to: 'support@zoho-reference.example.invalid',
        cc: copyContact.email,
        attachments: [
          {
            id: attachmentId,
            name: `reference-${ticket.ticketNumber}.pdf`,
            size: String(zohoReferenceMedia.length),
            href: assets.ticket({ ticketId: ticket.id, messageId: questionId, attachmentId }),
          },
        ],
      },
      {
        id: replyId,
        createdTime: replyTime,
        visibility: 'public',
        direction: 'out',
        isDescriptionThread: false,
        status: 'SUCCESS',
        content: `<p>Original agent reply ${index}</p>`,
        plainText: `Original agent reply ${index}`,
        contentType: 'html',
        isContentTruncated: false,
        author: { id: ticket.assigneeId, type: 'AGENT', name: 'Original agent' },
        responderId: ticket.assigneeId,
        channel: 'EMAIL',
        fromEmailAddress: 'agent1@example.test',
        to: ticket.contact.email,
        attachments: [],
      },
    ];
    const question = threads[ticket.id]?.[0];
    if (!question) throw new Error('Missing native question thread');
    const followUpId = nativeId('620', index);
    const followUpTime = new Date(Date.parse(ticket.createdTime) + 93000000).toISOString();
    threads[ticket.id]?.push({
      ...question,
      id: followUpId,
      isDescriptionThread: false,
      createdTime: followUpTime,
      content: `<p>Original customer follow-up ${index}</p>`,
      plainText: `Original customer follow-up ${index}`,
      attachments: [],
    });
    comments[ticket.id] = [
      {
        id: nativeId('800', index),
        commentedTime: new Date(Date.parse(ticket.createdTime) + 90000000).toISOString(),
        modifiedTime: null,
        isPublic: false,
        content: `<p>Original private note ${index}</p>`,
        plainText: `Original private note ${index}`,
        contentType: 'html',
        commenterId: ticket.assigneeId,
        commenter: { id: ticket.assigneeId, type: 'AGENT', name: 'Original agent' },
        attachments: [],
      },
    ];
    for (const mail of [
      {
        id: questionId,
        created: ticket.createdTime,
        from: ticket.contact.email,
        to: 'support@zoho-reference.example.invalid',
      },
      { id: replyId, created: replyTime, from: 'agent1@example.test', to: ticket.contact.email },
      {
        id: followUpId,
        created: followUpTime,
        from: ticket.contact.email,
        to: 'support@zoho-reference.example.invalid',
      },
    ])
      originalMail[`${ticket.id}:${mail.id}`] = {
        date: new Date(mail.created).toUTCString(),
        returnPath: `<${mail.from}>`,
        subject: ticket.subject,
        messageId: `<${mail.id}@zoho-reference.example.invalid>`,
        from: mail.from,
        to: mail.to,
        content: 'Synthetic original MIME',
      };
  }
  const templates = structuredClone(zohoArticleFixture);
  const working = templates[0],
    published = templates[1],
    arabic = templates[2],
    draft = templates[3];
  if (!working || !published || !arabic || !draft)
    throw new Error('Missing Zoho article templates');
  const articleRows = [working, published, arabic];
  for (let index = 1; index < 20; index++) {
    const id = String(7001 + index);
    for (const [offset, locale] of ['en-US', 'ar-SY'].entries()) {
      const template = index === 1 ? draft : offset === 0 ? published : arabic;
      articleRows.push({
        ...template,
        id,
        locale,
        translationId: String(8001 + index * 2 + offset),
        title: offset === 0 ? `Original article ${index}` : `المقالة الأصلية ${index}`,
        latestVersion: template.currentVersion,
        latestVersionStatus: index === 1 ? 'Draft' : 'Published',
        attachments: [],
      });
    }
  }
  const articles = articleRows.map((article) => ({
    ...article,
    attachments: article.attachments.map((file) => {
      const url = assets.article({
        articleId: article.id,
        locale: article.locale,
        resourceId: file.resourceId,
      });
      return {
        ...file,
        size: String(zohoReferenceMedia.length),
        viewUrl: url,
        downloadUrl: `${url}?inline=false`,
      };
    }),
  }));
  return {
    ...structuredClone(zohoCoreFixture),
    tickets,
    threads,
    comments,
    originalMail,
    articles,
    kbRoots: structuredClone(zohoKnowledgeFixture.roots),
    kbSections: structuredClone(zohoKnowledgeFixture.sections),
    contacts: [...contacts, { ...copyContact, accountId: nativeId('200', 0) }],
    accounts: Array.from({ length: 10 }, (_, index) => ({
      id: nativeId('200', index),
      accountName: `Zoho company ${index}`,
      description: `Original company ${index}`,
      cf: { cf_tier: `company-tier-${index}` },
      createdTime: '2013-10-01T00:00:00Z',
      modifiedTime: '2020-01-01T00:00:00Z',
      isDeleted: false,
      isTrashed: false,
    })),
    departments,
    agents: [
      {
        ...zohoCoreFixture.agents[0]!,
        associatedDepartmentIds: departments.map((department) => department.id),
      },
    ],
    tags: Object.fromEntries(
      tickets.map((ticket, index) => [
        ticket.id,
        [
          { id: 1, name: 'migration', tagType: 'MANUAL' },
          { id: 2 + (index % 5), name: `team-${index % 5}`, tagType: 'MANUAL' },
        ],
      ]),
    ),
    feedback: tickets.map((ticket, index) => ({
      id: nativeId('700', index),
      ticketId: ticket.id,
      threadId: nativeId('610', index),
      rating: ['GOOD', 'OKAY', 'BAD'][index % 3]!,
      ratedTime: ticket.modifiedTime,
      customerRatedTime: ticket.modifiedTime,
      feedback: `Original feedback ${index}`,
      agentId: ticket.assigneeId,
      contactId: ticket.contactId,
      accountId: ticket.accountId,
      departmentId: ticket.departmentId,
    })),
    feedbackContent: Object.fromEntries(
      tickets.map((_ticket, index) => [nativeId('610', index), `Original feedback ${index}`]),
    ),
  };
}

export function zohoReferenceDelta(fixture: Fixture, changedAt: string): Fixture {
  const changedIds = [nativeId('000', 0), nativeId('000', 499)];
  const comments = { ...fixture.comments };
  for (const [index, id] of changedIds.entries())
    comments[id] = [
      ...(comments[id] ?? []),
      {
        id: nativeId('810', index),
        commentedTime: changedAt,
        modifiedTime: null,
        isPublic: false,
        content: `<p>Delta note ${id}</p>`,
        plainText: `Delta note ${id}`,
        contentType: 'html',
        commenterId: '9007199254740993301',
        commenter: { id: '9007199254740993301', type: 'AGENT', name: 'Original agent' },
        attachments: [],
      },
    ];
  return {
    ...fixture,
    comments,
    tickets: (fixture.tickets ?? []).map((ticket) =>
      changedIds.includes(ticket.id)
        ? {
            ...ticket,
            subject: `Delta subject ${ticket.id}`,
            status: 'Closed',
            statusType: 'Closed',
            modifiedTime: changedAt,
            ...(ticket.id === changedIds[0] ? { closedTime: changedAt } : {}),
          }
        : ticket,
    ),
    contacts: (fixture.contacts ?? []).map((contact) =>
      contact.id === nativeId('100', 0)
        ? { ...contact, description: 'Delta contact description', modifiedTime: changedAt }
        : contact,
    ),
    accounts: (fixture.accounts ?? []).map((account) =>
      account.id === nativeId('200', 0)
        ? { ...account, description: 'Delta company description', modifiedTime: changedAt }
        : account,
    ),
    feedbackContent: {
      ...fixture.feedbackContent,
      [nativeId('610', 0)]: 'Corrected original feedback',
    },
  };
}
