import type {
  TicketView,
  TicketViewCountList,
  TicketViewCreateInput,
  TicketViewFilters,
  TicketViewList,
  TicketViewUpdateInput,
} from '@helpdock/schemas';
import {
  ticketViewCreateRequestSchema,
  ticketViewFiltersSchema,
  ticketViewUpdateRequestSchema,
  VIEW_COUNT_CAP,
} from '@helpdock/schemas';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import { TicketingError } from '../ticketing/api.js';

/**
 * The views half of the ticket fixture (M1-05): the defaults every brand is
 * seeded with — one "All open" per mock department — plus the shared and
 * personal views of the `Admin/View-Dialogs` artboard.
 *
 * It keeps the api's rules that a screen can run into: a built-in view is never
 * deleted, refiltered or reshared, and a personal view cannot be hidden. The
 * signed-in fixture is an Admin, so every view is editable here; the rules that
 * depend on role are the api's unit and integration suites.
 */

const LIVE = ['open', 'on_hold', 'escalated'] as const;

export const MOCK_VIEW_MY_OPEN = '0192c3f0-1a2b-7c3d-8e4f-0000000000e1';
export const MOCK_VIEW_UNASSIGNED = '0192c3f0-1a2b-7c3d-8e4f-0000000000e2';
export const MOCK_VIEW_OVERDUE = '0192c3f0-1a2b-7c3d-8e4f-0000000000e3';
export const MOCK_VIEW_ESCALATED = '0192c3f0-1a2b-7c3d-8e4f-0000000000e4';
export const MOCK_VIEW_VIP = '0192c3f0-1a2b-7c3d-8e4f-0000000000e5';
export const MOCK_VIEW_MINE = '0192c3f0-1a2b-7c3d-8e4f-0000000000e6';

const filters = (input: Record<string, unknown>): TicketViewFilters =>
  ticketViewFiltersSchema.parse(input);

const view = (
  overrides: Partial<TicketView> & Pick<TicketView, 'id' | 'name' | 'filters' | 'sortOrder'>,
): TicketView => ({
  nameAr: null,
  visibility: { kind: 'brand' },
  builtIn: null,
  departmentId: null,
  hidden: false,
  editable: true,
  ...overrides,
});

const seedViews = (): TicketView[] => [
  view({
    id: MOCK_VIEW_MY_OPEN,
    name: 'My open',
    nameAr: 'المفتوحة لديّ',
    builtIn: 'my_open',
    sortOrder: 0,
    filters: filters({ assigneeId: ['me'], systemState: LIVE }),
  }),
  view({
    id: MOCK_VIEW_UNASSIGNED,
    name: 'Unassigned',
    nameAr: 'غير المسندة',
    builtIn: 'unassigned',
    sortOrder: 1,
    filters: filters({ assigneeId: ['unassigned'], systemState: LIVE }),
  }),
  view({
    id: MOCK_VIEW_OVERDUE,
    name: 'Overdue',
    nameAr: 'المتأخرة',
    builtIn: 'overdue',
    sortOrder: 2,
    filters: filters({ overdue: true, systemState: LIVE }),
  }),
  ...MOCK_DEPARTMENTS.map((department, index) =>
    view({
      id: `0192c3f0-1a2b-7c3d-8e4f-0000000000${(0xa0 + index).toString(16)}`,
      name: `All open · ${department.name}`,
      // As `departmentViewName` in `@helpdock/db` names it.
      nameAr: `كل المفتوحة · ${department.name}`,
      builtIn: 'department_open',
      departmentId: department.id,
      visibility: { kind: 'departments', departmentIds: [department.id] },
      sortOrder: 3 + index,
      filters: filters({ departmentId: [department.id], systemState: LIVE }),
    }),
  ),
  view({
    id: MOCK_VIEW_ESCALATED,
    name: 'Escalated',
    nameAr: 'المُصعَّدة',
    builtIn: 'escalated',
    sortOrder: 3 + MOCK_DEPARTMENTS.length,
    filters: filters({ systemState: ['escalated'] }),
  }),
  view({
    id: MOCK_VIEW_VIP,
    name: 'VIP refunds',
    nameAr: 'استرداد كبار العملاء',
    visibility: { kind: 'departments', departmentIds: [MOCK_DEPARTMENTS[1]?.id ?? ''] },
    sortOrder: 4 + MOCK_DEPARTMENTS.length,
    filters: filters({ priority: ['urgent'], systemState: LIVE }),
  }),
  view({
    id: MOCK_VIEW_MINE,
    name: 'Urgent, mine',
    visibility: { kind: 'personal' },
    sortOrder: 0,
    filters: filters({ priority: ['urgent'], assigneeId: ['me'] }),
  }),
];

