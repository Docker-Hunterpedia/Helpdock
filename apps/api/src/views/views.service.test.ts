import type { DbTransaction, NewView, View as ViewRow } from '@helpdock/db';
import type { TicketViewCreateRequest, TicketViewFilters } from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { type FakeTransaction, fakeTransaction } from '../ticketing/service-fakes.js';
import type { TicketReader } from '../tickets/tickets.repository.js';
import type { ViewActor } from './view-rules.js';
import type { ViewsRepository } from './views.repository.js';
import { type TicketCounter, type ViewsContext, ViewsService } from './views.service.js';

/**
 * The view rules against a repository that remembers rather than a database.
 * What the database proves — the owner policy, the seeded rows, the counts
 * under department scope — is in `views.integration.test.ts`.
 */

const BRAND = '01937f5e-7e53-7000-8000-0000000000b1';
const SUPPORT = '01937f5e-7e53-7000-8000-000000000011';
const BILLING = '01937f5e-7e53-7000-8000-000000000012';
const ADMIN: ViewActor = {
  userId: '01937f5e-7e53-7000-8000-000000000001',
  role: 'admin',
  departmentIds: 'all',
};
const LEADER: ViewActor = {
  userId: '01937f5e-7e53-7000-8000-000000000002',
  role: 'team_leader',
  departmentIds: [SUPPORT],
};
const AGENT: ViewActor = {
  userId: '01937f5e-7e53-7000-8000-000000000003',
  role: 'agent',
  departmentIds: [SUPPORT],
};

let rows: ViewRow[];
/** Whose transaction the fake answers for: the owner policy, in miniature. */
let principalId: string;
let seeded: number;
let counted: { reader: TicketReader; filters: TicketViewFilters }[];
let matches: number;
let created = 0;

const row = (overrides: Partial<ViewRow> & Pick<ViewRow, 'id' | 'name'>): ViewRow => ({
  brandId: BRAND,
  ownerId: null,
  nameAr: null,
  filters: {},
  visibleDepartmentIds: null,
  builtIn: null,
  departmentId: null,
  hidden: false,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const readable = (candidate: ViewRow): boolean =>
  candidate.ownerId === null || candidate.ownerId === principalId;

const repository = {
  list: async () =>
    rows
      .filter(readable)
      .sort(
        (left, right) =>
          Number(left.ownerId !== null) - Number(right.ownerId !== null) ||
          left.sortOrder - right.sortOrder,
      ),
  find: async (_tx: DbTransaction, id: string) =>
    rows.filter(readable).find((candidate) => candidate.id === id),
  hasBuiltIns: async () => rows.some((candidate) => candidate.builtIn !== null),
  seedBuiltIns: async () => {
    seeded += 1;
    rows.push(row({ id: 'my-open', name: 'My open', builtIn: 'my_open' }));
  },
  existingDepartments: async (_tx: DbTransaction, ids: readonly string[]) =>
    new Set(ids.filter((id) => id === SUPPORT || id === BILLING)),
  nextSortOrder: async (_tx: DbTransaction, ownerId: string | null) =>
    rows.filter((candidate) => candidate.ownerId === ownerId).length,
  create: async (_tx: DbTransaction, values: NewView) => {
    created += 1;
    const next = row({ ...values, id: `created-${created}`, name: values.name } as ViewRow);
    rows.push(next);
    return next;
  },
  update: async (_tx: DbTransaction, id: string, values: Partial<NewView>) => {
    rows = rows.map((candidate) =>
      candidate.id === id ? ({ ...candidate, ...values } as ViewRow) : candidate,
    );
  },
  delete: async (_tx: DbTransaction, id: string) => {
    rows = rows.filter((candidate) => candidate.id !== id);
  },
  setSortOrders: async (
    _tx: DbTransaction,
    positions: readonly { readonly id: string; readonly sortOrder: number }[],
  ) => {
    for (const { id, sortOrder } of positions) {
      await repository.update(_tx, id, { sortOrder });
    }
  },
} satisfies Partial<ViewsRepository> as unknown as ViewsRepository & {
  update(tx: DbTransaction, id: string, values: Partial<NewView>): Promise<void>;
};

const counter: TicketCounter = {
  countTickets: async (_tx, reader, filters) => {
    counted.push(...filters.map((one) => ({ reader, filters: one })));
    return filters.map(() => matches);
  },
};

let service: ViewsService;
let transaction: FakeTransaction;

const as = (actor: ViewActor): ViewsContext => {
  principalId = actor.userId;
  return { tx: transaction.tx, brandId: BRAND, actor };
};

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof TicketingFailure ? error.reason : error),
  );

