import { isDeepStrictEqual } from 'node:util';
import type { BulkChanges, BulkField, TicketPriority } from '@helpdock/schemas';
import { BULK_ME } from '@helpdock/schemas';

/**
 * The pure half of M14-03 (DOMAIN-RULES §2.7): what a set of changes asks of
 * one ticket, what moved, and what an Undo may put back.
 *
 * Nothing here reads the database. The service reads a ticket, hands its
 * {@link TicketSnapshot} in, and writes whatever comes out through the very
 * methods a single edit uses; these functions only decide.
 */

/** The fields of a ticket a bulk edit can move, as ids, enums and instants. */
export interface TicketSnapshot {
  readonly statusId: string;
  /** When the ticket was closed, so an Undo that closes it again restores the original. */
  readonly closedAt: string | null;
  readonly priority: TicketPriority;
  readonly assigneeId: string | null;
  readonly teamId: string | null;
  readonly departmentId: string;
  /** An ISO instant, normalised, or null when the ticket is not asleep. */
  readonly snoozedUntil: string | null;
  /** Sorted, so two snapshots of one set are equal. */
  readonly tagIds: readonly string[];
  /** The one custom field value the changes name; null when it has none. */
  readonly custom: unknown;
}

/** What a bulk edit stores of a ticket: only the keys that moved, never text. */
export type ItemValues = Partial<{
  statusId: string;
  closedAt: string | null;
  priority: TicketPriority;
  assigneeId: string | null;
  teamId: string | null;
  departmentId: string;
  snoozedUntil: string | null;
  tagIds: string[];
  custom: unknown;
}>;

export const normaliseInstant = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

export const sortedTagIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/**
 * The `PATCH` body the changes ask of one ticket, or `undefined` when they ask
 * nothing of its columns (tags and spam go through their own paths).
 *
 * `closedStatusId` is the brand's Closed status, resolved once per request.
 */
export const updateFor = (
  changes: BulkChanges,
  context: { readonly actorId: string; readonly closedStatusId: string | undefined },
): Record<string, unknown> | undefined => {
  const update: Record<string, unknown> = {};
  if (changes.priority !== undefined) update.priority = changes.priority;
  if (changes.assigneeId !== undefined) {
    update.assigneeId = changes.assigneeId === BULK_ME ? context.actorId : changes.assigneeId;
  }
  if (changes.teamId !== undefined) update.teamId = changes.teamId;
  if (changes.departmentId !== undefined) update.departmentId = changes.departmentId;
  if (changes.statusId !== undefined) update.statusId = changes.statusId;
  if (changes.close !== undefined && context.closedStatusId !== undefined) {
    update.statusId = context.closedStatusId;
  }
  if (changes.snoozedUntil !== undefined) update.snoozedUntil = changes.snoozedUntil;
  if (changes.customField !== undefined) {
    update.custom = Object.fromEntries([
      [changes.customField.key, changes.customField.value ?? null],
    ]);
  }

  return Object.keys(update).length === 0 ? undefined : update;
};

/** The tag set a ticket should carry after the changes, or `undefined` when they leave tags alone. */
export const tagsAfter = (
  changes: BulkChanges,
  current: readonly string[],
): string[] | undefined => {
  if (changes.addTagIds === undefined && changes.removeTagIds === undefined) {
    return undefined;
  }
  const removing = new Set(changes.removeTagIds ?? []);

  return sortedTagIds([...current, ...(changes.addTagIds ?? [])].filter((id) => !removing.has(id)));
};

/**
 * What moved between two snapshots, as the keys an item stores.
 *
 * Two consequences are not changes of their own. A snooze or a wake moves the
 * status as a consequence, so its item records the wake time and not the
 * status; and any other change of status clears a snooze, so that item records
 * the status and not the wake time. That keeps an Undo to one thing per ticket.
 */
