import type {
  BulkChanges,
  BulkField,
  Ticket,
  TicketStatus,
  TicketUpdateRequest,
} from '@helpdock/schemas';
import { BULK_ME } from '@helpdock/schemas';

/**
 * The bulk edit's rules as the fixture keeps them (M14-04). The api runs every
 * ticket through the very code a single edit uses; the fixture runs each one
 * through `MockTicketsApi.update`, and this module only decides, for one ticket
 * and one set of changes, what would move and whether a rule refuses it.
 *
 * It models the refusals a screen has to draw — a closed ticket cannot be
 * snoozed, a merged ticket's status and department belong to its primary — and
 * nothing else.
 */

/** What a bulk edit reads and writes of a ticket, so Undo can compare before and after. */
export interface BulkSnapshot {
  readonly statusId: string;
  readonly priority: Ticket['priority'];
  readonly assigneeId: string | null;
  readonly teamId: string | null;
  readonly departmentId: string;
  readonly snoozedUntil: string | null;
  readonly tagIds: readonly string[];
  readonly custom: unknown;
}

export interface BulkContext {
  readonly statuses: readonly TicketStatus[];
  readonly meId: string;
  readonly snoozedStatusId: string;
}

export type BulkPlan =
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'refused'; readonly code: string }
  | {
      readonly outcome: 'will_change';
      readonly fields: BulkField[];
      readonly before: BulkSnapshot;
      readonly after: BulkSnapshot;
    };

export const snapshotOf = (ticket: Ticket, customKey?: string): BulkSnapshot => ({
  statusId: ticket.status.id,
  priority: ticket.priority,
  assigneeId: ticket.assigneeId,
  teamId: ticket.teamId,
  departmentId: ticket.departmentId,
  snoozedUntil: ticket.snoozedUntil ?? null,
  tagIds: (ticket.tags ?? []).map((tag) => tag.id),
  custom: customKey === undefined ? null : (ticket.custom[customKey] ?? null),
});

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id) => right.includes(id));

/** The status a change leads to, or `undefined` when the changes leave it alone. */
const targetStatus = (changes: BulkChanges, context: BulkContext): string | undefined => {
  if (changes.statusId !== undefined) {
    return changes.statusId;
  }
  if (changes.close === true) {
    return context.statuses.find(
      (status) => status.systemState === 'closed' && !status.isSpam && !status.excludedFromReports,
    )?.id;
  }
  if (changes.spam === true) {
    return context.statuses.find((status) => status.isSpam)?.id;
  }

  return undefined;
};

export function planBulk(ticket: Ticket, changes: BulkChanges, context: BulkContext): BulkPlan {
  const closed = ticket.status.systemState === 'closed';
  if (changes.snoozedUntil != null && closed) {
    return { outcome: 'refused', code: 'ticket-closed' };
  }
  const movesStatusOrDepartment =
    changes.statusId !== undefined ||
    changes.close === true ||
    changes.spam === true ||
    changes.departmentId !== undefined;
  if (ticket.mergedIntoId !== null && movesStatusOrDepartment) {
    return { outcome: 'refused', code: 'ticket-merged' };
  }

  const before = snapshotOf(ticket, changes.customField?.key);
  const status = targetStatus(changes, context);
  const tagged = [...before.tagIds, ...(changes.addTagIds ?? [])].filter(
    (id) => !(changes.removeTagIds ?? []).includes(id),
  );
  const after: BulkSnapshot = {
    statusId:
      changes.snoozedUntil != null && ticket.status.id !== context.snoozedStatusId
        ? context.snoozedStatusId
        : (status ?? before.statusId),
    priority: changes.priority ?? before.priority,
    assigneeId:
      changes.assigneeId === undefined
        ? before.assigneeId
        : changes.assigneeId === BULK_ME
          ? context.meId
          : changes.assigneeId,
    teamId: changes.teamId === undefined ? before.teamId : changes.teamId,
    departmentId: changes.departmentId ?? before.departmentId,
    snoozedUntil: changes.snoozedUntil === undefined ? before.snoozedUntil : changes.snoozedUntil,
    tagIds: [...new Set(tagged)],
    custom: changes.customField === undefined ? before.custom : changes.customField.value,
  };

  const fields: BulkField[] = [];
  if (status !== undefined && status !== before.statusId) {
    fields.push(changes.spam === true ? 'spam' : 'statusId');
  }
  if (after.priority !== before.priority) {
    fields.push('priority');
  }
  if (after.assigneeId !== before.assigneeId) {
    fields.push('assigneeId');
  }
  if (after.teamId !== before.teamId) {
    fields.push('teamId');
  }
  if (after.departmentId !== before.departmentId) {
    fields.push('departmentId');
  }
  if (after.snoozedUntil !== before.snoozedUntil) {
    fields.push('snoozedUntil');
  }
  if (!sameSet(after.tagIds, before.tagIds)) {
    fields.push('tags');
  }
  if (JSON.stringify(after.custom) !== JSON.stringify(before.custom)) {
    fields.push('custom');
  }

  return fields.length === 0
    ? { outcome: 'unchanged' }
    : { outcome: 'will_change', fields, before, after };
}

