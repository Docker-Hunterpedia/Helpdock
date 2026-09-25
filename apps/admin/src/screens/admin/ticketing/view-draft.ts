import type {
  TicketPriority,
  TicketSort,
  TicketSortDirection,
  TicketSystemState,
  TicketView,
  TicketViewCreateInput,
  TicketViewUpdateInput,
  TicketViewVisibility,
} from '@helpdock/schemas';
import {
  EMPTY_FILTERS,
  filtersOfView,
  LIVE_STATES,
  viewFiltersOf,
  type WorkspaceFilters,
} from '../../../tickets/views.js';

/**
 * The Views tab's editor card as data (M1-05, `Admin/Ticketing-Views`): what
 * the card holds while somebody edits a shared view, and how each of its
 * selects reads and writes the view's filters.
 *
 * The selects are coarser than the filters a view can hold — a view saved from
 * the workspace may name two statuses or three people — so every select has a
 * `saved` choice that stands for "whatever the view already says" and leaves
 * that part of the filters untouched. The card never rewrites a filter somebody
 * did not touch.
 */

export type Audience = 'brand' | 'departments';

export interface ViewDraft {
  readonly name: string;
  readonly nameAr: string;
  readonly audience: Audience;
  readonly departmentIds: readonly string[];
  readonly filters: WorkspaceFilters;
}

/** What a new shared view starts as: every live ticket, seen by the whole brand. */
export const draftOf = (view: TicketView | null): ViewDraft => {
  if (view === null) {
    return {
      name: '',
      nameAr: '',
      audience: 'brand',
      departmentIds: [],
      filters: { ...EMPTY_FILTERS, systemState: LIVE_STATES },
    };
  }

  return {
    name: view.name,
    nameAr: view.nameAr ?? '',
    audience: view.visibility.kind === 'departments' ? 'departments' : 'brand',
    departmentIds: view.visibility.kind === 'departments' ? view.visibility.departmentIds : [],
    filters: filtersOfView(view.filters),
  };
};

const visibilityOf = (draft: ViewDraft): TicketViewVisibility =>
  draft.audience === 'brand'
    ? { kind: 'brand' }
    : { kind: 'departments', departmentIds: [...draft.departmentIds] };

/** Whether the card can be saved: a name, and a department when it is shared with some. */
export const draftComplete = (draft: ViewDraft): boolean =>
  draft.name.trim() !== '' && (draft.audience === 'brand' || draft.departmentIds.length > 0);

export const createRequestOf = (draft: ViewDraft): TicketViewCreateInput => ({
  name: draft.name.trim(),
  nameAr: draft.nameAr.trim() === '' ? null : draft.nameAr.trim(),
  visibility: visibilityOf(draft),
  filters: viewFiltersOf(draft.filters),
});

/** A built-in view sends its names only: its filters and audience are fixed. */
export const updateRequestOf = (view: TicketView, draft: ViewDraft): TicketViewUpdateInput => {
  const names = {
    name: draft.name.trim(),
    nameAr: draft.nameAr.trim() === '' ? null : draft.nameAr.trim(),
  };

  return view.builtIn === null
    ? { ...names, visibility: visibilityOf(draft), filters: viewFiltersOf(draft.filters) }
    : names;
};

// ------------------------------------------------------------------ selects

/** "Whatever the view already says", for a combination the select cannot draw. */
export const SAVED = 'saved';

const sameStates = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((state) => right.includes(state));

export const STATE_CHOICES = ['any', 'live', 'open', 'on_hold', 'escalated', 'closed'] as const;
export type StateChoice = (typeof STATE_CHOICES)[number] | typeof SAVED;

export const stateChoice = (filters: WorkspaceFilters): StateChoice => {
  if (filters.statusId.length > 0) {
    return SAVED;
  }
  if (filters.systemState.length === 0) {
    return 'any';
  }
  if (sameStates(filters.systemState, LIVE_STATES)) {
    return 'live';
  }
  const [only] = filters.systemState;
  return filters.systemState.length === 1 && only !== undefined ? only : SAVED;
};

export const withStateChoice = (
  filters: WorkspaceFilters,
  choice: StateChoice,
): WorkspaceFilters => {
  if (choice === SAVED) {
    return filters;
  }
  const systemState: readonly TicketSystemState[] =
    choice === 'any' ? [] : choice === 'live' ? LIVE_STATES : [choice];

  return { ...filters, statusId: [], systemState };
};

export const ASSIGNEE_CHOICES = ['any', 'me', 'unassigned'] as const;
export type AssigneeChoice = (typeof ASSIGNEE_CHOICES)[number] | typeof SAVED;

export const assigneeChoice = (filters: WorkspaceFilters): AssigneeChoice => {
  const [only] = filters.assigneeId;
  if (only === undefined) {
    return 'any';
  }

  return filters.assigneeId.length === 1 && (only === 'me' || only === 'unassigned') ? only : SAVED;
};

export const withAssigneeChoice = (
  filters: WorkspaceFilters,
  choice: AssigneeChoice,
): WorkspaceFilters =>
  choice === SAVED ? filters : { ...filters, assigneeId: choice === 'any' ? [] : [choice] };

export type PriorityChoice = 'any' | TicketPriority | typeof SAVED;

export const priorityChoice = (filters: WorkspaceFilters): PriorityChoice => {
  const [only] = filters.priority;
  if (only === undefined) {
    return 'any';
  }

  return filters.priority.length === 1 ? only : SAVED;
};

export const withPriorityChoice = (
  filters: WorkspaceFilters,
  choice: PriorityChoice,
): WorkspaceFilters =>
  choice === SAVED ? filters : { ...filters, priority: choice === 'any' ? [] : [choice] };

/** The three orders the artboard offers, as `sort:direction`. */
export const SORT_CHOICES = ['updatedAt:desc', 'createdAt:asc', 'priority:desc'] as const;
export type SortChoice = `${TicketSort}:${TicketSortDirection}`;

export const sortChoice = (filters: WorkspaceFilters): SortChoice =>
  `${filters.sort}:${filters.direction}`;

export const withSortChoice = (filters: WorkspaceFilters, choice: SortChoice): WorkspaceFilters => {
  const [sort, direction] = choice.split(':') as [TicketSort, TicketSortDirection];
  return { ...filters, sort, direction };
};