export class MockViews {
  #views = seedViews();
  #sequence = 0;
  /** How many of the fixture's tickets a filter set matches, from the ticket fixture. */
  readonly #count: (filters: TicketViewFilters) => number;

  constructor(count: (filters: TicketViewFilters) => number) {
    this.#count = count;
  }

  list(): TicketViewList {
    const personal = (candidate: TicketView) => candidate.visibility.kind === 'personal';
    const ordered = [...this.#views].sort(
      (left, right) =>
        Number(personal(left)) - Number(personal(right)) || left.sortOrder - right.sortOrder,
    );

    return { views: ordered };
  }

  counts(): TicketViewCountList {
    return {
      counts: this.list()
        .views.filter((candidate) => !candidate.hidden)
        .map((candidate) => {
          const matched = this.#count(candidate.filters);
          return {
            viewId: candidate.id,
            count: Math.min(matched, VIEW_COUNT_CAP),
            capped: matched > VIEW_COUNT_CAP,
          };
        }),
    };
  }

  create(input: TicketViewCreateInput): TicketView {
    const request = ticketViewCreateRequestSchema.parse(input);
    this.#sequence += 1;
    const created = view({
      id: `0192c3f0-1a2b-7c3d-8e4f-${String(this.#sequence).padStart(12, '0').replace(/^0/, 'f')}`,
      name: request.name,
      nameAr: request.nameAr ?? null,
      visibility: request.visibility,
      filters: request.filters,
      sortOrder: this.#nextOrder(request.visibility.kind === 'personal'),
    });
    this.#views.push(created);

    return created;
  }

  update(viewId: string, input: TicketViewUpdateInput): TicketView {
    const request = ticketViewUpdateRequestSchema.parse(input);
    const current = this.#require(viewId);

    if (
      current.builtIn !== null &&
      (request.filters !== undefined || request.visibility !== undefined)
    ) {
      throw new TicketingError('view-is-built-in');
    }

    const moves =
      request.visibility !== undefined &&
      (request.visibility.kind === 'personal') !== (current.visibility.kind === 'personal');
    const next: TicketView = {
      ...current,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
      ...(request.filters === undefined ? {} : { filters: request.filters }),
      ...(request.hidden === undefined ? {} : { hidden: request.hidden }),
      ...(request.visibility === undefined ? {} : { visibility: request.visibility }),
      ...(moves ? { sortOrder: this.#nextOrder(request.visibility?.kind === 'personal') } : {}),
    };
    this.#views = this.#views.map((candidate) => (candidate.id === viewId ? next : candidate));

    return next;
  }

  remove(viewId: string): void {
    if (this.#require(viewId).builtIn !== null) {
      throw new TicketingError('view-is-built-in');
    }
    this.#views = this.#views.filter((candidate) => candidate.id !== viewId);
  }

  /** The named views take the places they held between them, in the order given. */
  reorder(viewIds: readonly string[]): TicketViewList {
    const personal = this.#require(viewIds[0] ?? '').visibility.kind === 'personal';
    const list = this.list().views.filter(
      (candidate) => (candidate.visibility.kind === 'personal') === personal,
    );
    const slots = list.flatMap((candidate, index) =>
      viewIds.includes(candidate.id) ? [index] : [],
    );
    const next = [...list];
    for (const [position, slot] of slots.entries()) {
      next[slot] = this.#require(viewIds[position] ?? '');
    }
    const order = new Map(next.map((candidate, index) => [candidate.id, index]));
    this.#views = this.#views.map((candidate) => ({
      ...candidate,
      sortOrder: order.get(candidate.id) ?? candidate.sortOrder,
    }));

    return this.list();
  }

  #nextOrder(personal: boolean): number {
    const orders = this.#views
      .filter((candidate) => (candidate.visibility.kind === 'personal') === personal)
      .map((candidate) => candidate.sortOrder);

    return orders.length === 0 ? 0 : Math.max(...orders) + 1;
  }

  #require(viewId: string): TicketView {
    const found = this.#views.find((candidate) => candidate.id === viewId);
    if (found === undefined) {
      throw new Error(`No such view ${viewId}`);
    }

    return found;
  }
}
