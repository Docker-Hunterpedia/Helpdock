import {
  type ActivityVia,
  assignmentModeSchema,
  type ImportSource,
  ROUTING_STEPS_MAX,
  type RoutingActor,
  type RoutingChange,
  type RoutingDepartment,
  type RoutingNamed,
  type RoutingOrigin,
  type RoutingStep,
  type TicketChannel,
  type TicketRouting,
  ticketPrioritySchema,
} from '@helpdock/schemas';
import { z } from 'zod';
import { recordedArrival } from './arrival.js';

/**
 * M14-08: "How it got here", composed from the activity log (DOMAIN-RULES
 * §2.8). Pure, so every actor kind is proved without a database.
 *
 * The trail is the arrival, then every automatic department, team, priority
 * and assignee change after it, up to the first change a person made. From
 * there on the ticket is where a person put it, and the thread says who.
 */

export interface TrailTicket {
  readonly id: string;
  readonly channel: TicketChannel;
  readonly importSource: ImportSource | null;
}

export interface TrailRow {
  readonly actorType: 'staff' | 'visitor' | 'apikey' | 'system';
  readonly actorId: string;
  readonly action: string;
  readonly from: Readonly<Record<string, unknown>> | null;
  readonly to: Readonly<Record<string, unknown>> | null;
  readonly via: ActivityVia;
  readonly createdAt: Date;
}

/** What the rows name, as the reader's transaction could read it. Absent means gone. */
export interface TrailNames {
  readonly departments: ReadonlyMap<
    string,
    { readonly name: string; readonly nameAr: string | null }
  >;
  readonly teams: ReadonlyMap<string, string>;
  readonly staff: ReadonlyMap<string, string>;
  readonly rules: ReadonlyMap<string, string>;
}

export interface TrailIds {
  readonly departmentIds: ReadonlySet<string>;
  readonly teamIds: ReadonlySet<string>;
  readonly userIds: ReadonlySet<string>;
  readonly ruleIds: ReadonlySet<string>;
}

const RULE_ACTOR_PREFIX = 'rule:';
const ASSIGNMENT_ACTOR_ID = 'assignment';
const SLA_ACTOR_ID = 'sla';

/** What a person does that is not a change to where the ticket is: the trail reads on past it. */
const NOT_A_CHANGE = new Set(['ticket.replied', 'ticket.note_added', 'ticket.article_proposed']);

