import type { Locale } from '@helpdock/i18n';
import type {
  TicketChannel,
  TicketPriority,
  TicketSort,
  TicketSortDirection,
  TicketSystemState,
  TicketView,
  TicketViewFilters,
  TicketViewFiltersInput,
} from '@helpdock/schemas';
import type { TicketQuery } from './api.js';

/**
 * Saved views on the client (M1-05): what a view resolves to, and how the URL
 * carries a view and the filters somebody changed on top of it.
 *
 * **A view is a list query with a name**, and its filters are the list's own
 * query schema, so resolving one is a copy: nothing is computed here that the
 * api does not compute again. `me` and `overdue` travel as they are and the
 * api evaluates them for the reader.
 *
 * **The URL is the state.** `?view=<id>` names the view. Changing a filter on
 * it writes the *whole* resulting filter set into the query string with
 * `custom=1`, so a changed view is still a link a colleague can open, "Filters
 * changed" is a comparison of the URL against the saved view, and Reset is
 * dropping the filter parameters. `?view=all` is the unfiltered desk, and no
 * `view` at all is the first view of the sidebar.
 */

export const ALL_VIEW = 'all';

/** Every filter the workspace carries, whether it came from a view or from the URL. */
export interface WorkspaceFilters {
  readonly statusId: readonly string[];
  readonly systemState: readonly TicketSystemState[];
  readonly priority: readonly TicketPriority[];
  /** People, `unassigned`, or `me`. */
  readonly assigneeId: readonly string[];
  readonly departmentId: readonly string[];
  readonly tagIds: readonly string[];
  readonly channel: readonly TicketChannel[];
  readonly overdue: boolean;
  readonly q: string;
  readonly sort: TicketSort;
  readonly direction: TicketSortDirection;
}

export const EMPTY_FILTERS: WorkspaceFilters = {
  statusId: [],
  systemState: [],
  priority: [],
  assigneeId: [],
  departmentId: [],
  tagIds: [],
  channel: [],
  overdue: false,
  q: '',
  sort: 'updatedAt',
  direction: 'desc',
};

/** The live states: everything not closed, which is what "open" means at a desk. */
export const LIVE_STATES: readonly TicketSystemState[] = ['open', 'on_hold', 'escalated'];

/** A saved view's filters as the workspace holds them. */
export const filtersOfView = (filters: TicketViewFilters): WorkspaceFilters => ({
  statusId: filters.statusId ?? [],
  systemState: filters.systemState ?? [],
  priority: filters.priority ?? [],
  assigneeId: filters.assigneeId ?? [],
  departmentId: filters.departmentId ?? [],
  // One filter, two spellings on the wire (M1-06); one here.
  tagIds: [...new Set([...(filters.tagId ?? []), ...(filters.tagIds ?? [])])],
  channel: filters.channel ?? [],
  overdue: filters.overdue ?? false,
  q: filters.q ?? '',
  sort: filters.sort,
  direction: filters.direction,
});

const some = <T>(values: readonly T[]): T[] | undefined =>
  values.length === 0 ? undefined : [...values];

/** What a view saves: every filter that is on, and the order. */
export const viewFiltersOf = (filters: WorkspaceFilters): TicketViewFiltersInput => {
  const saved: Record<string, unknown> = {
    statusId: some(filters.statusId),
    systemState: some(filters.systemState),
    priority: some(filters.priority),
    assigneeId: some(filters.assigneeId),
    departmentId: some(filters.departmentId),
    tagIds: some(filters.tagIds),
    channel: some(filters.channel),
    overdue: filters.overdue ? true : undefined,
    q: filters.q === '' ? undefined : filters.q,
    sort: filters.sort,
    direction: filters.direction,
  };

  return Object.fromEntries(
    Object.entries(saved).filter(([, value]) => value !== undefined),
  ) as TicketViewFiltersInput;
};

/** What the list is asked for. The api's defaults are left to the api. */
export const queryOf = (filters: WorkspaceFilters): TicketQuery => {
  const { sort, direction, ...rest } = viewFiltersOf(filters);

  return {
    ...rest,
    ...(sort === EMPTY_FILTERS.sort ? {} : { sort }),
    ...(direction === EMPTY_FILTERS.direction ? {} : { direction }),
  } as TicketQuery;
};

// ------------------------------------------------------------------ the URL

/** Short names, because they are what a person sees in a link they paste. */
const PARAM = {
  statusId: 'status',
  systemState: 'state',
  priority: 'priority',
  assigneeId: 'assignee',
  departmentId: 'department',
  tagIds: 'tag',
  channel: 'channel',
} as const;

const OVERDUE = 'overdue';
const SORT = 'sort';
const DIRECTION = 'dir';
const SEARCH = 'q';
/** Present when the URL's filters replace the view's rather than being empty. */
export const CUSTOM = 'custom';

const SORTS: readonly TicketSort[] = ['updatedAt', 'createdAt', 'number', 'priority'];

/** The filters as the query string carries them. */
export const filtersFromParams = (params: URLSearchParams): WorkspaceFilters => {
  const sort = params.get(SORT);
  return {
    statusId: params.getAll(PARAM.statusId),
    systemState: params.getAll(PARAM.systemState) as TicketSystemState[],
    priority: params.getAll(PARAM.priority) as TicketPriority[],
    assigneeId: params.getAll(PARAM.assigneeId),
    departmentId: params.getAll(PARAM.departmentId),
    tagIds: params.getAll(PARAM.tagIds),
    channel: params.getAll(PARAM.channel) as TicketChannel[],
    overdue: params.get(OVERDUE) === '1',
    q: params.get(SEARCH) ?? '',
    sort: SORTS.includes(sort as TicketSort) ? (sort as TicketSort) : EMPTY_FILTERS.sort,
    direction: params.get(DIRECTION) === 'asc' ? 'asc' : 'desc',
  };
};

