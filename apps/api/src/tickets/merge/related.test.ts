import type { Ticket as TicketRow, TicketStatus as TicketStatusRow } from '@helpdock/db';
import { relatedTicketSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { relatedTicketsOf } from './related.js';

const AT = new Date('2026-09-25T10:00:00.000Z');
const BRAND = '01937f5e-7e53-7000-8000-0000000000c1';
const id = (n: number) => `01937f5e-7e53-7000-8000-0000000000${String(n).padStart(2, '0')}`;

const status: TicketStatusRow = {
  id: id(90),
  brandId: BRAND,
  name: 'Closed',
  nameAr: null,
  systemState: 'closed',
  pausesSla: false,
  awaitingCustomer: false,
  isDefault: false,
  isSystem: true,
  excludedFromReports: false,
  isSpam: false,
  systemKey: 'closed',
  sortOrder: 40,
  color: 'success',
  createdAt: AT,
  updatedAt: AT,
};

const ticket = (n: number, links: Partial<TicketRow> = {}): TicketRow => ({
  id: id(n),
  brandId: BRAND,
  departmentId: id(80),
  number: 1000 + n,
  prefix: 'HD',
  subject: `Ticket ${String(n)}`,
  statusId: status.id,
  priority: 'medium',
  channel: 'email',
  teamId: null,
  assigneeId: null,
  contactId: null,
  parentId: null,
  mergedIntoId: null,
  mergedAt: null,
  mergedById: null,
  preMergeStatusId: null,
  preMergeDepartmentId: null,
  mergeMessageId: null,
  mergedMs: 0,
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
  ...links,
});

const seen = (row: TicketRow) => ({ ticket: row, status });

describe('relatedTicketsOf', () => {
  it('is empty for a ticket linked to nothing', () => {
    expect(relatedTicketsOf(ticket(1), [])).toEqual([]);
  });

  it('names every visible link with its reference, subject, status and relation', () => {
    const read = ticket(1, { parentId: id(2), splitFromId: id(3) });

    const related = relatedTicketsOf(read, [seen(ticket(2)), seen(ticket(3))]);

    expect(related).toEqual([
      expect.objectContaining({ visible: true, relation: 'parent', id: id(2), number: 1002 }),
      expect.objectContaining({ visible: true, relation: 'splitFrom', id: id(3) }),
    ]);
    expect(related[0]).toMatchObject({ subject: 'Ticket 2', status: { name: 'Closed' } });
  });

  it('orders them where the work came from first, then where it went', () => {
    const read = ticket(1, { parentId: id(2), mergedIntoId: id(3), splitFromId: id(4) });
    const rows = [
      seen(ticket(6, { splitFromId: id(1) })),
      seen(ticket(5, { mergedIntoId: id(1) })),
      seen(ticket(4)),
      seen(ticket(3)),
      seen(ticket(2)),
    ];

    expect(relatedTicketsOf(read, rows).map((link) => link.relation)).toEqual([
      'parent',
      'mergedInto',
      'mergedFrom',
      'splitFrom',
      'splitTo',
    ]);
  });

  it('keeps a link the ticket names but the reader cannot see as its relation alone', () => {
    const read = ticket(1, { mergedIntoId: id(2), splitFromId: id(3) });

    const related = relatedTicketsOf(read, []);

    expect(related).toEqual([
      { visible: false, relation: 'mergedInto' },
      { visible: false, relation: 'splitFrom' },
    ]);
    // What goes on the wire is exactly that: the output schema has nowhere to put more.
    for (const link of related) {
      expect(relatedTicketSchema.parse(link)).toEqual(link);
    }
  });

  it('lists a ticket that names this one only when the reader found it', () => {
    const read = ticket(1);
    const split = ticket(2, { splitFromId: id(1) });

    expect(relatedTicketsOf(read, [seen(split)])).toEqual([
      expect.objectContaining({ visible: true, relation: 'splitTo', id: id(2) }),
    ]);
  });
});