beforeEach(() => {
  rows = [
    row({ id: 'my-open', name: 'My open', builtIn: 'my_open', filters: { assigneeId: ['me'] } }),
    row({
      id: 'billing-open',
      name: 'All open · Billing',
      builtIn: 'department_open',
      departmentId: BILLING,
      visibleDepartmentIds: [BILLING],
      sortOrder: 1,
    }),
    row({ id: 'vip', name: 'VIP', visibleDepartmentIds: [SUPPORT], sortOrder: 2 }),
    row({ id: 'agent-own', name: 'Arabic queue', ownerId: AGENT.userId }),
  ];
  seeded = 0;
  counted = [];
  matches = 3;
  created = 0;
  transaction = fakeTransaction();
  service = new ViewsService(repository, counter);
});

describe('list', () => {
  it('shows the reader their own views and the shared ones that reach them', async () => {
    const { views } = await service.list(as(AGENT));

    expect(views.map((view) => view.id)).toEqual(['my-open', 'vip', 'agent-own']);
  });

  it('marks what the reader may change', async () => {
    const { views } = await service.list(as(AGENT));

    expect(Object.fromEntries(views.map((view) => [view.id, view.editable]))).toEqual({
      'my-open': false,
      vip: false,
      'agent-own': true,
    });
  });

  it('describes who sees each view', async () => {
    const { views } = await service.list(as(ADMIN));

    expect(views.map((view) => view.visibility)).toEqual([
      { kind: 'brand' },
      { kind: 'departments', departmentIds: [BILLING] },
      { kind: 'departments', departmentIds: [SUPPORT] },
    ]);
  });

  it('seeds the defaults for a brand that predates them, once', async () => {
    rows = [];

    await service.list(as(AGENT));
    await service.list(as(AGENT));

    expect(seeded).toBe(1);
  });
});

describe('counts', () => {
  it('counts every view in the sidebar for the reader', async () => {
    const { counts } = await service.counts(as(AGENT));

    expect(counts).toEqual([
      { viewId: 'my-open', count: 3, capped: false },
      { viewId: 'vip', count: 3, capped: false },
      { viewId: 'agent-own', count: 3, capped: false },
    ]);
    expect(counted[0]?.reader).toEqual({ brandId: BRAND, viewerId: AGENT.userId });
    expect(counted[0]?.filters.assigneeId).toEqual(['me']);
  });

  it('skips a hidden view', async () => {
    await service.update(as(ADMIN), 'my-open', { hidden: true });

    const { counts } = await service.counts(as(AGENT));

    expect(counts.map((count) => count.viewId)).not.toContain('my-open');
  });

  it('stops at the cap and says so', async () => {
    matches = 1000;

    const { counts } = await service.counts(as(AGENT));

    expect(counts[0]).toEqual({ viewId: 'my-open', count: 999, capped: true });
  });
});

describe('create', () => {
  it('saves a personal view for anybody who reads tickets, without an audit row', async () => {
    const view = await service.create(as(AGENT), {
      name: 'Stuck',
      filters: { sort: 'updatedAt', direction: 'asc' },
      visibility: { kind: 'personal' },
    });

    expect(view).toMatchObject({ visibility: { kind: 'personal' }, editable: true, sortOrder: 1 });
    expect(rows.find((candidate) => candidate.id === view.id)?.ownerId).toBe(AGENT.userId);
    expect(transaction.audit).toEqual([]);
  });

  it('refuses an Agent a shared view', async () => {
    const request: TicketViewCreateRequest = {
      name: 'Shared',
      filters: { sort: 'updatedAt', direction: 'desc' },
      visibility: { kind: 'departments', departmentIds: [SUPPORT] },
    };

    expect(await refusal(service.create(as(AGENT), request))).toBe('out-of-scope');
  });

  it('lets a Team Leader share with the departments they lead, and audits it', async () => {
    const view = await service.create(as(LEADER), {
      name: 'Support VIP',
      filters: { sort: 'updatedAt', direction: 'desc' },
      visibility: { kind: 'departments', departmentIds: [SUPPORT] },
    });

    expect(view.visibility).toEqual({ kind: 'departments', departmentIds: [SUPPORT] });
    expect(transaction.audit.map((entry) => entry.action)).toEqual(['view.created']);
  });

  it('refuses a Team Leader a department they do not lead', async () => {
    const request: TicketViewCreateRequest = {
      name: 'Billing VIP',
      filters: { sort: 'updatedAt', direction: 'desc' },
      visibility: { kind: 'departments', departmentIds: [BILLING] },
    };

    expect(await refusal(service.create(as(LEADER), request))).toBe('out-of-scope');
  });

  it('answers 404 for a department the brand does not have', async () => {
    const request: TicketViewCreateRequest = {
      name: 'Nowhere',
      filters: { sort: 'updatedAt', direction: 'desc' },
      visibility: { kind: 'departments', departmentIds: ['01937f5e-7e53-7000-8000-0000000000ff'] },
    };

    expect(await refusal(service.create(as(ADMIN), request))).toBeInstanceOf(NotFoundException);
  });
});

