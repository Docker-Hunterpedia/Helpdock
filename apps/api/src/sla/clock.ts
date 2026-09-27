import {
  addBusinessTime,
  type BusinessCalendar,
  businessMsBetween,
  SLA_BREACH_PERCENT,
  type SlaClockKind,
  type SlaFiredStep,
  type SlaTimeMode,
} from '@helpdock/schemas';

/**
 * The arithmetic of one SLA clock (DOMAIN-RULES §3), as pure functions of a
 * clock value, a calendar and an instant. Nothing here reads the database or
 * the time: `ticket-clocks.ts` decides *which* of these to apply, and the
 * service persists what comes out.
 *
 * The one invariant everything leans on: **`elapsedMs` is the business time
 * consumed up to `checkpointAt`**, and while the clock is counting, whatever
 * runs after the checkpoint is measured under the calendar passed in. Every
 * transition therefore starts by moving the checkpoint to "now" under the
 * calendar the clock was counting in, so that a change of calendar only ever
 * affects time that has not been counted yet (§3.3).
 */

export type SlaStopReason = 'merged' | 'no_policy' | 'closed' | 'excluded';

export interface Clock {
  /** Undefined for a clock not stored yet. */
  readonly id?: string;
  readonly kind: SlaClockKind;
  readonly cycle: number;
  readonly isCurrent: boolean;
  readonly policyId: string | null;
  readonly targetMinutes: number;
  readonly timeMode: SlaTimeMode;
  readonly startedAt: Date;
  readonly elapsedMs: number;
  readonly checkpointAt: Date;
  readonly pausedAt: Date | null;
  readonly pausedTotalMs: number;
  readonly dueAt: Date | null;
  readonly satisfiedAt: Date | null;
  readonly breachedAt: Date | null;
  readonly breachCause: 'timer' | 'change' | null;
  readonly stoppedAt: Date | null;
  readonly stopReason: SlaStopReason | null;
  readonly firedSteps: readonly SlaFiredStep[];
}

const MINUTE_MS = 60_000;

/** Neither satisfied nor stopped: the clock still has an outcome to reach. */
export const isRunning = (clock: Clock): boolean =>
  clock.satisfiedAt === null && clock.stoppedAt === null;

/** Running and not paused: time is being counted right now. */
export const isCounting = (clock: Clock): boolean => isRunning(clock) && clock.pausedAt === null;

export const targetMs = (clock: Clock): number => clock.targetMinutes * MINUTE_MS;

/** Business time consumed at `at`. */
export const elapsedAt = (clock: Clock, calendar: BusinessCalendar, at: Date): number =>
  clock.elapsedMs + (isCounting(clock) ? businessMsBetween(calendar, clock.checkpointAt, at) : 0);

/** Business time left at `at`; negative once the target is used up. */
export const remainingAt = (clock: Clock, calendar: BusinessCalendar, at: Date): number =>
  targetMs(clock) - elapsedAt(clock, calendar, at);

/**
 * When the clock reaches `percent` of its target, counting from the
 * checkpoint. `null` while it is not counting — a paused clock is due at no
 * particular time (§3.2) — and for a calendar that never opens. A threshold
 * already passed is due at the checkpoint, which is "now" to whoever asks.
 */
export const timeOfPercent = (
  clock: Clock,
  calendar: BusinessCalendar,
  percent: number,
): Date | null => {
  if (!isCounting(clock)) {
    return null;
  }

  const threshold = (targetMs(clock) * percent) / 100;
  const left = threshold - clock.elapsedMs;
  if (left <= 0) {
    return clock.checkpointAt;
  }

  return addBusinessTime(calendar, clock.checkpointAt, left / MINUTE_MS);
};

/**
 * `due_at` as §3.2 defines it: `now + remaining` in business time. A clock
 * whose target is already used up keeps the due time it had, or the moment it
 * breached, rather than inventing one.
 */
const dueFor = (clock: Clock, calendar: BusinessCalendar): Date | null => {
  if (!isCounting(clock)) {
    return null;
  }
  if (clock.elapsedMs >= targetMs(clock)) {
    return clock.breachedAt ?? clock.dueAt ?? clock.checkpointAt;
  }

  return timeOfPercent(clock, calendar, SLA_BREACH_PERCENT);
};

/** Moves the checkpoint to `at`, counting what ran since under `calendar`. */
export const checkpoint = (clock: Clock, calendar: BusinessCalendar, at: Date): Clock =>
  isCounting(clock) && at > clock.checkpointAt
    ? { ...clock, elapsedMs: elapsedAt(clock, calendar, at), checkpointAt: at }
    : clock;

export interface ClockStart {
  readonly kind: SlaClockKind;
  readonly cycle: number;
  readonly policyId: string;
  readonly targetMinutes: number;
  readonly timeMode: SlaTimeMode;
}

