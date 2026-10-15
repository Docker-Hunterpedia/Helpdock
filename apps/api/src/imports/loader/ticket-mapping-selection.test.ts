import type { ImportMapping, ImportTicket } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { selectTicketMappings } from './ticket-mapping-selection.js';

const ID = '0192a000-0000-7000-8000-000000000001';
const ticket: ImportTicket = {
  externalId: '101',
  subject: 'History',
  status: 'open',
  ccEmails: [],
  tags: ['old', 'old'],
  custom: {},
  createdAt: '2020-01-01T00:00:00Z',
  updatedAt: '2020-01-02T00:00:00Z',
};
const mappings: ImportMapping[] = [
  { kind: 'status', externalValue: 'open', target: { statusId: ID } },
  { kind: 'group', externalValue: '', target: { departmentId: ID, teamId: null } },
  { kind: 'priority', externalValue: '', target: { priority: 'medium' } },
  { kind: 'channel', externalValue: '', target: { channel: 'email' } },
  { kind: 'tag', externalValue: 'old', target: { tagId: null } },
];

it('uses confirmed defaults for missing source values and retains explicit tag skips without auto-assignment', () => {
  expect(selectTicketMappings(ticket, mappings)).toEqual({
    statusId: ID,
    departmentId: ID,
    teamId: null,
    priority: 'medium',
    channel: 'email',
    assignee: null,
    tags: [{ externalValue: 'old', tagId: null }],
  });
});

it.each(['status', 'group', 'priority', 'channel', 'tag'] as const)(
  'blocks an unconfirmed %s value instead of guessing a destination',
  (kind) => {
    expect(() =>
      selectTicketMappings(
        ticket,
        mappings.filter((mapping) => mapping.kind !== kind),
      ),
    ).toThrow('mapping-invalid');
  },
);

it('requires an explicit mapping for a source assignee and preserves name-only selection', () => {
  const assigned = { ...ticket, assigneeExternalId: '301' };
  expect(() => selectTicketMappings(assigned, mappings)).toThrow('mapping-invalid');
  expect(
    selectTicketMappings(assigned, [
      ...mappings,
      { kind: 'agent', externalValue: '301', target: { kind: 'name' } },
    ]).assignee,
  ).toEqual({ kind: 'name' });
});
