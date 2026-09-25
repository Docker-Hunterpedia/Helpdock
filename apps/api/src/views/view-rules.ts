import type { BrandRole } from '@helpdock/schemas';
import { roleHasPermission } from '../auth/permissions.js';

/**
 * Who may see and change which view (M1-05). DOMAIN-RULES §1.2 transcribed for
 * one more kind of configuration; when the two disagree, this file is wrong.
 *
 * | View | Sees it | Changes it |
 * |---|---|---|
 * | Personal | Its owner (row-level security) | Its owner |
 * | Shared with the brand | Everybody in the brand | Admin, or a Team Leader with every department |
 * | Shared with departments | Staff whose scope reaches one of them | Admin, or a Team Leader who leads all of them |
 *
 * "Changes it" for a shared view needs `ticketing:manage` too, which is how an
 * Agent or a Viewer is kept out: they save personal views only.
 *
 * Seeing a shared view grants nothing. It resolves to a list query that runs
 * under the reader's own department policy, so a view shared with Billing
 * shows a Support agent's Billing tickets — none.
 *
 * Pure functions of values the caller has already read, so the rule is
 * testable without a database.
 */

export interface ViewActor {
  readonly userId: string;
  readonly role: BrandRole;
  /** `'all'` for an Admin, and for an unrestricted Team Leader or Viewer. */
  readonly departmentIds: readonly string[] | 'all';
}

/** Null is the whole brand; an array is those departments. */
export type ViewAudience = readonly string[] | null;

export const managesViews = (actor: ViewActor): boolean =>
  roleHasPermission(actor.role, 'ticketing:manage');

/** Whether a shared view with this audience belongs in the actor's sidebar. */
export const seesSharedView = (actor: ViewActor, audience: ViewAudience): boolean =>
  audience === null ||
  actor.departmentIds === 'all' ||
  audience.some((departmentId) => actor.departmentIds.includes(departmentId));

/**
 * Whether the actor may create, change, share into or delete a shared view
 * with this audience. A Team Leader restricted to some departments may share
 * only with departments they lead — never with the whole brand, which would put
 * a view in sidebars they have no say over.
 */
export const editsSharedView = (actor: ViewActor, audience: ViewAudience): boolean => {
  if (!managesViews(actor)) {
    return false;
  }
  if (actor.role === 'admin' || actor.departmentIds === 'all') {
    return true;
  }
  if (audience === null) {
    return false;
  }

  const led = actor.departmentIds;
  return audience.every((departmentId) => led.includes(departmentId));
};
