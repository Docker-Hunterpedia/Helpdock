import type { BrandRole } from '@helpdock/schemas';

/**
 * Who may see, use and change which macro or canned response (M3-06).
 * DOMAIN-RULES §1.2 transcribed for one more kind of configuration — a Team
 * Leader's "departments they lead: … macros, canned responses" — and the
 * artboard's sentence: "Shared items are edited by Admins and by Team Leaders
 * of the department. Every agent in it can use them. Anyone can keep personal
 * ones."
 *
 * | Item | Sees and uses it | Changes it |
 * |---|---|---|
 * | Personal | Its owner (row-level security) | Its owner |
 * | Shared with every department | Everybody in the brand | Admin, or a Team Leader with every department |
 * | Shared with one department | Staff whose scope reaches it | Admin, or a Team Leader who leads it |
 *
 * Seeing one grants nothing: a reply sent with it runs under the sender's own
 * ticket policies, which is why the database only enforces the owner rule.
 *
 * Pure functions of values the caller has already read, so the rule is
 * testable without a database.
 */

export interface MacroActor {
  readonly userId: string;
  readonly role: BrandRole;
  /** `'all'` for an Admin, and for an unrestricted Team Leader or Viewer. */
  readonly departmentIds: readonly string[] | 'all';
}

export interface MacroOwnership {
  /** Null for a shared one. */
  readonly ownerId: string | null;
  /** Shared only: null is every department. */
  readonly departmentId: string | null;
}

const reaches = (actor: MacroActor, departmentId: string): boolean =>
  actor.departmentIds === 'all' || actor.departmentIds.includes(departmentId);

/** Whether the item belongs in the actor's list at all. */
export const seesMacro = (actor: MacroActor, item: MacroOwnership): boolean => {
  if (item.ownerId !== null) {
    return item.ownerId === actor.userId;
  }

  return item.departmentId === null || reaches(actor, item.departmentId);
};

/** Whether the actor may change or delete it, or create one shaped like it. */
export const editsMacro = (actor: MacroActor, item: MacroOwnership): boolean => {
  if (item.ownerId !== null) {
    return item.ownerId === actor.userId;
  }
  if (actor.role === 'admin') {
    return true;
  }
  if (actor.role !== 'team_leader') {
    return false;
  }
  if (actor.departmentIds === 'all') {
    return true;
  }

  // A Team Leader restricted to some departments shares only into one they
  // lead — never with the whole brand, which would put an item in composers
  // they have no say over.
  return item.departmentId !== null && actor.departmentIds.includes(item.departmentId);
};

/**
 * Whether the item is offered on a ticket of this department: the composer's
 * "only items shared with Billing, shared with all departments, or your own".
 */
export const usableIn = (item: MacroOwnership, departmentId: string): boolean =>
  item.ownerId !== null || item.departmentId === null || item.departmentId === departmentId;