/** A clock starting at `at`. Outside business hours it waits for the next opening (§3.1). */
export const startClock = (start: ClockStart, calendar: BusinessCalendar, at: Date): Clock => {
  const clock: Clock = {
    ...start,
    isCurrent: true,
    startedAt: at,
    elapsedMs: 0,
    checkpointAt: at,
    pausedAt: null,
    pausedTotalMs: 0,
    dueAt: null,
    satisfiedAt: null,
    breachedAt: null,
    breachCause: null,
    stoppedAt: null,
    stopReason: null,
    firedSteps: [],
  };

  return { ...clock, dueAt: dueFor(clock, calendar) };
};

/** §3.2: the clock stops advancing and has no due time until it resumes. */
export const pause = (clock: Clock, calendar: BusinessCalendar, at: Date): Clock => {
  if (!isCounting(clock)) {
    return clock;
  }

  return { ...checkpoint(clock, calendar, at), pausedAt: at, dueAt: null };
};

/** §3.2: `due_at = now + remaining`; the wall time paused is kept for reports. */
export const resume = (clock: Clock, calendar: BusinessCalendar, at: Date): Clock => {
  if (!isRunning(clock) || clock.pausedAt === null) {
    return clock;
  }

  const resumed: Clock = {
    ...clock,
    pausedAt: null,
    pausedTotalMs: clock.pausedTotalMs + Math.max(0, at.getTime() - clock.pausedAt.getTime()),
    checkpointAt: at,
  };

  return { ...resumed, dueAt: dueFor(resumed, calendar) };
};

export interface Retarget {
  readonly policyId: string;
  readonly targetMinutes: number;
  readonly timeMode: SlaTimeMode;
}

/**
 * §3.3: a change of priority, department or policy. Elapsed is what was
 * consumed under the **old** calendar; the rest is counted under the new one;
 * a target already used up is a breach recorded at the moment of the change.
 */
export const retarget = (
  clock: Clock,
  calendars: { readonly before: BusinessCalendar; readonly after: BusinessCalendar },
  target: Retarget,
  at: Date,
): Clock => {
  if (!isRunning(clock)) {
    return clock;
  }

  const counted = { ...checkpoint(clock, calendars.before, at), ...target };
  const breached =
    counted.breachedAt === null && counted.elapsedMs >= targetMs(counted)
      ? { breachedAt: at, breachCause: 'change' as const }
      : {};
  const next: Clock = { ...counted, ...breached };

  return { ...next, dueAt: dueFor(next, calendars.after) };
};

/**
 * The response arrived or the ticket closed. A clock met after its due time
 * whose breach timer had not run yet — Redis was down, say — is still a
 * breach, recorded at the due time it missed.
 */
export const satisfy = (clock: Clock, calendar: BusinessCalendar, at: Date): Clock => {
  if (!isRunning(clock)) {
    return clock;
  }

  const counted = settle(checkpoint(clock, calendar, at), at);
  const late =
    counted.breachedAt === null && counted.elapsedMs > targetMs(counted)
      ? { breachedAt: clock.dueAt ?? at, breachCause: 'timer' as const }
      : {};

  return { ...counted, ...late, satisfiedAt: at, dueAt: null };
};

/** Ends a clock with no verdict: merged, no policy applies, closed first, or spam. */
export const stop = (
  clock: Clock,
  calendar: BusinessCalendar,
  at: Date,
  reason: SlaStopReason,
): Clock => {
  if (!isRunning(clock)) {
    return clock;
  }

  return {
    ...settle(checkpoint(clock, calendar, at), at),
    stoppedAt: at,
    stopReason: reason,
    dueAt: null,
  };
};

/**
 * Undoes a stop: the merge was undone (§2.4), or a policy applies again. The
 * time between is excluded, because nothing was counting then.
 */
export const restart = (clock: Clock, calendar: BusinessCalendar, at: Date): Clock => {
  if (clock.stoppedAt === null || clock.satisfiedAt !== null) {
    return clock;
  }

  const restarted: Clock = {
    ...clock,
    stoppedAt: null,
    stopReason: null,
    pausedTotalMs: clock.pausedTotalMs + Math.max(0, at.getTime() - clock.stoppedAt.getTime()),
    checkpointAt: at,
  };

  return { ...restarted, dueAt: dueFor(restarted, calendar) };
};

/** The breach timer fired. Recorded once, at the due time rather than the job's lateness. */
export const breach = (clock: Clock, at: Date): Clock =>
  clock.breachedAt !== null
    ? clock
    : {
        ...clock,
        breachedAt: clock.dueAt !== null && clock.dueAt < at ? clock.dueAt : at,
        breachCause: 'timer',
      };

export const hasFired = (clock: Clock, percent: number): boolean =>
  clock.firedSteps.some((step) => step.percent === percent);

export const markFired = (clock: Clock, percent: number, at: Date): Clock =>
  hasFired(clock, percent)
    ? clock
    : { ...clock, firedSteps: [...clock.firedSteps, { percent, firedAt: at.toISOString() }] };

/** Folds a pause that is ending into the paused total, for a clock that is ending. */
const settle = (clock: Clock, at: Date): Clock =>
  clock.pausedAt === null
    ? clock
    : {
        ...clock,
        pausedAt: null,
        pausedTotalMs: clock.pausedTotalMs + Math.max(0, at.getTime() - clock.pausedAt.getTime()),
      };
