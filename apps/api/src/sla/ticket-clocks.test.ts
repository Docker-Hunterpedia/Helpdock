import { alwaysOpenCalendar, type BusinessCalendar, type SlaTimeMode } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { type Clock, elapsedAt } from './clock.js';
import {
  type AppliedPolicy,
  type CalendarFor,
  reconcileClocks,
  reopenClocks,
  respondClocks,
  summaryColumns,
  type TicketFacts,
} from './ticket-clocks.js';

/**
 * DOMAIN-RULES §3.6, to the minute. "Policy: High priority, first response
 * 2 h, resolution 8 h. Business hours 09:00–17:00 Sunday–Thursday,
 * Asia/Riyadh." Urgent is resolution 4 h (example 3).
 *
 * 2026-10-01 is a Thursday. Every instant below is Riyadh wall time.
 */
const workday = () => [{ start: '09:00', end: '17:00' }];
const riyadh: BusinessCalendar = {
  timezone: 'Asia/Riyadh',
  weekly: [workday(), workday(), workday(), workday(), workday(), [], []],
  holidays: [],
};
const calendarFor: CalendarFor = (mode: SlaTimeMode) =>
  mode === 'business' ? riyadh : alwaysOpenCalendar('Asia/Riyadh');

const ry = (local: string): Date => new Date(`${local}:00+03:00`);
const HOUR = 3_600_000;
const DEPARTMENT = '01937f5e-7e53-7000-8000-0000000000d1';
const OTHER_DEPARTMENT = '01937f5e-7e53-7000-8000-0000000000d2';

const high: AppliedPolicy = {
  id: '01937f5e-7e53-7000-8000-0000000000a1',
  timeMode: 'business',
  target: { firstResponseMinutes: 120, resolutionMinutes: 480 },
};
const urgent: AppliedPolicy = {
  ...high,
  target: { firstResponseMinutes: 60, resolutionMinutes: 240 },
};

const open: TicketFacts = {
  departmentId: DEPARTMENT,
  systemState: 'open',
  pausesSla: false,
  excludedFromReports: false,
  merged: false,
  deleted: false,
  responded: false,
};
const awaiting: TicketFacts = { ...open, systemState: 'on_hold', pausesSla: true };
const closed: TicketFacts = { ...open, systemState: 'closed' };

const of = (clocks: readonly Clock[], kind: Clock['kind']): Clock => {
  const clock = clocks.find((candidate) => candidate.kind === kind);
  if (clock === undefined) {
    throw new Error(`no ${kind} clock`);
  }
  return clock;
};

const reconcile = (
  clocks: readonly Clock[],
  facts: TicketFacts,
  policy: AppliedPolicy | null,
  at: Date,
) => reconcileClocks({ clocks, cycle: 0, facts, policy, calendarFor, at });

/** Examples 1 and 2 are one ticket; each step starts from the one before. */
const created = reconcile([], open, high, ry('2026-10-01T16:00'));
const replied = respondClocks(created, calendarFor, DEPARTMENT, ry('2026-10-04T09:30'));
const waiting = reconcile(replied, awaiting, high, ry('2026-10-04T09:30'));
const resumed = reconcile(waiting, open, high, ry('2026-10-06T12:00'));

