import type {
  BusinessCalendar,
  SlaClockKind,
  SlaTarget,
  SlaTimeMode,
  TicketSystemState,
} from '@helpdock/schemas';
import {
  type Clock,
  checkpoint,
  isCounting,
  isRunning,
  pause,
  restart,
  resume,
  retarget,
  type SlaStopReason,
  satisfy,
  startClock,
  stop,
} from './clock.js';

/**
 * What happens to one ticket's clocks when something about the ticket moves
 * (DOMAIN-RULES §3.1–§3.5): the decision table, as pure functions. The service
 * reads the facts and the clocks, calls one of these, and writes back whatever
 * differs.
 *
 * | The ticket | The clocks |
 * |---|---|
 * | deleted, or merged into another | stop, no verdict (§2.4) |
 * | unmerged | restart; the merged time is not counted |
 * | closed | resolution met; an unmet response clock stops; spam stops both |
 * | open-like, no policy applies | stop, no verdict |
 * | open-like, a policy applies | start what is missing, retarget what differs (§3.3), pause or resume on `pauses_sla` (§3.2) |
 */

/** Everything about a ticket the clocks depend on, read inside the transaction. */
export interface TicketFacts {
  readonly departmentId: string;
  /** The department before this change, when the change moved the ticket. */
  readonly previousDepartmentId?: string | undefined;
  readonly systemState: TicketSystemState;
  readonly pausesSla: boolean;
  /** Spam or Merged: a close that is not a resolution. */
  readonly excludedFromReports: boolean;
  readonly merged: boolean;
  readonly deleted: boolean;
  /** A staff member has already replied publicly, so a late first-response clock is not owed. */
  readonly responded: boolean;
}

export interface AppliedPolicy {
  readonly id: string;
  readonly timeMode: SlaTimeMode;
  /** The targets for the ticket's priority. */
  readonly target: SlaTarget;
}

export type CalendarFor = (timeMode: SlaTimeMode, departmentId: string) => BusinessCalendar;

export interface ReconcileInput {
  /** The ticket's current clocks: at most one response clock and one resolution clock. */
  readonly clocks: readonly Clock[];
  /** `tickets.sla_cycle`: 0 until the first reopen, one more for each. */
  readonly cycle: number;
  readonly facts: TicketFacts;
  readonly policy: AppliedPolicy | null;
  readonly calendarFor: CalendarFor;
  readonly at: Date;
}

export const isResponseClock = (kind: SlaClockKind): boolean => kind !== 'resolution';

const targetOf = (policy: AppliedPolicy, kind: SlaClockKind): number =>
  isResponseClock(kind) ? policy.target.firstResponseMinutes : policy.target.resolutionMinutes;

const stopRunning = (
  clocks: readonly Clock[],
  calendarOf: (clock: Clock) => BusinessCalendar,
  at: Date,
  reason: SlaStopReason,
): Clock[] => clocks.map((clock) => stop(clock, calendarOf(clock), at, reason));

/** Brings the current clocks in line with the ticket as it is now. */
export const reconcileClocks = ({
  clocks,
  cycle,
  facts,
  policy,
  calendarFor,
  at,
}: ReconcileInput): Clock[] => {
  const before = facts.previousDepartmentId ?? facts.departmentId;
  const now = (clock: Clock): BusinessCalendar => calendarFor(clock.timeMode, facts.departmentId);
  // Whatever ran up to this moment is counted under the calendar it ran in.
  let out = clocks.map((clock) => checkpoint(clock, calendarFor(clock.timeMode, before), at));

  if (facts.deleted) {
    return stopRunning(out, now, at, 'excluded');
  }
  if (facts.merged) {
    return stopRunning(out, now, at, 'merged');
  }
  out = out.map((clock) =>
    clock.stopReason === 'merged' ? restart(clock, now(clock), at) : clock,
  );

  if (facts.systemState === 'closed') {
    return out.map((clock) => {
      if (facts.excludedFromReports) {
        return stop(clock, now(clock), at, 'excluded');
      }
      return clock.kind === 'resolution'
        ? satisfy(clock, now(clock), at)
        : stop(clock, now(clock), at, 'closed');
    });
  }

  if (policy === null) {
    return stopRunning(out, now, at, 'no_policy');
  }

  out = out.map((clock) =>
    clock.stopReason === 'no_policy' ? restart(clock, now(clock), at) : clock,
  );
  out = [...out, ...missingClocks(out, cycle, facts, policy, calendarFor, at)];

  return out.map((clock) => {
    const target = targetOf(policy, clock.kind);
    const moved =
      clock.policyId !== policy.id ||
      clock.targetMinutes !== target ||
      clock.timeMode !== policy.timeMode ||
      before !== facts.departmentId;
    const calendar = calendarFor(policy.timeMode, facts.departmentId);
    const targeted = moved
      ? retarget(
          clock,
          { before: calendar, after: calendar },
          { policyId: policy.id, targetMinutes: target, timeMode: policy.timeMode },
          at,
        )
      : clock;

    return facts.pausesSla ? pause(targeted, calendar, at) : resume(targeted, calendar, at);
  });
};

