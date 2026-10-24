import type { Ticket, TicketStatus } from '@helpdock/db';
import { SNOOZE_MAX_MS, SNOOZE_MIN_MS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { planSnooze, snoozeWithinBounds } from './snooze-plan.js';

const NOW = new Date('2026-10-01T10:00:00.000Z');
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

const status = (over: Partial<TicketStatus>): TicketStatus =>
  ({ id: 'open', systemState: 'open', systemKey: 'open', ...over }) as TicketStatus;
const ticket = (over: Partial<Ticket> = {}): Ticket =>
  ({
    statusId: 'open',
    snoozedUntil: null,
    snoozeResumeStatusId: null,
    closedAt: null,
    mergedIntoId: null,
    deletedAt: null,
    ...over,
  }) as Ticket;
const SNOOZED = status({ id: 'snoozed', systemKey: 'snoozed' });

const plan = (until: Date, over: { ticket?: Ticket; status?: TicketStatus } = {}) =>
  planSnooze({
    ticket: over.ticket ?? ticket(),
    status: over.status ?? status({}),
    snoozed: SNOOZED,
    until,
    now: NOW,
    snoozedBy: null,
  });

describe('planSnooze', () => {
  it('plans the snooze columns, remembering the status before', () => {
    const planned = plan(at(3_600_000));

    expect(planned).toMatchObject({
      kind: 'planned',
      statusChanged: true,
      values: { statusId: 'snoozed', snoozeResumeStatusId: 'open', snoozedBy: null },
    });
  });

  it('keeps the first status when a snoozed ticket is snoozed again, and changes no status', () => {
    const planned = plan(at(3_600_000), {
      ticket: ticket({
        statusId: 'snoozed',
        snoozedUntil: at(600_000),
        snoozeResumeStatusId: 'open',
      }),
      status: SNOOZED,
    });

    expect(planned).toMatchObject({
      kind: 'planned',
      statusChanged: false,
      values: { snoozeResumeStatusId: 'open' },
    });
  });

  it.each([
    ['under the minimum', SNOOZE_MIN_MS - 1],
    ['in the past', -60_000],
    ['over the maximum', SNOOZE_MAX_MS + 1],
  ])('refuses a time %s', (_name, ahead) => {
    expect(plan(at(ahead))).toEqual({ kind: 'refused', reason: 'out-of-bounds' });
  });

  it('accepts exactly the bounds', () => {
    expect(snoozeWithinBounds(at(SNOOZE_MIN_MS), NOW)).toBe(true);
    expect(snoozeWithinBounds(at(SNOOZE_MAX_MS), NOW)).toBe(true);
  });

  it("refuses a closed ticket, a merged one and a deleted one, with the transition's reason", () => {
    expect(
      plan(at(3_600_000), {
        ticket: ticket({ closedAt: NOW }),
        status: status({ systemState: 'closed' }),
      }),
    ).toEqual({
      kind: 'refused',
      reason: 'transition',
      refusal: 'ticket-closed',
    });
    expect(plan(at(3_600_000), { ticket: ticket({ mergedIntoId: 'x' }) })).toMatchObject({
      reason: 'transition',
      refusal: 'ticket-merged',
    });
    expect(plan(at(3_600_000), { ticket: ticket({ deletedAt: NOW }) })).toMatchObject({
      reason: 'transition',
      refusal: 'ticket-deleted',
    });
  });

  it('refuses when the brand has no Snoozed status', () => {
    expect(
      planSnooze({
        ticket: ticket(),
        status: status({}),
        snoozed: undefined,
        until: at(3_600_000),
        now: NOW,
        snoozedBy: null,
      }),
    ).toEqual({ kind: 'refused', reason: 'no-snoozed-status' });
  });

  it('reads open or closed the way the lifecycle does: a closed-state status without closed_at is live', () => {
    expect(plan(at(3_600_000), { status: status({ systemState: 'closed' }) })).toMatchObject({
      kind: 'planned',
    });
  });
});