describe('DOMAIN-RULES §3.6', () => {
  it('1. created Thursday 16:00: first response due Sunday 10:00; met Sunday 09:30 after 1.5 h', () => {
    expect(of(created, 'first_response').dueAt).toEqual(ry('2026-10-04T10:00'));

    const response = of(replied, 'first_response');
    expect(response.satisfiedAt).toEqual(ry('2026-10-04T09:30'));
    expect(response.elapsedMs).toBe(1.5 * HOUR);
    expect(response.breachedAt).toBeNull();
  });

  it('2. Awaiting customer from Sunday 09:30 pauses resolution at 1.5 h; resumes Tuesday 12:00, due Wednesday 10:30', () => {
    const paused = of(waiting, 'resolution');
    expect(paused.pausedAt).toEqual(ry('2026-10-04T09:30'));
    expect(paused.elapsedMs).toBe(1.5 * HOUR);
    expect(paused.dueAt).toBeNull();
    // Nothing is counted while paused, however long the customer takes.
    expect(elapsedAt(paused, riyadh, ry('2026-10-06T11:59'))).toBe(1.5 * HOUR);

    const running = of(resumed, 'resolution');
    expect(running.pausedAt).toBeNull();
    expect(running.dueAt).toEqual(ry('2026-10-07T10:30'));
    expect(running.pausedTotalMs).toBe(
      ry('2026-10-06T12:00').getTime() - ry('2026-10-04T09:30').getTime(),
    );
  });

  it('3. Urgent at Tuesday 13:00: elapsed 2.5 h, remaining 1.5 h, due Tuesday 14:30', () => {
    const raised = of(reconcile(resumed, open, urgent, ry('2026-10-06T13:00')), 'resolution');

    expect(raised.elapsedMs).toBe(2.5 * HOUR);
    expect(raised.targetMinutes).toBe(240);
    expect(raised.dueAt).toEqual(ry('2026-10-06T14:30'));
    expect(raised.breachedAt).toBeNull();
  });

  it('4. closed Tuesday 14:00 is met; reopened the next Monday, next response in 2 h and resolution in 8 h', () => {
    const resolved = reconcile(resumed, closed, high, ry('2026-10-06T14:00'));
    expect(of(resolved, 'resolution').satisfiedAt).toEqual(ry('2026-10-06T14:00'));
    expect(of(resolved, 'resolution').breachedAt).toBeNull();

    // Six days later, inside `within_days: 7`.
    const reopened = reopenClocks({
      clocks: resolved,
      cycle: 0,
      facts: open,
      policy: high,
      calendarFor,
      at: ry('2026-10-12T10:12'),
    });

    expect(reopened.cycle).toBe(1);
    expect(of(reopened.started, 'next_response').dueAt).toEqual(ry('2026-10-12T12:12'));
    expect(of(reopened.started, 'resolution').dueAt).toEqual(ry('2026-10-13T10:12'));
    // The initial clocks remain "met" in reports.
    expect(reopened.retired.every((clock) => !clock.isCurrent)).toBe(true);
    expect(of(reopened.retired, 'first_response').satisfiedAt).toEqual(ry('2026-10-04T09:30'));
    expect(of(reopened.retired, 'resolution').satisfiedAt).toEqual(ry('2026-10-06T14:00'));
  });
});

