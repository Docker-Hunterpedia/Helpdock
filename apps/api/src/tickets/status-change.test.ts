import type { TicketStatus as TicketStatusRow } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { TicketLifecycleFailure } from './lifecycle/lifecycle-failure.js';
import type { LifecycleEvent } from './lifecycle/transitions.js';
import { applyStatusChange, type StatusChange, UnknownStatusError } from './status-change.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const EARLIER = new Date('2026-09-18T09:00:00.000Z');

const status = (id: string, systemState: TicketStatusRow['systemState']): TicketStatusRow =>
  ({
    id,
    brandId: '01937f5e-7e53-7000-8000-00000000000a',
    name: id,
    nameAr: null,
    systemState,
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: systemState === 'open',
    isSystem: true,
    excludedFromReports: false,
    sortOrder: 0,
    color: 'info',
    createdAt: EARLIER,
    updatedAt: EARLIER,
  }) satisfies TicketStatusRow;

const OPEN = status('open', 'open');
const HOLD = status('hold', 'on_hold');
const CLOSED = status('closed', 'closed');
const SPAM = status('spam', 'closed');

/** A live ticket, which is what every case but the last two describes. */
const LIVE = { mergedIntoId: null, deletedAt: null };

const change = (overrides: Partial<StatusChange> & Pick<StatusChange, 'current' | 'next'>) =>
  applyStatusChange({
    requestedStatusId: overrides.next?.id ?? 'elsewhere',
    closedAt: null,
    ticket: LIVE,
    event: 'agent.status' as LifecycleEvent,
    now: NOW,
    ...overrides,
  });

describe('applyStatusChange', () => {
  it('refuses a status the transaction cannot see, and names it', () => {
    // The lookup ran inside the tenant transaction, so `undefined` means "not
    // this brand's" as surely as "does not exist". Both are refused the same.
    try {
      change({ requestedStatusId: 'elsewhere', current: OPEN, next: undefined });
      expect.unreachable('the status should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownStatusError);
      expect((error as UnknownStatusError).statusId).toBe('elsewhere');
    }
  });

  it('reports no change when the ticket is already in that status', () => {
    // Nothing is written and nothing is logged, so an activity log does not
    // fill with entries that moved nothing.
    expect(change({ current: OPEN, next: OPEN })).toEqual({
      statusId: OPEN.id,
      closedAt: null,
      changed: false,
      closing: false,
      reopening: false,
    });
  });

  it('moves between two open-like statuses without touching closed_at', () => {
    expect(change({ current: OPEN, next: HOLD })).toEqual({
      statusId: HOLD.id,
      closedAt: null,
      changed: true,
      closing: false,
      reopening: false,
    });
  });

  it('stamps closed_at and reports a close when a ticket enters a closed state', () => {
    expect(change({ current: OPEN, next: CLOSED })).toEqual({
      statusId: CLOSED.id,
      closedAt: NOW,
      changed: true,
      closing: true,
      reopening: false,
    });
  });

  it('keeps the original closed_at when moving between two closed statuses', () => {
    // Closed → Spam is one closure, not two; a report measuring resolution time
    // must not see the ticket close again, and no second CSAT is scheduled.
    expect(change({ current: CLOSED, next: SPAM, closedAt: EARLIER })).toEqual({
      statusId: SPAM.id,
      closedAt: EARLIER,
      changed: true,
      closing: false,
      reopening: false,
    });
  });

  it('clears closed_at and reports a reopen when a ticket leaves a closed state', () => {
    expect(change({ current: CLOSED, next: OPEN, closedAt: EARLIER })).toEqual({
      statusId: OPEN.id,
      closedAt: null,
      changed: true,
      closing: false,
      reopening: true,
    });
  });

  it('treats an escalated status as open-like, so a closed ticket reopens', () => {
    const result = change({
      current: CLOSED,
      next: status('escalated', 'escalated'),
      closedAt: EARLIER,
    });

    expect(result.closedAt).toBeNull();
    expect(result.reopening).toBe(true);
  });
});

describe('the transitions §2.2 has no row for', () => {
  it('refuses closing a ticket that was merged into another', () => {
    expect(() =>
      change({
        current: OPEN,
        next: CLOSED,
        ticket: { mergedIntoId: '01937f5e-7e53-7000-8000-0000000000ff', deletedAt: null },
      }),
    ).toThrowError(TicketLifecycleFailure);
  });

  it('names the rule that refused, so the workspace can say which', () => {
    try {
      change({ current: OPEN, next: CLOSED, ticket: { mergedIntoId: null, deletedAt: NOW } });
      expect.unreachable('the transition should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(TicketLifecycleFailure);
      expect((error as TicketLifecycleFailure).reason).toBe('ticket-deleted');
      expect((error as TicketLifecycleFailure).getStatus()).toBe(409);
    }
  });

  it('refuses reopening a ticket that was never closed', () => {
    try {
      change({ current: OPEN, next: OPEN, event: 'agent.reopen' });
      expect.unreachable('the transition should have been refused');
    } catch (error) {
      expect((error as TicketLifecycleFailure).reason).toBe('ticket-not-closed');
    }
  });

  it('checks the status is this brands before it checks the transition', () => {
    // Otherwise a caller could learn that another brand holds a status id by
    // which of the two refusals came back.
    expect(() =>
      change({
        requestedStatusId: 'elsewhere',
        current: OPEN,
        next: undefined,
        ticket: { mergedIntoId: 'a-primary', deletedAt: null },
      }),
    ).toThrowError(UnknownStatusError);
  });
});
