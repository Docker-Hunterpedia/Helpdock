import type { TicketStatus } from '@helpdock/schemas';
import type { WorkspaceFilters } from '../../tickets/views.js';

/**
 * The one status a view is filtered to (M14-20), or `null` when it is not
 * filtered to exactly one: a status picked by name, or one system state that
 * only one status of the brand has.
 *
 * A row leaves its status word out only when its own status is this one. The
 * api lists the tickets a search term names whatever the view's filters (#221),
 * so a row in an Escalated view can still be an Open ticket and must say so.
 */
export const singleStatusOf = (
  filters: Pick<WorkspaceFilters, 'statusId' | 'systemState'>,
  statuses: readonly TicketStatus[],
): string | null => {
  if (filters.statusId.length > 0) {
    return filters.statusId.length === 1 ? (filters.statusId[0] ?? null) : null;
  }

  const [state] = filters.systemState;
  if (filters.systemState.length !== 1 || state === undefined) {
    return null;
  }

  const ofState = statuses.filter((status) => status.systemState === state);

  return ofState.length === 1 ? (ofState[0]?.id ?? null) : null;
};
