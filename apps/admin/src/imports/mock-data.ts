import {
  type ImportMapping,
  type ImportMappingValue,
  importContactPreviewSchema,
  importDryRunReportSchema,
  importTicketPreviewSchema,
} from '@helpdock/schemas';

export const MOCK_IMPORT_ACTOR = {
  id: '018f4a6e-0000-7000-8000-000000000001',
  name: 'Lina Haddad',
};
export const MOCK_IMPORT_DATE = '2024-03-14T10:02:00.000Z';
export const MOCK_REVIEW_TOKEN = 'a'.repeat(64);
export const MOCK_IMPORT_HEADERS = ['Ticket ID', 'Title', 'Created', 'State'];
export const MOCK_IMPORT_CELLS = [
  '39812',
  'Refund for order 4412 not received',
  MOCK_IMPORT_DATE,
  'closed',
];

export function mockMappingValues(kind: ImportMapping['kind']): ImportMappingValue[] {
  const choices: Record<ImportMapping['kind'], [string, string, number][]> = {
    status: [
      ['open', 'open', 250],
      ['closed', 'closed', 250],
    ],
    priority: [['normal', 'normal', 500]],
    channel: [['email', 'email', 500]],
    group: [['group-support', 'Support', 500]],
    agent: [
      ['agent-1', 'Lina Haddad', 500],
      ['agent-2', 'Omar Saleh', 0],
      ['agent-3', 'Sara Ali', 0],
    ],
    field: [['ticket-field-tier', 'Plan tier', 0]],
    tag: [['refund', 'refund', 500]],
  };
  return choices[kind].map<ImportMappingValue>(([externalValue, label, occurrences]) => ({
    externalValue,
    label,
    occurrences: kind === 'field' ? null : occurrences,
    person:
      kind === 'agent'
        ? {
            name: label,
            email: `${externalValue}@example.test`,
            kind: 'agent',
            active: externalValue !== 'agent-3',
          }
        : null,
    field:
      kind === 'field'
        ? { target: 'ticket', key: 'plan_tier', type: 'text', optionsCount: 0 }
        : null,
    confirmed: null,
    proposed:
      kind === 'priority'
        ? { kind, externalValue, target: { priority: 'medium' } }
        : kind === 'channel'
          ? { kind, externalValue, target: { channel: 'email' } }
          : null,
    confirmedChoice: null,
    proposedChoice: null,
  }));
}

export function mockTicketPreview(externalId = '39812') {
  return importTicketPreviewSchema.parse({
    ticket: {
      externalId,
      number: externalId,
      subject: MOCK_IMPORT_CELLS[1],
      status: 'closed',
      channel: 'email',
      ccEmails: [],
      tags: ['refund'],
      custom: {},
      createdAt: MOCK_IMPORT_DATE,
      updatedAt: MOCK_IMPORT_DATE,
    },
    messageCount: 2,
    nextOffset: null,
    messages: [
      {
        externalId: 'reply-1',
        authorKind: 'customer',
        authorExternalId: 'contact-1',
        sourceAuthorName: 'Nora Saad',
        public: true,
        createdAt: MOCK_IMPORT_DATE,
        bodyHtml: '<p>The refund has not reached my card.</p>',
        bodyText: 'The refund has not reached my card.',
        attachments: [
          {
            externalId: 'file-1',
            fileName: 'receipt.pdf',
            contentType: 'application/pdf',
            size: 1024,
            availability: { state: 'available', size: 1024, mime: 'application/pdf' },
          },
          {
            externalId: 'file-2',
            fileName: 'old-export.pdf',
            availability: { state: 'unavailable', code: 'media-unavailable' },
          },
        ],
      },
      {
        externalId: 'note-1',
        authorKind: 'agent',
        authorExternalId: 'agent-1',
        sourceAuthorName: 'Lina Haddad',
        public: false,
        createdAt: '2024-03-14T10:15:00.000Z',
        bodyHtml: '<p>Checking the original payment.</p>',
        bodyText: 'Checking the original payment.',
        attachments: [],
      },
    ],
  });
}

export function mockContactPreview(externalId = 'contact-1') {
  return importContactPreviewSchema.parse({
    source: {
      externalId,
      name: 'Nora Saad',
      emails: ['nora@example.test'],
      phones: [],
      custom: {},
    },
    plan: {
      action: 'create',
      contactId: null,
      accountId: null,
      sourceAccountId: null,
      name: 'Nora Saad',
      sourceName: 'Nora Saad',
      identifiers: [{ kind: 'email', value: 'nora@example.test' }],
      refusedPhones: 0,
      organization: null,
    },
  });
}

export function mockDryRunReport(complete: boolean, blocked: boolean) {
  return importDryRunReportSchema.parse({
    phase: complete ? 'media_checked' : 'records',
    complete,
    reviewToken: complete ? MOCK_REVIEW_TOKEN : null,
    fingerprint: 'b'.repeat(64),
    defaultCallingCode: '',
    recordsChecked: complete ? 1500 : 250,
    mappingsChecked: complete ? 7 : 0,
    mediaChecked: complete ? 500 : 0,
    errors: complete && blocked ? 1 : 0,
    warnings: complete ? 2 : 0,
    refusedPhones: complete ? 1 : 0,
    issues: !complete
      ? []
      : [
          ...(blocked
            ? [
                {
                  area: 'record',
                  entity: 'message',
                  externalId: 'note-1',
                  code: 'author-unmapped',
                  level: 'error',
                },
              ]
            : []),
          {
            area: 'record',
            entity: 'contact',
            externalId: 'contact-1',
            code: 'phone-refused',
            level: 'warning',
          },
          {
            area: 'media',
            entity: 'attachment',
            externalId: 'file-2',
            code: 'media-unavailable',
            level: 'warning',
          },
        ],
  });
}
