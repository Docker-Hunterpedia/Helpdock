import type { TicketStatus } from '@helpdock/schemas';
import type { WorkspaceFilters } from '../../tickets/views.js';

/**
 * Whether the list is already filtered to one status (M14-20): a status picked
 * by name, or one system state that only one status of the brand has. Every
 * row would then say the same word, so the row leaves it out.
 */
export const isSingleStatusView = (
  filters: Pick<WorkspaceFilters, 'statusId' | 'systemState'>,
  statuses: readonly TicketStatus[],
): boolean => {
  if (filters.statusId.length > 0) {
    return filters.statusId.length === 1;
  }

  const [state] = filters.systemState;
  if (filters.systemState.length !== 1 || state === undefined) {
    return false;
  }

  return statuses.filter((status) => status.systemState === state).length === 1;
};
