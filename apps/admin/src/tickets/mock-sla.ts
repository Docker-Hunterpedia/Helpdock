import type { Ticket, TicketSla, TicketSlaClock, TicketSlaSummary } from '@helpdock/schemas';
import { MOCK_SLA_POLICY_ID } from '../ticketing/mock-sla.js';

/**
 * The SLA a fixture ticket reads with (M3-02), derived from the due dates the
 * seed already gives it, so the list's SlaTimer and the DetailsPanel's card
 * agree with each other and with the M1 fixtures that set those dates.
 *
 * It is a picture of what the api would answer, not the engine: every ticket
 * with a due date runs under the fixture brand's "Support and Billing" policy
 * (2 h to respond, 8 h to resolve), in wall time.
 */

const FIRST_RESPONSE_MINUTES = 120;
const RESOLUTION_MINUTES = 480;
const MINUTE = 60_000;

const clockFor = (
  kind: TicketSlaClock['kind'],
  targetMinutes: number,
  due: string | null,
  ticket: Ticket,
  now: number,
): TicketSlaClock | null => {
  if (due === null && ticket.status.systemState !== 'closed') {
    return null;
  }
  const target = targetMinutes * MINUTE;
  const dueAt = due === null ? Date.parse(ticket.createdAt) + target : Date.parse(due);
  const startedAt = new Date(dueAt - target).toISOString();
  const closedAt = ticket.closedAt === null ? null : Date.parse(ticket.closedAt);
  const end = closedAt ?? now;
  const elapsed = Math.max(0, Math.min(end - (dueAt - target), end - Date.parse(startedAt)));
  const breached = dueAt < end;
  const paused = ticket.status.pausesSla && closedAt === null;

  return {
    kind,
    targetMinutes,
    startedAt,
    dueAt: closedAt !== null || paused ? null : new Date(dueAt).toISOString(),
    satisfiedAt: closedAt === null ? null : new Date(closedAt).toISOString(),
    breachedAt: breached ? new Date(dueAt).toISOString() : null,
    pausedAt: paused ? ticket.updatedAt : null,
    stoppedAt: null,
    elapsedMs: Math.round(elapsed),
    firedSteps: [],
  };
};

export const mockSlaOf = (ticket: Ticket, now: number): TicketSla | null => {
  const clocks = [
    clockFor('first_response', FIRST_RESPONSE_MINUTES, ticket.firstResponseDueAt, ticket, now),
    clockFor('resolution', RESOLUTION_MINUTES, ticket.resolutionDueAt, ticket, now),
  ].filter((clock): clock is TicketSlaClock => clock !== null);
  if (clocks.length === 0) {
    return null;
  }

  const running = clocks.filter((clock) => clock.satisfiedAt === null);
  const state =
    clocks.some((clock) => clock.breachedAt !== null) && running.length > 0
      ? 'breached'
      : running.length === 0
        ? 'met'
        : running.some((clock) => clock.pausedAt !== null)
          ? 'paused'
          : running.some(
                (clock) =>
                  clock.targetMinutes * MINUTE - clock.elapsedMs <
                  clock.targetMinutes * MINUTE * 0.2,
              )
            ? 'warning'
            : 'running';

  return {
    state,
    policyId: MOCK_SLA_POLICY_ID,
    policyName: 'Support and Billing',
    timeMode: 'business',
    clocks,
    lastStep: null,
    reopenedAt: null,
    initialResponse: null,
  };
};

export const mockSlaSummaryOf = (ticket: Ticket, now: number): TicketSlaSummary | null => {
  const sla = mockSlaOf(ticket, now);
  if (sla === null) {
    return null;
  }
  const leading =
    sla.clocks
      .filter((clock) => clock.satisfiedAt === null)
      .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'))[0] ?? sla.clocks[0];
  if (leading === undefined) {
    return null;
  }

  return {
    state: sla.state,
    clock: leading.kind,
    remainingMs: leading.targetMinutes * MINUTE - leading.elapsedMs,
    breachedAt: sla.clocks.find((clock) => clock.breachedAt !== null)?.breachedAt ?? null,
    reopened: false,
  };
};
