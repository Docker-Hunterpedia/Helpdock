import type { TicketView } from '@helpdock/schemas';
import { ticketViewFiltersSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  CUSTOM,
  defaultView,
  EMPTY_FILTERS,
  filtersFromParams,
  filtersOfView,
  queryOf,
  resolveWorkspace,
  sameFilters,
  sidebarViews,
  viewFiltersOf,
  viewLabel,
  withFilters,
  withoutFilters,
} from './views.js';

const TAG = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

const view = (overrides: Partial<TicketView> & Pick<TicketView, 'id'>): TicketView => ({
  name: overrides.id,
  nameAr: null,
  visibility: { kind: 'brand' },
  builtIn: null,
  departmentId: null,
  filters: ticketViewFiltersSchema.parse({ systemState: ['open'] }),
  hidden: false,
  sortOrder: 0,
  editable: true,
  ...overrides,
});

const shared = view({ id: 'shared' });
const hidden = view({ id: 'hidden', hidden: true });
const mine = view({ id: 'mine', visibility: { kind: 'personal' } });

describe('filtersOfView and viewFiltersOf', () => {
  it('round-trip a view, folding both tag spellings into one', () => {
    const saved = ticketViewFiltersSchema.parse({
      assigneeId: ['me'],
      tagId: [TAG],
      overdue: true,
      sort: 'number',
    });

    const workspace = filtersOfView(saved);

    expect(workspace.tagIds).toEqual([TAG]);
    expect(viewFiltersOf(workspace)).toEqual({
      assigneeId: ['me'],
      tagIds: [TAG],
      overdue: true,
      sort: 'number',
      direction: 'desc',
    });
  });
});

describe('queryOf', () => {
  it('leaves the api’s defaults to the api', () => {
    expect(queryOf({ ...EMPTY_FILTERS, priority: ['urgent'] })).toEqual({ priority: ['urgent'] });
  });

  it('sends an order that is not the default', () => {
    expect(queryOf({ ...EMPTY_FILTERS, sort: 'priority', direction: 'asc' })).toEqual({
      sort: 'priority',
      direction: 'asc',
    });
  });
});

describe('the URL', () => {
  it('carries every filter and reads it back', () => {
    const filters = {
      ...EMPTY_FILTERS,
      systemState: ['open', 'escalated'] as const,
      assigneeId: ['me'],
      tagIds: [TAG],
      overdue: true,
      q: 'refund',
      sort: 'createdAt' as const,
      direction: 'asc' as const,
    };

    const params = withFilters(new URLSearchParams('view=v1'), filters);

    expect(params.get('view')).toBe('v1');
    expect(params.get(CUSTOM)).toBe('1');
    expect(sameFilters(filtersFromParams(params), filters)).toBe(true);
  });

  it('drops the filters and keeps the view on reset', () => {
    const params = withFilters(new URLSearchParams('view=v1'), EMPTY_FILTERS);

    expect(withoutFilters(params).toString()).toBe('view=v1');
  });

  it('ignores a sort it does not know', () => {
    expect(filtersFromParams(new URLSearchParams('sort=nonsense')).sort).toBe('updatedAt');
  });
});

describe('sameFilters', () => {
  it('does not care about the order of chips', () => {
    expect(
      sameFilters(
        { ...EMPTY_FILTERS, priority: ['high', 'urgent'] },
        { ...EMPTY_FILTERS, priority: ['urgent', 'high'] },
      ),
    ).toBe(true);
  });

  it('notices a changed order', () => {
    expect(sameFilters(EMPTY_FILTERS, { ...EMPTY_FILTERS, direction: 'asc' })).toBe(false);
  });
});

describe('sidebarViews and defaultView', () => {
  it('puts shared views first, leaves hidden ones out, and personal ones under Mine', () => {
    expect(sidebarViews([mine, hidden, shared])).toEqual({ shared: [shared], mine: [mine] });
  });

  it('opens on the first shared view', () => {
    expect(defaultView([hidden, shared, mine])).toBe(shared);
  });

  it('opens on the first personal view when nothing is shared', () => {
    expect(defaultView([mine])).toBe(mine);
    expect(defaultView([])).toBeNull();
  });
});

describe('resolveWorkspace', () => {
  it('uses the view’s own filters until the URL replaces them', () => {
    const resolved = resolveWorkspace([shared], new URLSearchParams('view=shared&priority=high'));

    expect(resolved).toMatchObject({ view: shared, changed: false });
    expect(resolved.filters.systemState).toEqual(['open']);
  });

  it('says the filters changed when the URL replaces them with something else', () => {
    const params = withFilters(new URLSearchParams('view=shared'), {
      ...EMPTY_FILTERS,
      systemState: ['open'],
      priority: ['high'],
    });

    expect(resolveWorkspace([shared], params)).toMatchObject({ view: shared, changed: true });
  });

  it('does not, when the replacement asks for the same thing', () => {
    const params = withFilters(new URLSearchParams('view=shared'), filtersOfView(shared.filters));

    expect(resolveWorkspace([shared], params).changed).toBe(false);
  });

  it('opens the whole desk for `all`, and for a view the reader cannot see', () => {
    expect(resolveWorkspace([shared], new URLSearchParams('view=all')).view).toBeNull();
    expect(
      resolveWorkspace([shared], new URLSearchParams('view=gone&priority=low')).filters.priority,
    ).toEqual(['low']);
  });

  it('opens the first view when the URL names none', () => {
    expect(resolveWorkspace([shared], new URLSearchParams()).view).toBe(shared);
  });
});

describe('viewLabel', () => {
  it('reads Arabic when there is Arabic, and the name otherwise', () => {
    const named = view({ id: 'x', name: 'Overdue', nameAr: 'المتأخرة' });

    expect(viewLabel(named, 'ar')).toBe('المتأخرة');
    expect(viewLabel(named, 'en')).toBe('Overdue');
    expect(viewLabel(view({ id: 'y', name: 'VIP' }), 'ar')).toBe('VIP');
  });
});

describe('activeFilterCount', () => {
  it('counts every chip and the overdue switch', () => {
    expect(
      activeFilterCount({ ...EMPTY_FILTERS, priority: ['high'], tagIds: [TAG], overdue: true }),
    ).toBe(3);
  });
});