/** The single-edit request that makes a plan's changes, tags aside (those have their own call). */
export function updateOf(
  plan: Extract<BulkPlan, { outcome: 'will_change' }>,
  changes: BulkChanges,
): TicketUpdateRequest {
  const { before, after } = plan;
  const snoozing = changes.snoozedUntil !== undefined;

  return {
    ...(!snoozing && after.statusId !== before.statusId ? { statusId: after.statusId } : {}),
    ...(after.priority !== before.priority ? { priority: after.priority } : {}),
    ...(after.assigneeId !== before.assigneeId ? { assigneeId: after.assigneeId } : {}),
    ...(after.teamId !== before.teamId ? { teamId: after.teamId } : {}),
    ...(after.departmentId !== before.departmentId ? { departmentId: after.departmentId } : {}),
    ...(snoozing && after.snoozedUntil !== before.snoozedUntil
      ? { snoozedUntil: after.snoozedUntil }
      : {}),
    ...(changes.customField !== undefined &&
    JSON.stringify(after.custom) !== JSON.stringify(before.custom)
      ? { custom: { [changes.customField.key]: after.custom } }
      : {}),
  };
}

/** The fields an Undo compares one value of, and which snapshot value each reads. */
const SCALAR_FIELDS = {
  statusId: 'statusId',
  spam: 'statusId',
  priority: 'priority',
  assigneeId: 'assigneeId',
  teamId: 'teamId',
  departmentId: 'departmentId',
  snoozedUntil: 'snoozedUntil',
} as const satisfies Partial<Record<BulkField, keyof BulkSnapshot>>;

const isScalar = (field: BulkField): field is keyof typeof SCALAR_FIELDS => field in SCALAR_FIELDS;

/**
 * What an Undo puts back: each field whose current value is still what the
 * operation set, and the fields it leaves because somebody changed them since.
 * Tags are compared as a set; a custom value is not undone by the fixture.
 */
export function undoPlan(
  current: BulkSnapshot,
  before: BulkSnapshot,
  after: BulkSnapshot,
  fields: readonly BulkField[],
): {
  readonly reverted: BulkField[];
  readonly kept: BulkField[];
  readonly update: TicketUpdateRequest;
  readonly tagIds: readonly string[] | null;
} {
  const reverted: BulkField[] = [];
  const kept: BulkField[] = [];
  // Keyed by the snapshot's own names, which are the request's too.
  const update: Record<string, unknown> = {};
  let tagIds: readonly string[] | null = null;

  for (const field of fields) {
    if (isScalar(field)) {
      const key = SCALAR_FIELDS[field];
      if (current[key] === after[key]) {
        reverted.push(field);
        update[key] = before[key];
      } else {
        kept.push(field);
      }
    } else if (field === 'tags' && sameSet(current.tagIds, after.tagIds)) {
      reverted.push(field);
      tagIds = before.tagIds;
    } else {
      kept.push(field);
    }
  }

  return { reverted, kept, update: update as TicketUpdateRequest, tagIds };
}
