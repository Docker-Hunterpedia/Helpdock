import type { Ticket as TicketRow, TicketStatus as TicketStatusRow } from '@helpdock/db';
import { ticketSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { ticketContactOf, toTicket, toTicketActivity } from './ticket-view.js';

const CONTACT = '01937f5e-7e53-7000-8000-0000000000d1';
const STRANGER = '01937f5e-7e53-7000-8000-0000000000d2';
const AT = new Date('2026-09-24T10:00:00.000Z');

it('does not expose signed source queries from the imported activity payload', () => {
  const activity = toTicketActivity({
    id: CONTACT,
    brandId: CONTACT,
    departmentId: CONTACT,
    ticketId: CONTACT,
    actorType: 'system',
    actorId: 'import',
    action: 'ticket.imported',
    from: null,
    to: {
      source: 'zendesk',
      number: '0039812',
      url: 'https://support.example/tickets/39812?token=private#secret',
    },
    via: 'system',
    createdAt: AT,
  });
  expect(activity.to).toEqual({
    source: 'zendesk',
    number: '0039812',
    url: 'https://support.example/tickets/39812',
  });
});

const status: TicketStatusRow = {
  id: '01937f5e-7e53-7000-8000-000000000021',
  brandId: '01937f5e-7e53-7000-8000-0000000000c1',
  name: 'Open',
  nameAr: null,
  systemState: 'open',
  pausesSla: false,
  awaitingCustomer: false,
  isDefault: true,
  isSystem: true,
  excludedFromReports: false,
  isSpam: false,
  systemKey: null,
  sortOrder: 10,
  color: 'info',
  createdAt: AT,
  updatedAt: AT,
};

const row = (contactId: string | null): TicketRow => ({
  id: '01937f5e-7e53-7000-8000-0000000000a1',
  brandId: status.brandId,
  departmentId: '01937f5e-7e53-7000-8000-000000000011',
  number: 42,
  prefix: 'HD',
  subject: 'Refund for order 42',
  statusId: status.id,
  priority: 'medium',
  channel: 'email',
  importSource: null,
  importedAt: null,
  importSlaStartedAt: null,
  teamId: null,
  assigneeId: null,
  contactId,
  parentId: null,
  mergedIntoId: null,
  visitorId: null,
  visitorClientId: null,
  mergedAt: null,
  mergedById: null,
  preMergeStatusId: null,
  preMergeDepartmentId: null,
  mergeMessageId: null,
  mergedMs: 0,
  slaPolicyId: null,
  slaCycle: 0,
  splitFromId: null,
  slaNextDueAt: null,
  firstResponseDueAt: null,
  resolutionDueAt: null,
  slaBreached: false,
  closedAt: null,
  snoozedUntil: null,
  snoozedBy: null,
  snoozeResumeStatusId: null,
  snoozeVersion: 0,
  replyMailboxId: null,
  statusChangedAt: AT,
  custom: {},
  aiPausedAt: null,
  aiPausedUntil: null,
  aiPauseReason: null,
  aiEligibleAt: null,
  aiAnsweredAt: null,
  aiHandedOffAt: null,
  search: null,
  deletedAt: null,
  createdAt: AT,
  updatedAt: AT,
});

describe('ticketContactOf', () => {
  const names = new Map([[CONTACT, 'Nadia Karim']]);

  it('names the contact the page lookup found', () => {
    expect(ticketContactOf(CONTACT, names)).toEqual({ id: CONTACT, name: 'Nadia Karim' });
  });

  it('answers null for a ticket that names nobody', () => {
    expect(ticketContactOf(null, names)).toBeNull();
  });

  it('answers null, not a guess, for an id the lookup did not return', () => {
    // Row-level security makes a contact outside the brand absent from the
    // lookup; the row draws nobody rather than an id dressed up as a name.
    expect(ticketContactOf(STRANGER, names)).toBeNull();
  });
});

describe('toTicket', () => {
  it('embeds the contact it is given, in a shape the wire schema accepts', () => {
    const ticket = toTicket(row(CONTACT), status, [], { id: CONTACT, name: 'Nadia Karim' });

    expect(ticketSchema.parse(ticket).contact).toEqual({ id: CONTACT, name: 'Nadia Karim' });
  });

  it('carries the assistant state only once the assistant took part (M7-06)', () => {
    const untouched = toTicket(
      { ...row(null), aiPausedAt: AT, aiPauseReason: 'staff_reply' },
      status,
    );
    const assisted = toTicket(
      { ...row(null), aiEligibleAt: AT, aiPausedAt: AT, aiPauseReason: 'low_confidence' },
      status,
    );

    expect(untouched).not.toHaveProperty('ai');
    expect(ticketSchema.parse(assisted).ai).toEqual({
      pausedAt: AT.toISOString(),
      pausedUntil: null,
      reason: 'low_confidence',
      answeredAt: null,
    });
  });

  it('keeps an explicit null, which says the ticket names nobody', () => {
    expect(toTicket(row(null), status, [], null)).toHaveProperty('contact', null);
  });

  it('leaves the field off when the caller did not resolve it', () => {
    // A write's response, or a caller without `contact:read`: absent is "not
    // said", which a client must not read as "nobody".
    expect(toTicket(row(CONTACT), status)).not.toHaveProperty('contact');
  });
});