/** `params` without any filter, keeping the view and anything else it carried. */
export const withoutFilters = (params: URLSearchParams): URLSearchParams => {
  const next = new URLSearchParams(params);
  for (const key of [...Object.values(PARAM), OVERDUE, SORT, DIRECTION, SEARCH, CUSTOM]) {
    next.delete(key);
  }

  return next;
};

/** `params` carrying exactly `filters`, marked as replacing the view's. */
export const withFilters = (
  params: URLSearchParams,
  filters: WorkspaceFilters,
): URLSearchParams => {
  const next = withoutFilters(params);
  for (const [field, key] of Object.entries(PARAM) as [keyof typeof PARAM, string][]) {
    for (const value of filters[field]) {
      next.append(key, value);
    }
  }
  if (filters.overdue) {
    next.set(OVERDUE, '1');
  }
  if (filters.q !== '') {
    next.set(SEARCH, filters.q);
  }
  if (filters.sort !== EMPTY_FILTERS.sort) {
    next.set(SORT, filters.sort);
  }
  if (filters.direction !== EMPTY_FILTERS.direction) {
    next.set(DIRECTION, filters.direction);
  }
  next.set(CUSTOM, '1');

  return next;
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && new Set([...left, ...right]).size === new Set(left).size;

/** Whether two filter sets ask for the same tickets in the same order. */
export const sameFilters = (left: WorkspaceFilters, right: WorkspaceFilters): boolean =>
  sameSet(left.statusId, right.statusId) &&
  sameSet(left.systemState, right.systemState) &&
  sameSet(left.priority, right.priority) &&
  sameSet(left.assigneeId, right.assigneeId) &&
  sameSet(left.departmentId, right.departmentId) &&
  sameSet(left.tagIds, right.tagIds) &&
  sameSet(left.channel, right.channel) &&
  left.overdue === right.overdue &&
  left.q === right.q &&
  left.sort === right.sort &&
  left.direction === right.direction;

// ---------------------------------------------------------------- resolving

/** The views the sidebar draws: shared first in the brand's order, then "Mine". */
export const sidebarViews = (
  views: readonly TicketView[],
): { readonly shared: readonly TicketView[]; readonly mine: readonly TicketView[] } => ({
  shared: views.filter((view) => view.visibility.kind !== 'personal' && !view.hidden),
  mine: views.filter((view) => view.visibility.kind === 'personal'),
});

/** The view a workspace opens on when the URL names none: the first in the sidebar. */
export const defaultView = (views: readonly TicketView[]): TicketView | null => {
  const { shared, mine } = sidebarViews(views);

  return shared[0] ?? mine[0] ?? null;
};

export interface ResolvedWorkspace {
  /** The view the URL names, or null for the whole desk. */
  readonly view: TicketView | null;
  readonly filters: WorkspaceFilters;
  /** The URL's filters replace the view's and ask for something else. */
  readonly changed: boolean;
}

/**
 * What the list shows: the view the URL names, and either its own filters or
 * the ones the URL replaced them with. A view id the reader cannot see — a
 * link from somebody else's personal view — falls back to the whole desk,
 * filtered by whatever the link carried.
 */
export const resolveWorkspace = (
  views: readonly TicketView[],
  params: URLSearchParams,
): ResolvedWorkspace => {
  const id = params.get('view');
  const view =
    id === ALL_VIEW
      ? null
      : id === null
        ? defaultView(views)
        : (views.find((candidate) => candidate.id === id) ?? null);

  if (view === null) {
    return { view, filters: filtersFromParams(params), changed: false };
  }

  const saved = filtersOfView(view.filters);
  if (!params.has(CUSTOM)) {
    return { view, filters: saved, changed: false };
  }

  const filters = filtersFromParams(params);
  return { view, filters, changed: !sameFilters(filters, saved) };
};

/** A view's name in the reader's language, falling back to the one it was given. */
export const viewLabel = (view: TicketView, locale: Locale): string =>
  locale === 'ar' && view.nameAr !== null && view.nameAr !== '' ? view.nameAr : view.name;

/** How many chips a filter set has on, for the count beside the Filter button. */
export const activeFilterCount = (filters: WorkspaceFilters): number =>
  filters.statusId.length +
  filters.systemState.length +
  filters.priority.length +
  filters.assigneeId.length +
  filters.departmentId.length +
  filters.tagIds.length +
  filters.channel.length +
  (filters.overdue ? 1 : 0);

// ------------------------------------------------------------------ intents

/**
 * Something the sidebar asks the workspace to do once it is on screen: open
 * the filters of the view it named ("Edit filters"), or the "Save as a view"
 * dialog (the + beside Views). The workspace acts on it and drops it from the
 * URL, so a reload or the back button never opens a dialog by itself.
 */
export const INTENT = 'intent';
export type WorkspaceIntent = 'filters' | 'save';

export const intentOf = (params: URLSearchParams): WorkspaceIntent | null => {
  const intent = params.get(INTENT);
  return intent === 'filters' || intent === 'save' ? intent : null;
};

/** The query string of a link to a view, optionally with an intent. */
export const viewSearch = (viewId: string, intent?: WorkspaceIntent): string => {
  const params = new URLSearchParams({ view: viewId });
  if (intent !== undefined) {
    params.set(INTENT, intent);
  }

  return `?${params.toString()}`;
};

/** Which sidebar row is current: the one the URL names, or the one the desk opens on. */
export const selectedViewId = (views: readonly TicketView[], params: URLSearchParams): string =>
  params.get('view') ?? defaultView(views)?.id ?? ALL_VIEW;
