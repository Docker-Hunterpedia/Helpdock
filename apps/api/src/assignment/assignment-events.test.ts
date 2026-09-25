import type { DbTransaction } from '@helpdock/db';
import { type AssignmentOfflineUnassignPayload, outboxEvents, silentLogger } from '@helpdock/jobs';
import type { PresenceStatus } from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type {
  AssignmentRepository,
  DepartmentAssignmentRow,
  NamedMember,
} from './assignment.repository.js';
import {
  ASSIGNMENT_EVENTS,
  createAccessChangedHandler,
  createAssignmentRequestedHandler,
  createOfflineUnassignProcessor,
  createStaffOfflineHandler,
  type OfflineSinceStore,
  registerAssignmentEventHandlers,
} from './assignment-events.js';

const brandId = '01920000-0000-7000-8000-000000000b00';
const support = '01920000-0000-7000-8000-00000000c222';
const billing = '01920000-0000-7000-8000-00000000b111';
const sam = '01920000-0000-7000-8000-0000000000a1';
const sue = '01920000-0000-7000-8000-0000000000a2';
const ticketId = '01920000-0000-7000-8000-0000000000e1';
const since = '2026-09-24T10:00:00.000Z';

/**
 * A transaction that records what was inserted. The handlers write activity
 * rows and outbox rows through it; nothing here needs Postgres to be proved,
 * and `assignment.integration.test.ts` proves the same paths against it.
 */
const fakeTx = () => {
  const inserted: unknown[] = [];
  const tx = {
    insert: () => ({
      values: (values: unknown) => {
        inserted.push(values);
        // Awaited directly by the activity write, and `.returning()`-ed by the
        // outbox write: a settled promise that also has the method serves both.
        return Object.assign(Promise.resolve(), {
          returning: async () => [{ id: '01920000-0000-7000-8000-00000000000f' }],
        });
      },
    }),
  } as unknown as DbTransaction;

  return { tx, inserted };
};

const department = (overrides: Partial<DepartmentAssignmentRow> = {}): DepartmentAssignmentRow => ({
  id: support,
  name: 'Support',
  nameAr: null,
  sortOrder: 0,
  assignmentMode: 'round_robin',
  loadCap: null,
  autoUnassignOffline: true,
  autoUnassignAfterMinutes: 15,
  onUnassign: 'leave_unassigned',
  ...overrides,
});

const member = (userId: string, departmentIds: string[] = [support]): NamedMember => ({
  userId,
  name: userId,
  role: 'agent',
  departmentIds,
  deactivated: false,
});

const openTicket = (overrides: Record<string, unknown> = {}) => ({
  id: ticketId,
  departmentId: support,
  assigneeId: null as string | null,
  deletedAt: null as Date | null,
  systemState: 'open' as const,
  excludedFromReports: false,
  ...overrides,
});

const fakeRepository = (overrides: Partial<Record<keyof AssignmentRepository, unknown>> = {}) =>
  ({
    lockBrandRotation: vi.fn(async () => {}),
    ticketForAssignment: vi.fn(async () => openTicket()),
    department: vi.fn(async () => department()),
    departments: vi.fn(async () => [department()]),
    candidates: vi.fn(async () => [
      { ...member(sam), inRotation: null, lastAssignedAt: null, skillTagIds: [] },
    ]),
    openCounts: vi.fn(async () => new Map()),
    ticketTagIds: vi.fn(async () => []),
    setAssignee: vi.fn(async () => {}),
    markAssigned: vi.fn(async () => {}),
    member: vi.fn(async () => undefined),
    openTicketsOf: vi.fn(async () => [{ id: ticketId, departmentId: support }]),
    ...overrides,
  }) as unknown as AssignmentRepository;

const context = (tx: DbTransaction, event: string, payload: Record<string, unknown>) => ({
  outboxId: '01920000-0000-7000-8000-0000000000d1',
  brandId,
  event,
  payload,
  tx,
  log: silentLogger,
});

const everyoneOnline = { online: async () => new Set([sam, sue]) };

