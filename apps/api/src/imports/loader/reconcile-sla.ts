import { type DbTransaction, ticketStatuses, tickets } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { buildCalendars } from '../../sla/calendars.js';
import { type Clock, satisfy } from '../../sla/clock.js';
import { matchPolicy } from '../../sla/policy-match.js';
import { SlaRepository } from '../../sla/sla.repository.js';
import { isResponseClock, reconcileClocks, summaryColumns } from '../../sla/ticket-clocks.js';
import type { TicketLoad } from './contracts.js';

function importedResponseAt(clock: Clock, input: TicketLoad, now: Date): Date | null {
  if (!isResponseClock(clock.kind) || clock.satisfiedAt || clock.stoppedAt) return null;
  let first = Number.POSITIVE_INFINITY;
  for (const message of input.messages) {
    if (!message.public || message.authorKind !== 'agent') continue;
    const sent = Date.parse(message.createdAt);
    // A reply from before a staff reopen cannot satisfy its next-response clock.
    if (
      sent > now.getTime() ||
      (clock.kind === 'next_response' && sent < clock.startedAt.getTime())
    )
      continue;
    first = Math.min(first, Math.max(clock.startedAt.getTime(), sent));
  }
  return Number.isFinite(first) ? new Date(first) : null;
}

/** Parent is already locked by the writer; persist clocks without live hooks, events or timers. */
export async function reconcileImportedSla(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
  previousDepartmentId: string,
) {
  const [row] = await tx
    .select({ ticket: tickets, status: ticketStatuses })
    .from(tickets)
    .innerJoin(ticketStatuses, eq(tickets.statusId, ticketStatuses.id))
    .where(and(eq(tickets.brandId, input.brandId), eq(tickets.id, ticketId)));
  if (!row?.ticket.importSlaStartedAt) return;
  const repository = new SlaRepository();
  const clocks = await repository.currentClocks(tx, ticketId);
  const calendarFor = buildCalendars(await repository.calendarRows(tx, input.brandId));
  const policy = matchPolicy(await repository.policies(tx), row.ticket);
  const at = new Date();
  const replies = input.messages.filter(
    (message) => message.public && message.authorKind === 'agent',
  );
  const responded = replies.length > 0;
  const before = clocks.map((clock) => {
    const responseAt = importedResponseAt(clock, input, at);
    return responseAt
      ? satisfy(clock, calendarFor(clock.timeMode, previousDepartmentId), responseAt)
      : clock;
  });
  const after = reconcileClocks({
    clocks: before,
    cycle: row.ticket.slaCycle,
    facts: {
      departmentId: row.ticket.departmentId,
      previousDepartmentId,
      systemState: row.status.systemState,
      pausesSla: row.status.pausesSla,
      excludedFromReports: row.status.excludedFromReports,
      merged: row.ticket.mergedIntoId !== null,
      deleted: row.ticket.deletedAt !== null,
      responded,
    },
    policy: policy
      ? { id: policy.id, timeMode: policy.timeMode, target: policy.targets[row.ticket.priority] }
      : null,
    calendarFor,
    at,
  });
  await repository.saveClocks(tx, input.brandId, row.ticket, after);
  await repository.writeSummary(tx, row.ticket, {
    ...summaryColumns(after, policy?.id ?? null),
    slaCycle: row.ticket.slaCycle,
  });
}
