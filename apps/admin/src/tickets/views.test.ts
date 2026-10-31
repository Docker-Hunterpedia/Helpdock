import type { TicketFieldFilter, TicketView } from '@helpdock/schemas';
import { ticketViewFiltersSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  CUSTOM,
  defaultView,
  EMPTY_FILTERS,
  emptyKindOf,
  filtersFromParams,
  filtersOfView,
  intentOf,
  queryOf,
  resolveWorkspace,
  sameFilters,
  selectedViewId,
  sidebarViews,
  viewFiltersOf,
  viewLabel,
  viewSearch,
  withFilters,
  withIntent,
  withoutFilters,
} from './views.js';

const TAG = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
it.each([true, false])(
  'keeps the imported=%s source choice across URLs, saved views and clearing filters',
  (imported) => {
    const filters = { ...EMPTY_FILTERS, imported };
    const params = withFilters(new URLSearchParams(), filters);
    expect(filtersFromParams(params).imported).toBe(imported);
    expect(filtersOfView(ticketViewFiltersSchema.parse(viewFiltersOf(filters))).imported).toBe(
      imported,
    );
    expect(queryOf(filters).imported).toBe(imported);
    expect(activeFilterCount(filters)).toBe(1);
    expect(sameFilters(filters, EMPTY_FILTERS)).toBe(false);
    expect(filtersFromParams(withoutFilters(params)).imported).toBeUndefined();
  },
);

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

describe('intents and links', () => {
  it('reads only the intents the workspace acts on', () => {
    expect(intentOf(new URLSearchParams('intent=save'))).toBe('save');
    expect(intentOf(new URLSearchParams('intent=filters'))).toBe('filters');
    expect(intentOf(new URLSearchParams('intent=new'))).toBe('new');
    expect(intentOf(new URLSearchParams('intent=search'))).toBe('search');
    expect(intentOf(new URLSearchParams('intent=delete'))).toBeNull();
    expect(intentOf(new URLSearchParams())).toBeNull();
  });

  it('adds an intent to a query string and keeps the rest of it (M14-01)', () => {
    expect(withIntent('?view=abc&q=refund', 'new')).toBe('?view=abc&q=refund&intent=new');
    expect(withIntent('', 'search')).toBe('?intent=search');
    expect(withIntent('?intent=save', 'new')).toBe('?intent=new');
  });

  it('links to a view, with an intent when one is asked for', () => {
    expect(viewSearch('abc')).toBe('?view=abc');
    expect(viewSearch('abc', 'filters')).toBe('?view=abc&intent=filters');
  });

  it('marks the view the URL names, else the one the desk opens on, else the whole desk', () => {
    const first = view({ id: 'first' });

    expect(selectedViewId([first], new URLSearchParams('view=other'))).toBe('other');
    expect(selectedViewId([first], new URLSearchParams())).toBe('first');
    expect(selectedViewId([], new URLSearchParams())).toBe('all');
  });
});

describe('emptyKindOf with changed filters', () => {
  it.each(['my_open', 'unassigned', 'overdue', 'escalated', 'department_open'] as const)(
    'says the filters exclude everything on %s once they were changed',
    (builtIn) => {
      const changedFilters = { ...EMPTY_FILTERS, priority: ['low' as const] };
      expect(emptyKindOf(view({ id: builtIn, builtIn }), '', changedFilters, true)).toBe(
        'filtered',
      );
    },
  );

  it('still lets a search win over changed filters', () => {
    expect(emptyKindOf(shared, 'x', EMPTY_FILTERS, true)).toBe('search');
  });
});

describe('emptyKindOf', () => {
  const filtered = { ...EMPTY_FILTERS, priority: ['urgent' as const] };

  it.each([
    ['my_open', 'myOpen'],
    ['unassigned', 'unassigned'],
    ['overdue', 'overdue'],
  ] as const)('gives the built-in %s view its own words', (builtIn, kind) => {
    expect(emptyKindOf(view({ id: builtIn, builtIn }), '', filtered)).toBe(kind);
  });

  it('lets a search win over the view, built-in or not', () => {
    expect(emptyKindOf(view({ id: 'a', builtIn: 'my_open' }), 'invoice', filtered)).toBe('search');
    expect(emptyKindOf(null, 'invoice', EMPTY_FILTERS)).toBe('search');
  });

  it('says the filters exclude everything when another view or the desk has some on', () => {
    expect(emptyKindOf(shared, '', filtered)).toBe('filtered');
    expect(emptyKindOf(null, '', filtered)).toBe('filtered');
  });

  it.each(['escalated', 'department_open'] as const)(
    'keeps the plain words for %s, whose filters are the view itself',
    (builtIn) => {
      expect(emptyKindOf(view({ id: builtIn, builtIn }), '', filtered)).toBe('plain');
    },
  );

  it('falls back to "nothing in this view" with no filters on', () => {
    expect(emptyKindOf(shared, '', EMPTY_FILTERS)).toBe('plain');
    expect(emptyKindOf(null, '', EMPTY_FILTERS)).toBe('plain');
  });
});