describe('assignment.requested', () => {
  const run = async (repository: AssignmentRepository, trigger = 'routed') => {
    const { tx, inserted } = fakeTx();
    await createAssignmentRequestedHandler({ repository, presence: everyoneOnline })(
      context(tx, ASSIGNMENT_EVENTS.requested, { ticketId, trigger }),
    );

    return inserted;
  };

  it('assigns the pick and leaves an activity row and a ticket.updated row', async () => {
    const repository = fakeRepository();
    const inserted = await run(repository);

    expect(repository.setAssignee).toHaveBeenCalledWith(expect.anything(), ticketId, sam);
    expect(inserted).toContainEqual(
      expect.objectContaining({
        action: 'ticket.updated',
        to: { assigneeId: sam, assignedBy: 'round_robin' },
      }),
    );
    expect(inserted).toContainEqual(expect.objectContaining({ event: 'ticket.updated' }));
  });

  it.each([
    ['a ticket that is gone', { ticketForAssignment: vi.fn(async () => undefined) }],
    [
      'a closed ticket',
      { ticketForAssignment: vi.fn(async () => openTicket({ systemState: 'closed' })) },
    ],
    [
      'a spam ticket',
      { ticketForAssignment: vi.fn(async () => openTicket({ excludedFromReports: true })) },
    ],
    [
      'a deleted ticket',
      { ticketForAssignment: vi.fn(async () => openTicket({ deletedAt: new Date() })) },
    ],
    [
      'a ticket somebody took',
      { ticketForAssignment: vi.fn(async () => openTicket({ assigneeId: sue })) },
    ],
    [
      'a manual department',
      { department: vi.fn(async () => department({ assignmentMode: 'manual' })) },
    ],
    ['a department that is gone', { department: vi.fn(async () => undefined) }],
    ['a department with nobody eligible', { candidates: vi.fn(async () => []) }],
  ])('leaves %s alone', async (_label, overrides) => {
    const repository = fakeRepository(overrides);
    const inserted = await run(repository);

    expect(repository.setAssignee).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it('takes the lock before it reads anything', async () => {
    const order: string[] = [];
    const repository = fakeRepository({
      lockBrandRotation: vi.fn(async () => void order.push('lock')),
      ticketForAssignment: vi.fn(async () => {
        order.push('read');
        return openTicket();
      }),
    });
    await run(repository);

    expect(order).toEqual(['lock', 'read']);
  });

  it('reads the ticket tags only in skill-based mode', async () => {
    const skilled = fakeRepository({
      department: vi.fn(async () => department({ assignmentMode: 'skill_based' })),
    });
    await run(skilled);
    expect(skilled.ticketTagIds).toHaveBeenCalledWith(expect.anything(), ticketId);

    const plain = fakeRepository();
    await run(plain);
    expect(plain.ticketTagIds).not.toHaveBeenCalled();
  });

  it('on_unassign follows the department on_unassign, not its mode', async () => {
    const leave = fakeRepository({
      department: vi.fn(async () => department({ onUnassign: 'leave_unassigned' })),
    });
    await run(leave, 'on_unassign');
    expect(leave.setAssignee).not.toHaveBeenCalled();

    const manualButRoutes = fakeRepository({
      department: vi.fn(async () =>
        department({ assignmentMode: 'manual', onUnassign: 'round_robin' }),
      ),
    });
    await run(manualButRoutes, 'on_unassign');
    expect(manualButRoutes.setAssignee).toHaveBeenCalledWith(expect.anything(), ticketId, sam);

    const skilled = fakeRepository({
      department: vi.fn(async () =>
        department({ assignmentMode: 'skill_based', onUnassign: 'round_robin' }),
      ),
    });
    await run(skilled, 'on_unassign');
    expect(skilled.ticketTagIds).toHaveBeenCalled();
  });
});

describe('assignment.access_changed', () => {
  const run = async (repository: AssignmentRepository) => {
    const { tx, inserted } = fakeTx();
    await createAccessChangedHandler({ repository, presence: everyoneOnline })(
      context(tx, ASSIGNMENT_EVENTS.accessChanged, { userId: sam }),
    );

    return inserted;
  };

  it('unassigns every open ticket of somebody with no membership left', async () => {
    const repository = fakeRepository({
      department: vi.fn(async () => department({ onUnassign: 'leave_unassigned' })),
    });
    const inserted = await run(repository);

    expect(repository.setAssignee).toHaveBeenCalledWith(expect.anything(), ticketId, null);
    expect(inserted).toContainEqual(
      expect.objectContaining({ to: { assigneeId: null, reason: 'access_lost' } }),
    );
  });

  it('keeps the tickets they can still work', async () => {
    const repository = fakeRepository({
      member: vi.fn(async () => member(sam, [support])),
      openTicketsOf: vi.fn(async () => [
        { id: ticketId, departmentId: support },
        { id: '01920000-0000-7000-8000-0000000000e2', departmentId: billing },
      ]),
      department: vi.fn(async () => department({ onUnassign: 'leave_unassigned' })),
    });
    await run(repository);

    expect(repository.setAssignee).toHaveBeenCalledTimes(1);
    expect(repository.setAssignee).toHaveBeenCalledWith(
      expect.anything(),
      '01920000-0000-7000-8000-0000000000e2',
      null,
    );
  });
});

describe('assignment.staff_offline', () => {
  const store = (): OfflineSinceStore & { values: Map<string, string> } => {
    const values = new Map<string, string>();
    return {
      values,
      set: async (_brand, userId, value) => void values.set(userId, value),
      get: async (_brand, userId) => values.get(userId) ?? null,
    };
  };

  it('schedules one timer per department that asks for it and where they hold tickets', async () => {
    const add = vi.fn(async () => {});
    const offlineSince = store();
    const repository = fakeRepository({
      departments: vi.fn(async () => [
        department(),
        department({ id: billing, autoUnassignAfterMinutes: 30 }),
        department({ id: '01920000-0000-7000-8000-00000000d333', autoUnassignOffline: false }),
      ]),
      openTicketsOf: vi.fn(async () => [
        { id: ticketId, departmentId: support },
        {
          id: '01920000-0000-7000-8000-0000000000e3',
          departmentId: '01920000-0000-7000-8000-00000000d333',
        },
      ]),
    });
    const { tx } = fakeTx();

    await createStaffOfflineHandler({
      repository,
      presence: everyoneOnline,
      offlineSince,
      queue: { add },
      // The relay took two minutes to deliver, which the delay must not add.
      now: () => new Date(Date.parse(since) + 2 * 60_000),
    })(context(tx, ASSIGNMENT_EVENTS.staffOffline, { userId: sam, since }));

    expect(offlineSince.values.get(sam)).toBe(since);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({
      jobId: `offline-unassign-${sam}-${support}-${Date.parse(since)}`,
      delayMs: 13 * 60_000,
      payload: { brandId, userId: sam, departmentId: support, since },
    });
  });

  it('never schedules into the past', async () => {
    const add = vi.fn(async () => {});
    const { tx } = fakeTx();

    await createStaffOfflineHandler({
      repository: fakeRepository(),
      presence: everyoneOnline,
      offlineSince: store(),
      queue: { add },
      now: () => new Date(Date.parse(since) + 60 * 60_000),
    })(context(tx, ASSIGNMENT_EVENTS.staffOffline, { userId: sam, since }));

    expect(add).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 0 }));
  });
});