const uuid = z.uuid();
const idOf = (value: unknown): string | undefined => {
  const parsed = uuid.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const isPerson = (row: TrailRow): boolean =>
  row.actorType === 'staff' || row.actorType === 'apikey';

/** The row that filed this ticket: its creation, or the continuation that opened it. */
const isOrigin = (ticketId: string, row: TrailRow): boolean =>
  row.action === 'ticket.created' ||
  (row.action === 'ticket.continued' &&
    row.to?.ticketId === ticketId &&
    row.from?.ticketId !== ticketId);

const ruleIdOf = (row: TrailRow): string | undefined =>
  row.actorId.startsWith(RULE_ACTOR_PREFIX)
    ? idOf(row.actorId.slice(RULE_ACTOR_PREFIX.length))
    : undefined;

/** The rows the trail reads, in order: from the origin up to (not including) a person's change. */
const trailRows = (ticketId: string, rows: readonly TrailRow[]) => {
  const start = rows.findIndex((row) => isOrigin(ticketId, row));
  const origin = start === -1 ? undefined : rows[start];
  const after = rows.slice(start + 1);
  const end = after.findIndex((row) => isPerson(row) && !NOT_A_CHANGE.has(row.action));
  return { origin, changes: end === -1 ? after : after.slice(0, end) };
};

/** Every id the trail will name, so the caller can read the names in one query each. */
export const trailIds = (ticketId: string, rows: readonly TrailRow[]): TrailIds => {
  const departmentIds = new Set<string>();
  const teamIds = new Set<string>();
  const userIds = new Set<string>();
  const ruleIds = new Set<string>();
  const add = (set: Set<string>, value: unknown): void => {
    const id = idOf(value);
    if (id !== undefined) set.add(id);
  };
  const { origin, changes } = trailRows(ticketId, rows);
  if (origin !== undefined) {
    add(departmentIds, recordedArrival(origin.to)?.departmentId);
  }
  for (const row of changes) {
    add(departmentIds, row.to?.departmentId);
    add(teamIds, row.to?.teamId);
    add(userIds, row.to?.assigneeId);
    add(ruleIds, ruleIdOf(row));
  }
  return { departmentIds, teamIds, userIds, ruleIds };
};

const departmentOf = (id: string, names: TrailNames): RoutingDepartment => {
  const found = names.departments.get(id);
  return { id, name: found?.name ?? null, nameAr: found?.nameAr ?? null };
};

const namedOf = (id: string, from: ReadonlyMap<string, string>): RoutingNamed => ({
  id,
  name: from.get(id) ?? null,
});

const actorOf = (row: TrailRow, names: TrailNames): RoutingActor => {
  const ruleId = ruleIdOf(row);
  if (ruleId !== undefined) {
    // AI triage applies its changes as the rule that queued it, a moment
    // later; `via = ai` is what tells the two apart (M7-07).
    return {
      kind: row.via === 'ai' ? 'ai_triage' : 'rule',
      ruleId,
      name: names.rules.get(ruleId) ?? null,
    };
  }
  if (row.actorId === ASSIGNMENT_ACTOR_ID) {
    const mode = assignmentModeSchema.safeParse(row.to?.assignedBy);
    return { kind: 'assignment', mode: mode.success ? mode.data : null };
  }
  if (row.actorId === SLA_ACTOR_ID) {
    return { kind: 'sla' };
  }
  return { kind: 'system' };
};

/** Whether a row moved `key`: it names it, and to something other than what it was. */
const moved = (row: TrailRow, key: string): boolean =>
  row.to !== null && key in row.to && row.to[key] !== row.from?.[key];

/** What one `ticket.updated` row moved, in the order the card reads them. */
const changesOf = (row: TrailRow, names: TrailNames): RoutingChange[] => {
  const to = row.to ?? {};
  const changes: RoutingChange[] = [];

  const departmentId = moved(row, 'departmentId') ? idOf(to.departmentId) : undefined;
  const teamMoved = moved(row, 'teamId');
  const teamId = idOf(to.teamId);
  if (departmentId !== undefined || teamMoved) {
    changes.push({
      kind: 'moved',
      ...(departmentId === undefined ? {} : { department: departmentOf(departmentId, names) }),
      ...(teamMoved ? { team: teamId === undefined ? null : namedOf(teamId, names.teams) } : {}),
    });
  }

  const priority = ticketPrioritySchema.safeParse(to.priority);
  if (priority.success && moved(row, 'priority')) {
    const previous = ticketPrioritySchema.safeParse(row.from?.priority);
    changes.push({
      kind: 'priority',
      from: previous.success ? previous.data : null,
      to: priority.data,
    });
  }

  if (moved(row, 'assigneeId')) {
    const assigneeId = idOf(to.assigneeId);
    changes.push({
      kind: 'assigned',
      assignee: assigneeId === undefined ? null : namedOf(assigneeId, names.staff),
    });
  }

  return changes;
};

const originOf = (
  ticket: TrailTicket,
  row: TrailRow | undefined,
  names: TrailNames,
): RoutingOrigin => {
  const arrival = row === undefined ? undefined : recordedArrival(row.to);
  if (arrival === undefined) {
    return { kind: 'unrecorded', channel: ticket.channel };
  }
  return {
    kind: 'recorded',
    channel: ticket.channel,
    entry: arrival.entry,
    address: arrival.address ?? null,
    reason: arrival.reason,
    department: departmentOf(arrival.departmentId, names),
  };
};

export const composeTrail = (
  ticket: TrailTicket,
  rows: readonly TrailRow[],
  names: TrailNames,
): TicketRouting => {
  // M11: an import sends and runs nothing, so there is nothing to follow.
  if (ticket.importSource !== null) {
    return { origin: { kind: 'imported', source: ticket.importSource }, steps: [] };
  }

  const { origin, changes } = trailRows(ticket.id, rows);
  const steps: RoutingStep[] = [];
  for (const row of changes) {
    if (row.action !== 'ticket.updated' || row.actorType !== 'system') {
      continue;
    }
    const by = actorOf(row, names);
    const at = row.createdAt.toISOString();
    for (const change of changesOf(row, names)) {
      steps.push({ at, change, by });
    }
  }

  return { origin: originOf(ticket, origin, names), steps: steps.slice(0, ROUTING_STEPS_MAX) };
};
