import {
  SLA_BREACH_PERCENT,
  SLA_WARNING_FRACTION,
  type SlaEscalationStep,
  type SlaState,
  type TicketSla,
  type TicketSlaClock,
  type TicketSlaSummary,
} from '@helpdock/schemas';
import { type Clock, elapsedAt, isCounting, isRunning, remainingAt, targetMs } from './clock.js';
import { type CalendarFor, isResponseClock } from './ticket-clocks.js';

/**
 * How a ticket's clocks read on screen (artboard `Admin/Ticket-SLA`): "colour
 * by the worst clock still counting: success, warning (< 20 % left or a step
 * fired), danger once breached, neutral while paused".
 */

const ORDER: Record<SlaState, number> = {
  breached: 5,
  warning: 4,
  running: 3,
  paused: 2,
  met: 1,
  none: 0,
};

const stepFired = (clock: Clock): boolean =>
  clock.firedSteps.some((step) => step.percent < SLA_BREACH_PERCENT);

/** The state of one clock at `at`. */
export const clockState = (
  clock: Clock,
  calendarFor: CalendarFor,
  departmentId: string,
  at: Date,
): SlaState => {
  if (clock.breachedAt !== null) {
    return 'breached';
  }
  if (clock.satisfiedAt !== null) {
    return 'met';
  }
  if (clock.stoppedAt !== null) {
    return 'none';
  }
  if (clock.pausedAt !== null) {
    return 'paused';
  }

  const remaining = remainingAt(clock, calendarFor(clock.timeMode, departmentId), at);
  if (remaining <= 0) {
    return 'breached';
  }

  return stepFired(clock) || remaining / targetMs(clock) < SLA_WARNING_FRACTION
    ? 'warning'
    : 'running';
};

/**
 * The ticket's state: the worst clock still counting decides; a ticket whose
 * clocks have all ended reads as met, or as breached if either breached.
 */
export const ticketState = (
  clocks: readonly Clock[],
  calendarFor: CalendarFor,
  departmentId: string,
  at: Date,
): SlaState => {
  const running = clocks.filter(isRunning);
  const judged = (running.length > 0 ? running : clocks).map((clock) =>
    clockState(clock, calendarFor, departmentId, at),
  );

  return judged.reduce<SlaState>(
    (worst, state) => (ORDER[state] > ORDER[worst] ? state : worst),
    'none',
  );
};

/** The clock the bar and the list follow: the running one due first. */
const leadingClock = (clocks: readonly Clock[]): Clock | undefined => {
  const counting = clocks
    .filter(isCounting)
    .sort(
      (a, b) =>
        (a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) -
        (b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY),
    );

  return (
    counting[0] ??
    clocks.find(isRunning) ??
    clocks.find((clock) => clock.breachedAt !== null) ??
    clocks.find((clock) => clock.kind === 'resolution') ??
    clocks[0]
  );
};

/** The list row's SlaTimer, or null when no policy has ever applied. */
export const summaryOf = (
  clocks: readonly Clock[],
  calendarFor: CalendarFor,
  departmentId: string,
  at: Date,
): TicketSlaSummary | null => {
  const state = ticketState(clocks, calendarFor, departmentId, at);
  const clock = leadingClock(clocks);
  if (clock === undefined || state === 'none') {
    return null;
  }

  const breached =
    clocks.find((candidate) => candidate.breachedAt !== null && isRunning(candidate)) ??
    clocks.find((candidate) => candidate.breachedAt !== null);

  return {
    state,
    clock: clock.kind,
    remainingMs: Math.round(remainingAt(clock, calendarFor(clock.timeMode, departmentId), at)),
    breachedAt: breached?.breachedAt?.toISOString() ?? null,
    reopened: clocks.some((candidate) => candidate.kind === 'next_response') || clock.cycle > 0,
  };
};

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export const toTicketSlaClock = (
  clock: Clock,
  calendarFor: CalendarFor,
  departmentId: string,
  at: Date,
): TicketSlaClock => ({
  kind: clock.kind,
  targetMinutes: clock.targetMinutes,
  startedAt: clock.startedAt.toISOString(),
  dueAt: iso(clock.dueAt),
  satisfiedAt: iso(clock.satisfiedAt),
  breachedAt: iso(clock.breachedAt),
  pausedAt: iso(clock.pausedAt),
  stoppedAt: iso(clock.stoppedAt),
  elapsedMs: Math.max(
    0,
    Math.round(elapsedAt(clock, calendarFor(clock.timeMode, departmentId), at)),
  ),
  firedSteps: [...clock.firedSteps],
});

export interface TicketSlaViewInput {
  readonly clocks: readonly Clock[];
  readonly calendarFor: CalendarFor;
  readonly departmentId: string;
  readonly at: Date;
  readonly policy: {
    readonly id: string;
    readonly name: string;
    readonly timeMode: 'business' | 'calendar';
    readonly escalation: readonly SlaEscalationStep[];
  } | null;
  readonly initialResponse:
    | { readonly satisfiedAt: Date | null; readonly breachedAt: Date | null }
    | undefined;
}

/** The DetailsPanel SLA card. */
export const ticketSlaView = ({
  clocks,
  calendarFor,
  departmentId,
  at,
  policy,
  initialResponse,
}: TicketSlaViewInput): TicketSla => {
  const ordered = [...clocks].sort(
    (a, b) => Number(isResponseClock(b.kind)) - Number(isResponseClock(a.kind)),
  );
  const fired = ordered
    .flatMap((clock) => clock.firedSteps.map((step) => ({ clock: clock.kind, ...step })))
    .sort((a, b) => a.firedAt.localeCompare(b.firedAt));
  const last = fired.at(-1);
  const reopened = ordered.find((clock) => clock.cycle > 0);
  const state = ordered.length === 0 ? 'none' : ticketState(ordered, calendarFor, departmentId, at);

  return {
    state,
    policyId: policy?.id ?? null,
    policyName: policy?.name ?? null,
    timeMode: policy?.timeMode ?? null,
    clocks:
      state === 'none'
        ? []
        : ordered.map((clock) => toTicketSlaClock(clock, calendarFor, departmentId, at)),
    lastStep:
      last === undefined
        ? null
        : {
            clock: last.clock,
            percent: last.percent,
            firedAt: last.firedAt,
            actions:
              policy?.escalation.find((step) => step.atPercent === last.percent)?.actions ?? [],
          },
    reopenedAt: iso(reopened?.startedAt ?? null),
    initialResponse:
      reopened === undefined || initialResponse === undefined
        ? null
        : initialResponse.breachedAt !== null
          ? 'breached'
          : initialResponse.satisfiedAt !== null
            ? 'met'
            : null,
  };
};
