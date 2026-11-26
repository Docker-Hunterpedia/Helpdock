import { describe, expect, it } from 'vitest';
import type { CustomerScope } from './customer-context.js';
import { authorOf, displayNameOf, type ThreadRow } from './db-ticket-reader.js';
import {
  portalAttachmentSchema,
  portalMessageSchema,
  portalTicketListSchema,
  portalTicketRowSchema,
  portalTicketSchema,
} from './ticket-views.js';

/** Every column the milestone doc's deny-list names, plus the obvious ones. */
const TICKET_DENIED = [
  'custom',
  'search',
  'priority',
  'teamId',
  'assigneeId',
  'slaPolicyId',
  'slaCycle',
  'slaBreached',
  'firstResponseDueAt',
  'resolutionDueAt',
  'slaNextDueAt',
  'mergedIntoId',
  'mergedAt',
  'mergedById',
  'preMergeStatusId',
  'preMergeDepartmentId',
  'mergeMessageId',
  'splitFromId',
  'parentId',
  'visitorId',
  'visitorClientId',
  'aiPausedAt',
  'aiPauseReason',
  'aiEligibleAt',
  'importedAt',
  'importSource',
  'snoozedUntil',
  'snoozedBy',
  'snoozeVersion',
  'replyMailboxId',
  'arrivalMailboxId',
  'arrivalToAddress',
  'deletedAt',
  'accountId',
  'portalPrivate',
  'portalEligible',
  'portalContactIds',
  'departmentId',
  'brandId',
  'statusId',
  'id',
  'contactId',
] as const;
const MESSAGE_DENIED = [
  'aiMeta',
  'email',
  'externalMessageId',
  'clientId',
  'importDetails',
  'importSourceAccountKey',
  'copiedFromMessageId',
  'replyToMessageId',
  'portalContactIds',
  'portalAccountId',
  'authorId',
  'authorDisplay',
  'bodyHtml',
  'kind',
  'ticketId',
  'departmentId',
  'brandId',
  'seq',
] as const;
const ATTACHMENT_DENIED = [
  's3Key',
  'variants',
  'uploaderId',
  'uploaderType',
  'rejectReason',
  'scanStatus',
  'transcriptText',
  'origin',
  'portalContactIds',
  'status',
  'messageId',
  'ticketId',
  'brandId',
] as const;

const ID = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const AT = '2026-11-26T10:00:00.000Z';
const attachment = {
  id: ID,
  name: 'return-label.pdf',
  mime: 'application/pdf',
  size: 10,
  kind: 'document',
};
const message = {
  id: ID,
  author: { kind: 'you' },
  at: AT,
  text: 'Hello',
  truncated: false,
  attachments: [attachment],
  moreFiles: 0,
};
const ticket = {
  reference: 'HD-1042',
  subject: 'Refund',
  status: 'open',
  openedBy: { kind: 'you' },
  createdAt: AT,
  channel: 'email',
  mine: true,
  messages: [message],
};
const row = {
  reference: 'HD-1042',
  subject: 'Refund',
  status: 'open',
  updatedAt: AT,
  openedBy: null,
  onlyYou: false,
};

describe('the portal DTOs are allow-lists', () => {
  it('accept exactly their own fields', () => {
    expect(portalTicketSchema.parse(ticket)).toEqual(ticket);
    expect(portalTicketRowSchema.parse(row)).toEqual(row);
    expect(portalAttachmentSchema.parse(attachment)).toEqual(attachment);
    expect(portalMessageSchema.parse(message)).toEqual(message);
  });

  it.each(TICKET_DENIED)('refuse a ticket with %s on it', (key) => {
    expect(portalTicketSchema.safeParse({ ...ticket, [key]: 'x' }).success).toBe(false);
    expect(portalTicketRowSchema.safeParse({ ...row, [key]: 'x' }).success).toBe(false);
  });

  it.each(MESSAGE_DENIED)('refuse a message with %s on it', (key) => {
    expect(portalMessageSchema.safeParse({ ...message, [key]: 'x' }).success).toBe(false);
  });

  it.each(ATTACHMENT_DENIED)('refuse an attachment with %s on it', (key) => {
    expect(portalAttachmentSchema.safeParse({ ...attachment, [key]: 'x' }).success).toBe(false);
  });

  it('refuse extra fields nested in an author, an opener and the counts', () => {
    expect(
      portalMessageSchema.safeParse({
        ...message,
        author: { kind: 'staff', name: 'Lina', email: 'lina@x.example' },
      }).success,
    ).toBe(false);
    expect(
      portalTicketSchema.safeParse({
        ...ticket,
        openedBy: { kind: 'person', name: 'Omar', address: 'o@x.example' },
      }).success,
    ).toBe(false);
    expect(
      portalTicketListSchema.safeParse({
        rows: [],
        nextCursor: null,
        counts: { mine: 0, company: null, all: 9 },
      }).success,
    ).toBe(false);
  });

  it('never carry a status the customer has no word for', () => {
    expect(portalTicketRowSchema.safeParse({ ...row, status: 'escalated' }).success).toBe(false);
  });
});

