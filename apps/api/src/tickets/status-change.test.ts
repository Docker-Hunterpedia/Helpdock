import type { TicketStatus as TicketStatusRow } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { applyStatusChange, UnknownStatusError } from './status-change.js';

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
    sortOrder: 0,
    color: 'info',
    createdAt: EARLIER,
    updatedAt: EARLIER,
  }) satisfies TicketStatusRow;

const OPEN = status('open', 'open');
const HOLD = status('hold', 'on_hold');
const CLOSED = status('closed', 'closed');
const SPAM = status('spam', 'closed');

describe('applyStatusChange', () => {
  it('refuses a status the transaction cannot see, and names it', () => {
    // The lookup ran inside the tenant transaction, so `undefined` means "not
    // this brand's" as surely as "does not exist". Both are refused the same.
    try {
      applyStatusChange({
        requestedStatusId: 'elsewhere',
        current: OPEN,
        next: undefined,
        closedAt: null,
        now: NOW,
      });
      expect.unreachable('the status should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownStatusError);
      expect((error as UnknownStatusError).statusId).toBe('elsewhere');
    }
  });

  it('reports no change when the ticket is already in that status', () => {
    // Nothing is written and nothing is logged, so an activity log does not
    // fill with entries that moved nothing.
    expect(
      applyStatusChange({
        requestedStatusId: OPEN.id,
        current: OPEN,
        next: OPEN,
        closedAt: null,
        now: NOW,
      }),
    ).toEqual({ statusId: OPEN.id, closedAt: null, changed: false });
  });

  it('moves between two open-like statuses without touching closed_at', () => {
    expect(
      applyStatusChange({
        requestedStatusId: HOLD.id,
        current: OPEN,
        next: HOLD,
        closedAt: null,
        now: NOW,
      }),
    ).toEqual({ statusId: HOLD.id, closedAt: null, changed: true });
  });

  it('stamps closed_at when a ticket enters a closed state', () => {
    expect(
      applyStatusChange({
        requestedStatusId: CLOSED.id,
        current: OPEN,
        next: CLOSED,
        closedAt: null,
        now: NOW,
      }),
    ).toEqual({ statusId: CLOSED.id, closedAt: NOW, changed: true });
  });

  it('keeps the original closed_at when moving between two closed statuses', () => {
    // Closed → Spam is one closure, not two; a report measuring resolution time
    // must not see the ticket close again.
    expect(
      applyStatusChange({
        requestedStatusId: SPAM.id,
        current: CLOSED,
        next: SPAM,
        closedAt: EARLIER,
        now: NOW,
      }),
    ).toEqual({ statusId: SPAM.id, closedAt: EARLIER, changed: true });
  });

  it('clears closed_at when a ticket leaves a closed state', () => {
    expect(
      applyStatusChange({
        requestedStatusId: OPEN.id,
        current: CLOSED,
        next: OPEN,
        closedAt: EARLIER,
        now: NOW,
      }),
    ).toEqual({ statusId: OPEN.id, closedAt: null, changed: true });
  });

  it('treats an escalated status as open-like, so a closed ticket reopens', () => {
    expect(
      applyStatusChange({
        requestedStatusId: 'escalated',
        current: CLOSED,
        next: status('escalated', 'escalated'),
        closedAt: EARLIER,
        now: NOW,
      }).closedAt,
    ).toBeNull();
  });
});