/** The clocks a policy owes the ticket that it does not have yet. */
const missingClocks = (
  clocks: readonly Clock[],
  cycle: number,
  facts: TicketFacts,
  policy: AppliedPolicy,
  calendarFor: CalendarFor,
  at: Date,
): Clock[] => {
  const calendar = calendarFor(policy.timeMode, facts.departmentId);
  const start = (kind: SlaClockKind): Clock =>
    startClock(
      {
        kind,
        cycle,
        policyId: policy.id,
        targetMinutes: targetOf(policy, kind),
        timeMode: policy.timeMode,
      },
      calendar,
      at,
    );

  const missing: Clock[] = [];
  const responseOwed = cycle > 0 || !facts.responded;
  if (responseOwed && !clocks.some((clock) => isResponseClock(clock.kind))) {
    missing.push(start(cycle > 0 ? 'next_response' : 'first_response'));
  }
  if (!clocks.some((clock) => clock.kind === 'resolution')) {
    missing.push(start('resolution'));
  }

  return missing;
};

export interface Reopened {
  /** The clocks of the cycle that ended, no longer current; kept for reports. */
  readonly retired: Clock[];
  /** The next-response and resolution clocks, from the reopen time (§3.5). */
  readonly started: Clock[];
  readonly cycle: number;
}

/**
 * §3.5: "the first-response clock is replaced by a next-response clock with
 * the same target, starting at reopen time. The resolution clock restarts from
 * reopen time with the full target. The original satisfied/breached values are
 * preserved."
 */
export const reopenClocks = (input: ReconcileInput): Reopened => {
  const retired = input.clocks.map((clock) => ({
    ...stop(clock, input.calendarFor(clock.timeMode, input.facts.departmentId), input.at, 'closed'),
    isCurrent: false,
  }));
  const cycle = input.cycle + 1;

  return {
    retired,
    started: reconcileClocks({ ...input, clocks: [], cycle }),
    cycle,
  };
};

/** A response that counts (§3.1): the running response clock is met. */
export const respondClocks = (
  clocks: readonly Clock[],
  calendarFor: CalendarFor,
  departmentId: string,
  at: Date,
): Clock[] =>
  clocks.map((clock) =>
    isResponseClock(clock.kind) && isRunning(clock)
      ? satisfy(clock, calendarFor(clock.timeMode, departmentId), at)
      : clock,
  );

/** The four columns of `tickets` that summarise the clocks for lists and views. */
export interface TicketSlaColumns {
  readonly slaPolicyId: string | null;
  readonly firstResponseDueAt: Date | null;
  readonly resolutionDueAt: Date | null;
  readonly slaBreached: boolean;
}

export const summaryColumns = (
  clocks: readonly Clock[],
  policyId: string | null,
): TicketSlaColumns => {
  const response = clocks.find((clock) => isResponseClock(clock.kind));
  const resolution = clocks.find((clock) => clock.kind === 'resolution');
  const dueOf = (clock: Clock | undefined): Date | null =>
    clock !== undefined && isCounting(clock) ? clock.dueAt : null;

  return {
    slaPolicyId: policyId,
    firstResponseDueAt: dueOf(response),
    resolutionDueAt: dueOf(resolution),
    slaBreached: clocks.some((clock) => clock.breachedAt !== null),
  };
};