describe('update', () => {
  it('renames a built-in view', async () => {
    const view = await service.update(as(ADMIN), 'my-open', { name: 'Mine, open' });

    expect(view.name).toBe('Mine, open');
  });

  it.each([
    ['filters', { filters: { sort: 'number', direction: 'asc' } }],
    ['visibility', { visibility: { kind: 'brand' } }],
  ] as const)('refuses to change the %s of a built-in view', async (_field, request) => {
    expect(await refusal(service.update(as(ADMIN), 'my-open', request))).toBe('view-is-built-in');
  });

  it('refuses to hide a personal view', async () => {
    expect(await refusal(service.update(as(AGENT), 'agent-own', { hidden: true }))).toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an Agent a shared view', async () => {
    expect(await refusal(service.update(as(AGENT), 'vip', { name: 'Mine now' }))).toBe(
      'out-of-scope',
    );
  });

  it('answers 404 for a shared view outside the reader’s departments', async () => {
    expect(await refusal(service.update(as(AGENT), 'billing-open', { name: 'x' }))).toBeInstanceOf(
      NotFoundException,
    );
  });

  it('shares a personal view, moving it to the end of the shared list', async () => {
    rows.push(row({ id: 'leader-own', name: 'Mine', ownerId: LEADER.userId }));

    const view = await service.update(as(LEADER), 'leader-own', {
      visibility: { kind: 'departments', departmentIds: [SUPPORT] },
    });

    expect(view).toMatchObject({
      visibility: { kind: 'departments', departmentIds: [SUPPORT] },
      sortOrder: 3,
    });
    expect(transaction.audit.map((entry) => entry.action)).toEqual(['view.updated']);
  });

  it('does not audit a change to a personal view', async () => {
    await service.update(as(AGENT), 'agent-own', { name: 'Renamed' });

    expect(transaction.audit).toEqual([]);
  });
});

describe('remove', () => {
  it('refuses to delete a built-in view', async () => {
    expect(await refusal(service.remove(as(ADMIN), 'my-open'))).toBe('view-is-built-in');
  });

  it('deletes the reader’s own view', async () => {
    await service.remove(as(AGENT), 'agent-own');

    expect(rows.map((candidate) => candidate.id)).not.toContain('agent-own');
  });

  it('deletes a shared view the reader manages, with an audit row', async () => {
    await service.remove(as(LEADER), 'vip');

    expect(transaction.audit.map((entry) => entry.action)).toEqual(['view.deleted']);
  });
});

describe('reorder', () => {
  it('puts the named views in the places they held between them', async () => {
    const { views } = await service.reorder(as(ADMIN), { viewIds: ['vip', 'my-open'] });

    expect(views.map((view) => view.id)).toEqual(['vip', 'billing-open', 'my-open']);
    expect(transaction.audit.map((entry) => entry.action)).toEqual(['view.reordered']);
  });

  it('refuses a view named twice', async () => {
    expect(await refusal(service.reorder(as(ADMIN), { viewIds: ['vip', 'vip'] }))).toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses shared and personal views in one order', async () => {
    expect(
      await refusal(service.reorder(as(AGENT), { viewIds: ['agent-own', 'vip'] })),
    ).toBeInstanceOf(BadRequestException);
  });

  it('answers 404 for a view the reader cannot see', async () => {
    expect(await refusal(service.reorder(as(ADMIN), { viewIds: ['agent-own'] }))).toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a Team Leader a view they do not manage', async () => {
    expect(await refusal(service.reorder(as(LEADER), { viewIds: ['my-open', 'vip'] }))).toBe(
      'out-of-scope',
    );
  });
});
