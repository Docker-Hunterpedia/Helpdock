import type { Ticket } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { describeAction, type StagingLookups, setsStatus, withInserted } from './macro-staging.js';

const ME = 'me';
const lookups: StagingLookups = {
  viewerId: ME,
  statusName: (id) => ({ open: 'Open', awaiting: 'Awaiting customer' })[id] ?? '?',
  tagName: (id) => `#${id}`,
  personName: (id) => (id === ME ? 'Lina Haddad' : 'Omar Nasser'),
  teamName: () => 'a team',
  priorityName: (priority) => priority.toUpperCase(),
};

const ticket = {
  status: { id: 'open' },
  priority: 'medium',
  assigneeId: ME,
} as Pick<Ticket, 'status' | 'priority' | 'assigneeId'>;

describe('describeAction', () => {
  it('names a status and a priority move from what the ticket has now', () => {
    expect(describeAction({ type: 'set_status', statusId: 'awaiting' }, ticket, lookups)).toEqual({
      field: 'status',
      from: 'Open',
      to: 'Awaiting customer',
    });
    expect(describeAction({ type: 'set_priority', priority: 'high' }, ticket, lookups)).toEqual({
      field: 'priority',
      from: 'MEDIUM',
      to: 'HIGH',
    });
  });

  it('names a tag going on and coming off', () => {
    expect(describeAction({ type: 'remove_tag', tagId: 'vip' }, ticket, lookups)).toEqual({
      field: 'tag',
      add: false,
      name: '#vip',
    });
  });

  it('says the assignee stays when the ticket is already theirs', () => {
    expect(describeAction({ type: 'assign', assignee: { kind: 'self' } }, ticket, lookups)).toEqual(
      { field: 'assignee', to: 'Lina Haddad', unchanged: true },
    );
    expect(
      describeAction(
        { type: 'assign', assignee: { kind: 'user', userId: 'omar' } },
        ticket,
        lookups,
      ),
    ).toEqual({ field: 'assignee', to: 'Omar Nasser', unchanged: false });
  });

  it('names a team, and nobody', () => {
    expect(
      describeAction({ type: 'assign', assignee: { kind: 'team', teamId: 't' } }, ticket, lookups),
    ).toMatchObject({ to: 'a team' });
    expect(
      describeAction({ type: 'assign', assignee: { kind: 'unassigned' } }, ticket, lookups),
    ).toMatchObject({ to: null, unchanged: false });
  });
});

describe('setsStatus', () => {
  it('is true only when a staged action sets the status', () => {
    expect(setsStatus(null)).toBe(false);
    expect(
      setsStatus({
        macro: { id: 'm', name: 'M' },
        actions: [{ type: 'set_status', statusId: 'awaiting' }],
      }),
    ).toBe(true);
    expect(setsStatus({ macro: { id: 'm', name: 'M' }, actions: [] })).toBe(false);
  });
});

describe('withInserted', () => {
  it('fills an empty composer, and adds after what was typed', () => {
    expect(withInserted('  ', 'Hi Mona')).toBe('Hi Mona');
    expect(withInserted('Thanks.\n', 'Hi Mona')).toBe('Thanks.\n\nHi Mona');
  });
});
