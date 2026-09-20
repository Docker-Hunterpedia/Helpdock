import type { Ticket, TicketMessage, TicketStatus } from '@helpdock/schemas';

/**
 * The smallest ticket the pure modules can be reasoned about with. The screen
 * suites drive `MockTicketsApi` instead; this is for the rules that take a row
 * and answer a question about it.
 */

export const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
export const HOUR = 60 * 60 * 1000;

export const testStatus = (overrides: Partial<TicketStatus> = {}): TicketStatus => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-000000000051',
  name: 'Open',
  nameAr: 'مفتوحة',
  systemState: 'open',
  pausesSla: false,
  awaitingCustomer: false,
  isDefault: true,
  isSystem: true,
  sortOrder: 1,
  color: 'info',
  ...overrides,
});

export const testTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-000000001042',
  number: 1042,
  prefix: 'HD',
  subject: 'Refund for order 42',
  status: testStatus(),
  priority: 'medium',
  channel: 'email',
  departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1',
  teamId: null,
  assigneeId: null,
  contactId: null,
  parentId: null,
  mergedIntoId: null,
  splitFromId: null,
  firstResponseDueAt: null,
  resolutionDueAt: null,
  slaBreached: false,
  closedAt: null,
  custom: {},
  createdAt: new Date(NOW - 4 * HOUR).toISOString(),
  updatedAt: new Date(NOW - HOUR).toISOString(),
  ...overrides,
});

export const testMessage = (
  overrides: Partial<TicketMessage> & Pick<TicketMessage, 'seq'>,
): TicketMessage => ({
  id: `0192c3f0-1a2b-7c3d-8e4f-00000000070${overrides.seq}`,
  ticketId: '0192c3f0-1a2b-7c3d-8e4f-000000001042',
  clientId: null,
  kind: 'public',
  authorType: 'contact',
  authorId: null,
  bodyHtml: '<p>Body</p>',
  bodyText: 'Body',
  channel: 'email',
  createdAt: new Date(NOW - HOUR).toISOString(),
  ...overrides,
});