describe('reconcileClocks', () => {
  it('records a breach at the moment a change uses the target up (§3.3)', () => {
    // 2.5 h elapsed by Tuesday 13:00; a 2 h target is already gone.
    const tight = { ...urgent, target: { firstResponseMinutes: 60, resolutionMinutes: 120 } };
    const breached = of(reconcile(resumed, open, tight, ry('2026-10-06T13:00')), 'resolution');

    expect(breached.breachedAt).toEqual(ry('2026-10-06T13:00'));
    expect(breached.breachCause).toBe('change');
  });

  it('counts what ran before a department move under the old calendar', () => {
    const other: BusinessCalendar = {
      ...riyadh,
      weekly: [workday(), [], [], [], [], [], []],
    };
    const byDepartment: CalendarFor = (_mode, departmentId) =>
      departmentId === DEPARTMENT ? riyadh : other;
    const start = reconcileClocks({
      clocks: [],
      cycle: 0,
      facts: open,
      policy: high,
      calendarFor: byDepartment,
      at: ry('2026-10-05T09:00'),
    });
    const moved = reconcileClocks({
      clocks: start,
      cycle: 0,
      facts: { ...open, departmentId: OTHER_DEPARTMENT, previousDepartmentId: DEPARTMENT },
      policy: high,
      calendarFor: byDepartment,
      at: ry('2026-10-05T11:00'),
    });

    // Two hours on Monday under the old hours; the other department opens on
    // Sundays only, so the remaining six hours run next Sunday.
    expect(of(moved, 'resolution').elapsedMs).toBe(2 * HOUR);
    expect(of(moved, 'resolution').dueAt).toEqual(ry('2026-10-11T15:00'));
  });

  it('stops without a verdict when no policy applies, and picks up where it left off', () => {
    const stopped = reconcile(created, open, null, ry('2026-10-04T10:00'));
    expect(stopped.every((clock) => clock.stopReason === 'no_policy')).toBe(true);
    expect(summaryColumns(stopped, null).resolutionDueAt).toBeNull();

    const again = of(reconcile(stopped, open, high, ry('2026-10-05T09:00')), 'resolution');
    expect(again.stoppedAt).toBeNull();
    expect(again.elapsedMs).toBe(2 * HOUR);
    expect(again.dueAt).toEqual(ry('2026-10-05T15:00'));
  });

  it('stops on a merge and resumes on an unmerge without counting the merged time', () => {
    const merged = reconcile(created, { ...open, merged: true }, high, ry('2026-10-04T10:00'));
    expect(of(merged, 'resolution').stopReason).toBe('merged');

    const unmerged = of(reconcile(merged, open, high, ry('2026-10-05T09:00')), 'resolution');
    expect(unmerged.elapsedMs).toBe(2 * HOUR);
    expect(unmerged.dueAt).toEqual(ry('2026-10-05T15:00'));
  });

  it('stops both clocks, met by nothing, when the ticket is closed as spam', () => {
    const spam = reconcile(
      created,
      { ...closed, excludedFromReports: true },
      high,
      ry('2026-10-04T10:00'),
    );

    expect(spam.map((clock) => [clock.satisfiedAt, clock.stopReason])).toEqual([
      [null, 'excluded'],
      [null, 'excluded'],
    ]);
  });

  it('stops an unmet response clock when the ticket closes', () => {
    const closedEarly = reconcile(created, closed, high, ry('2026-10-04T09:15'));

    expect(of(closedEarly, 'first_response').stopReason).toBe('closed');
    expect(of(closedEarly, 'resolution').satisfiedAt).toEqual(ry('2026-10-04T09:15'));
  });

  it('owes no first-response clock once staff have replied', () => {
    const late = reconcile([], { ...open, responded: true }, high, ry('2026-10-04T09:00'));

    expect(late.map((clock) => clock.kind)).toEqual(['resolution']);
  });

  it('stops everything on a deleted ticket', () => {
    expect(
      reconcile(created, { ...open, deleted: true }, high, ry('2026-10-04T09:00')).every(
        (clock) => clock.stopReason === 'excluded',
      ),
    ).toBe(true);
  });

  it('counts every minute under calendar hours', () => {
    const allDay = reconcile([], open, { ...high, timeMode: 'calendar' }, ry('2026-10-01T16:00'));

    expect(of(allDay, 'first_response').dueAt).toEqual(ry('2026-10-01T18:00'));
  });

  it('records a late response as a breach at the due time it missed', () => {
    const late = of(
      respondClocks(created, calendarFor, DEPARTMENT, ry('2026-10-04T11:00')),
      'first_response',
    );

    expect(late.breachedAt).toEqual(ry('2026-10-04T10:00'));
    expect(late.breachCause).toBe('timer');
  });
});

describe('summaryColumns', () => {
  it('shows the due times of counting clocks and whether anything breached', () => {
    expect(summaryColumns(created, high.id)).toEqual({
      slaPolicyId: high.id,
      firstResponseDueAt: ry('2026-10-04T10:00'),
      // One hour on Thursday, seven on Sunday.
      resolutionDueAt: ry('2026-10-04T16:00'),
      slaBreached: false,
    });
    expect(summaryColumns(waiting, high.id).resolutionDueAt).toBeNull();
  });
});