export const itemDiff = (
  before: TicketSnapshot,
  after: TicketSnapshot,
  changes: BulkChanges,
): { readonly before: ItemValues; readonly after: ItemValues } => {
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  const note = (key: keyof TicketSnapshot): void => {
    from[key] = before[key];
    to[key] = after[key];
  };

  const snoozing = changes.snoozedUntil !== undefined;
  if (before.statusId !== after.statusId && !snoozing) {
    note('statusId');
    note('closedAt');
  }
  if (before.snoozedUntil !== after.snoozedUntil && snoozing) note('snoozedUntil');
  if (before.priority !== after.priority) note('priority');
  if (before.assigneeId !== after.assigneeId) note('assigneeId');
  if (before.teamId !== after.teamId) note('teamId');
  if (before.departmentId !== after.departmentId) note('departmentId');
  if (!isDeepStrictEqual(before.tagIds, after.tagIds)) note('tagIds');
  if (!isDeepStrictEqual(before.custom, after.custom)) note('custom');

  return { before: from as ItemValues, after: to as ItemValues };
};

/** `closedAt` travels with a status move and is not a field of its own. */
const FIELD_OF_KEY: Readonly<Record<Exclude<keyof ItemValues, 'closedAt'>, BulkField>> = {
  statusId: 'statusId',
  priority: 'priority',
  assigneeId: 'assigneeId',
  teamId: 'teamId',
  departmentId: 'departmentId',
  snoozedUntil: 'snoozedUntil',
  tagIds: 'tags',
  custom: 'custom',
};

/** The name the screens use for a stored key; a status move made by Mark spam is `spam`. */
export const fieldOf = (
  key: Exclude<keyof ItemValues, 'closedAt'>,
  changes: BulkChanges,
): BulkField => (key === 'statusId' && changes.spam !== undefined ? 'spam' : FIELD_OF_KEY[key]);

export const fieldsOf = (values: ItemValues, changes: BulkChanges): BulkField[] =>
  (Object.keys(values) as (keyof ItemValues)[])
    .filter((key): key is Exclude<keyof ItemValues, 'closedAt'> => key !== 'closedAt')
    .map((key) => fieldOf(key, changes));

/** What an Undo does to one ticket. */
export interface UndoPlan {
  /** The `PATCH` body that puts back the columns still holding the operation's value. */
  readonly update: Record<string, unknown> | undefined;
  /** The tag set to write, or `undefined` when tags are left alone. */
  readonly tagIds: string[] | undefined;
  /** The close time to restore when the update puts a ticket back into a closed status. */
  readonly closedAt: Date | null | undefined;
  readonly reverted: readonly BulkField[];
  readonly kept: readonly BulkField[];
}

/**
 * Puts back each field whose current value still equals what the operation set
 * (ADR 0036): a colleague's change in between survives, and is reported. Tags
 * are a set: the tags the operation added come off if still there, the ones it
 * removed go back if still gone, and a tag somebody else added is untouched.
 */
export const planUndo = (
  item: { readonly before: ItemValues; readonly after: ItemValues },
  current: TicketSnapshot,
  changes: BulkChanges,
  customKey: string | undefined,
): UndoPlan => {
  const update: Record<string, unknown> = {};
  const reverted: BulkField[] = [];
  const kept: BulkField[] = [];
  let tagIds: string[] | undefined;

  for (const key of Object.keys(item.after) as (keyof ItemValues)[]) {
    if (key === 'closedAt') {
      continue;
    }
    const field = fieldOf(key, changes);

    if (key === 'tagIds') {
      const before = new Set(item.before.tagIds ?? []);
      const after = new Set(item.after.tagIds ?? []);
      const added = [...after].filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !after.has(id));
      const now = new Set(current.tagIds);
      const next = new Set(now);
      for (const id of added) next.delete(id);
      for (const id of removed) next.add(id);
      if (isDeepStrictEqual(sortedTagIds(next), sortedTagIds(now))) {
        kept.push(field);
      } else {
        tagIds = sortedTagIds(next);
        reverted.push(field);
      }
      continue;
    }

    if (!isDeepStrictEqual(current[key], item.after[key])) {
      kept.push(field);
      continue;
    }

    reverted.push(field);
    if (key === 'custom' && customKey !== undefined) {
      update.custom = Object.fromEntries([[customKey, item.before.custom ?? null]]);
    } else if (key !== 'custom') {
      update[key] = item.before[key];
    }
  }

  return {
    update: Object.keys(update).length === 0 ? undefined : update,
    tagIds,
    closedAt:
      update.statusId === undefined || item.before.closedAt === undefined
        ? undefined
        : item.before.closedAt === null
          ? null
          : new Date(item.before.closedAt),
    reverted,
    kept,
  };
};