describe('snoozed (M14-02)', () => {
  it.each(['only', 'include'] as const)(
    'keeps the %s choice across URLs, saved views and the list query',
    (snoozed) => {
      const filters = { ...EMPTY_FILTERS, snoozed };
      const params = withFilters(new URLSearchParams(), filters);

      expect(filtersFromParams(params).snoozed).toBe(snoozed);
      expect(filtersOfView(ticketViewFiltersSchema.parse(viewFiltersOf(filters))).snoozed).toBe(
        snoozed,
      );
      expect(queryOf(filters).snoozed).toBe(snoozed);
      expect(sameFilters(filters, EMPTY_FILTERS)).toBe(false);
      expect(filtersFromParams(withoutFilters(params)).snoozed).toBe('exclude');
    },
  );

  it('leaves the default out of the query and the URL, so a list asks only for what differs', () => {
    expect(queryOf(EMPTY_FILTERS)).not.toHaveProperty('snoozed');
    expect(withFilters(new URLSearchParams(), EMPTY_FILTERS).has('snoozed')).toBe(false);
    expect(filtersOfView(ticketViewFiltersSchema.parse({})).snoozed).toBe('exclude');
  });

  it('ignores a snoozed value it does not know', () => {
    expect(filtersFromParams(new URLSearchParams('snoozed=sometimes')).snoozed).toBe('exclude');
  });
});

describe('custom-field filters (M14-16)', () => {
  const severity: TicketFieldFilter = { key: 'severity', op: 'any_of', values: ['Sev 1', 'Sev 2'] };
  const total: TicketFieldFilter = { key: 'total', op: 'between', from: 10, to: 20 };
  const filters = { ...EMPTY_FILTERS, fieldFilter: [severity, total] };

  it('travels in the URL, one JSON parameter each, and survives a round trip', () => {
    const params = withFilters(new URLSearchParams(), filters);

    expect(params.getAll('field')).toEqual([JSON.stringify(severity), JSON.stringify(total)]);
    expect(filtersFromParams(params).fieldFilter).toEqual([severity, total]);
    expect(filtersFromParams(withoutFilters(params)).fieldFilter).toEqual([]);
  });

  it('drops a parameter that is not a filter instead of failing on a link edited by hand', () => {
    const params = new URLSearchParams();
    params.append('field', 'not json');
    params.append('field', JSON.stringify({ key: 'Bad Key', op: 'not_set' }));
    params.append('field', JSON.stringify({ key: 'vip', op: 'is', value: true }));

    expect(filtersFromParams(params).fieldFilter).toEqual([{ key: 'vip', op: 'is', value: true }]);
  });

  it('is saved with a view and read back from it', () => {
    const saved = ticketViewFiltersSchema.parse(viewFiltersOf(filters));

    expect(saved.fieldFilter).toEqual([severity, total]);
    expect(filtersOfView(saved).fieldFilter).toEqual([severity, total]);
    expect(viewFiltersOf(EMPTY_FILTERS)).not.toHaveProperty('fieldFilter');
  });

  it('is asked of the list as it is, and left off when there is none', () => {
    expect(queryOf(filters).fieldFilter).toEqual([severity, total]);
    expect(queryOf(EMPTY_FILTERS)).not.toHaveProperty('fieldFilter');
  });

  it('counts one per filter and tells a changed filter from the same one in another order', () => {
    expect(activeFilterCount(filters)).toBe(2);
    expect(sameFilters(filters, { ...filters, fieldFilter: [total, severity] })).toBe(true);
    expect(
      sameFilters(filters, {
        ...filters,
        fieldFilter: [{ key: 'severity', op: 'any_of', values: ['Sev 2', 'Sev 1'] }, total],
      }),
    ).toBe(true);
    expect(sameFilters(filters, { ...filters, fieldFilter: [severity] })).toBe(false);
    expect(
      sameFilters(filters, {
        ...filters,
        fieldFilter: [{ key: 'severity', op: 'any_of', values: ['Sev 3'] }, total],
      }),
    ).toBe(false);
  });
});

describe('mailbox and written-to filters (M14-26)', () => {
  const BOX = '0192c3f0-1a2b-7c3d-8e4f-000000000b01';
  const filters = { ...EMPTY_FILTERS, mailboxId: [BOX], toAddress: 'refunds@acme.test' };

  it('travels in the URL and survives a round trip', () => {
    const params = withFilters(new URLSearchParams(), filters);

    expect(params.getAll('mailbox')).toEqual([BOX]);
    expect(params.get('to')).toBe('refunds@acme.test');
    expect(filtersFromParams(params)).toMatchObject({
      mailboxId: [BOX],
      toAddress: 'refunds@acme.test',
    });
    expect(withoutFilters(params).has('to')).toBe(false);
    expect(withoutFilters(params).has('mailbox')).toBe(false);
  });

  it('is saved with a view, read back from it, and asked of the list as it is', () => {
    const saved = ticketViewFiltersSchema.parse(viewFiltersOf(filters));

    expect(saved).toMatchObject({ mailboxId: [BOX], toAddress: 'refunds@acme.test' });
    expect(filtersOfView(saved)).toMatchObject({
      mailboxId: [BOX],
      toAddress: 'refunds@acme.test',
    });
    expect(queryOf(filters)).toMatchObject({ mailboxId: [BOX], toAddress: 'refunds@acme.test' });
    expect(Object.keys(queryOf(EMPTY_FILTERS))).not.toContain('toAddress');
    expect(Object.keys(queryOf(EMPTY_FILTERS))).not.toContain('mailboxId');
  });

  it('counts one for the mailboxes and one for the address, and tells a change from the same filter', () => {
    expect(activeFilterCount(filters)).toBe(2);
    expect(sameFilters(filters, { ...filters })).toBe(true);
    expect(sameFilters(filters, { ...filters, toAddress: 'help@acme.test' })).toBe(false);
    expect(sameFilters(filters, { ...filters, mailboxId: [] })).toBe(false);
  });
});