const scope: CustomerScope = {
  brandId: 'b',
  contactId: 'me',
  accountId: 'acme',
  sees: 'account',
  visibility: 'all',
  role: 'member',
  departmentIds: 'all',
};
const wrote = (over: Partial<ThreadRow>): ThreadRow => ({
  id: ID,
  authorType: 'contact',
  authorId: null,
  bodyText: 'x',
  createdAt: new Date(AT),
  ticketContactId: 'me',
  ...over,
});
const names = new Map([
  ['me', { name: 'Mona', sameAccount: true }],
  ['omar', { name: 'Omar Saleh', sameAccount: true }],
  ['outsider', { name: 'Sam Visitor', sameAccount: false }],
]);
const staff = new Map([['u1', 'Lina']]);

describe('authorOf', () => {
  it('says You for the viewer, by id or as the requester of their own ticket', () => {
    expect(authorOf(scope, wrote({ authorId: 'me' }), names, staff)).toEqual({ kind: 'you' });
    expect(authorOf(scope, wrote({ authorId: null }), names, staff)).toEqual({ kind: 'you' });
  });

  it('tags a coworker by name and a person outside the company without a tag', () => {
    expect(authorOf(scope, wrote({ authorId: 'omar' }), names, staff)).toEqual({
      kind: 'coworker',
      name: 'Omar Saleh',
    });
    expect(authorOf(scope, wrote({ authorId: 'outsider' }), names, staff)).toEqual({
      kind: 'other',
      name: 'Sam Visitor',
    });
  });

  it('falls back to the ticket requester for a message with no contact of its own, such as a visitor', () => {
    expect(
      authorOf(scope, wrote({ authorId: 'visitor-9', ticketContactId: 'omar' }), names, staff),
    ).toEqual({
      kind: 'coworker',
      name: 'Omar Saleh',
    });
    expect(authorOf(scope, wrote({ authorId: null, ticketContactId: null }), names, staff)).toEqual(
      {
        kind: 'other',
        name: null,
      },
    );
  });

  it('shows staff by their public name only, and the assistant and system as the brand', () => {
    expect(authorOf(scope, wrote({ authorType: 'staff', authorId: 'u1' }), names, staff)).toEqual({
      kind: 'staff',
      name: 'Lina',
    });
    expect(authorOf(scope, wrote({ authorType: 'staff', authorId: 'gone' }), names, staff)).toEqual(
      { kind: 'brand' },
    );
    expect(authorOf(scope, wrote({ authorType: 'ai' }), names, staff)).toEqual({ kind: 'brand' });
    expect(authorOf(scope, wrote({ authorType: 'system' }), names, staff)).toEqual({
      kind: 'brand',
    });
  });
});

describe('displayNameOf', () => {
  it('never shows an address: an email-shaped name is cut to what is before the @', () => {
    expect(displayNameOf('omar@acme.example')).toBe('omar');
    expect(displayNameOf('  Omar Saleh ')).toBe('Omar Saleh');
    expect(displayNameOf('@acme.example')).toBeNull();
    expect(displayNameOf('   ')).toBeNull();
    expect(displayNameOf('x'.repeat(500))?.length).toBe(200);
  });

  it.each([
    ['a WhatsApp number', '201234567890'],
    ['a formatted phone number', '+20 123 456 7890'],
    ['an Arabic-digit number', '٠١٢٣٤٥٦٧٨٩٠١'],
    ['a Messenger scoped id', '6543219870123456'],
    ['a Telegram chat id', '-1001234567890'],
    ['an Instagram handle', '@omar_saleh'],
    ['the widget placeholder', 'Visitor 1a2b3c'],
  ])('refuses %s as a name', (_what, name) => {
    expect(displayNameOf(name)).toBeNull();
  });

  it('refuses a name that is the contact’s own identity value on any channel', () => {
    expect(displayNameOf('omar_saleh', ['@omar_saleh'])).toBeNull();
    expect(displayNameOf('Omar.Saleh', ['omar.saleh'])).toBeNull();
    expect(displayNameOf('omar@acme.example', ['omar@acme.example'])).toBeNull();
    expect(displayNameOf('Omar Saleh', ['omar@acme.example', '201234567890'])).toBe('Omar Saleh');
  });

  it('keeps ordinary names with a digit or two', () => {
    expect(displayNameOf('Room 12 Desk')).toBe('Room 12 Desk');
    expect(displayNameOf('Omar 2')).toBe('Omar 2');
    expect(displayNameOf('عمر صالح')).toBe('عمر صالح');
  });
});
