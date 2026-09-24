import type { Ticket as TicketRow, TicketStatus as TicketStatusRow } from '@helpdock/db';
import { ticketSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { ticketContactOf, toTicket } from './ticket-view.js';

const CONTACT = '01937f5e-7e53-7000-8000-0000000000d1';
const STRANGER = '01937f5e-7e53-7000-8000-0000000000d2';
const AT = new Date('2026-09-24T10:00:00.000Z');

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
  teamId: null,
  assigneeId: null,
  contactId,
  parentId: null,
  mergedIntoId: null,
  splitFromId: null,
  firstResponseDueAt: null,
  resolutionDueAt: null,
  slaBreached: false,
  closedAt: null,
  custom: {},
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

  it('keeps an explicit null, which says the ticket names nobody', () => {
    expect(toTicket(row(null), status, [], null)).toHaveProperty('contact', null);
  });

  it('leaves the field off when the caller did not resolve it', () => {
    // A write's response, or a caller without `contact:read`: absent is "not
    // said", which a client must not read as "nobody".
    expect(toTicket(row(CONTACT), status)).not.toHaveProperty('contact');
  });
});