describe('assignment.offline_unassign', () => {
  const payload: AssignmentOfflineUnassignPayload = {
    brandId,
    userId: sam,
    departmentId: support,
    since,
  };

  const run = async (
    repository: AssignmentRepository,
    {
      status = 'offline',
      latest = since,
    }: { status?: PresenceStatus; latest?: string | null } = {},
  ) => {
    const { tx, inserted } = fakeTx();
    await createOfflineUnassignProcessor({
      repository,
      presence: { online: async () => new Set([sue]) },
      lookup: { statusOf: async () => status },
      offlineSince: { set: async () => {}, get: async () => latest },
    })({ payload, brandId, tx, job: {} as Job, log: silentLogger });

    return inserted;
  };

  it('unassigns what they hold in the department and routes it again', async () => {
    const repository = fakeRepository({
      candidates: vi.fn(async () => [
        { ...member(sue), inRotation: null, lastAssignedAt: null, skillTagIds: [] },
      ]),
    });
    const inserted = await run(repository);

    expect(repository.openTicketsOf).toHaveBeenCalledWith(expect.anything(), brandId, sam, support);
    expect(inserted).toContainEqual(
      expect.objectContaining({ to: { assigneeId: null, reason: 'offline' } }),
    );
    expect(repository.setAssignee).toHaveBeenLastCalledWith(expect.anything(), ticketId, sue);
  });

  it.each([
    ['they are back online', { status: 'online' as const }],
    ['they are away, which is present', { status: 'away' as const }],
    ['a later departure superseded this one', { latest: '2026-09-24T10:05:00.000Z' }],
    ['the departure key has expired', { latest: null }],
  ])('does nothing when %s', async (_label, state) => {
    const repository = fakeRepository();
    await run(repository, state);

    expect(repository.openTicketsOf).not.toHaveBeenCalled();
  });

  it('does nothing when the department stopped asking for it', async () => {
    const repository = fakeRepository({
      department: vi.fn(async () => department({ autoUnassignOffline: false })),
    });
    await run(repository);

    expect(repository.openTicketsOf).not.toHaveBeenCalled();
  });
});

describe('registerAssignmentEventHandlers', () => {
  it('registers the three events with the worker dispatcher', () => {
    registerAssignmentEventHandlers({
      repository: fakeRepository(),
      presence: everyoneOnline,
      offlineSince: { set: async () => {}, get: async () => null },
      queue: { add: async () => {} },
    });

    expect(outboxEvents.events).toEqual(expect.arrayContaining(Object.values(ASSIGNMENT_EVENTS)));
  });
});
