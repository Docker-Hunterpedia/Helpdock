import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import type { BrandSettings, ReopenPolicy } from '@helpdock/schemas';
import { DEFAULT_CONTENT_POLICY } from '@helpdock/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityActor } from '../ticket-activity.js';
import { TicketLifecycleHooks } from './hooks.js';
import type { TicketLifecycleRepository } from './lifecycle.repository.js';
import { type LifecycleContext, TicketLifecycleService } from './lifecycle.service.js';
import { TicketLifecycleFailure } from './lifecycle-failure.js';

/**
 * The transitions carried out, with the two repositories stubbed.
 *
 * `transitions.test.ts` proves the table; this proves what the service *does*
 * with each answer — which status it lands on, which hook fires, and which
 * branch of the reopen policy a closed ticket takes. The integration suite then
 * proves the rows really commit.
 *
 * Nothing here mocks `writeTicketActivity` or `enqueueTicketEvent`: they are
 * module functions that write through the transaction, and the stub transaction
 * records what they were asked to insert.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';

const status = (
  id: string,
  systemState: TicketStatusRow['systemState'],
  overrides: Partial<TicketStatusRow> = {},
): TicketStatusRow =>
  ({
    id,
    brandId: BRAND,
    name: id,
    nameAr: null,
    systemState,
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: systemState === 'open',
    isSystem: true,
    excludedFromReports: false,
    sortOrder: 0,
    color: 'info',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as TicketStatusRow;

const OPEN = status('open', 'open');
const AWAITING = status('awaiting', 'on_hold', {
  awaitingCustomer: true,
  pausesSla: true,
  isDefault: false,
});
const CLOSED = status('closed', 'closed', { isDefault: false });
const SPAM = status('spam', 'closed', { isDefault: false, excludedFromReports: true });

const ticket = (overrides: Partial<TicketRow> = {}): TicketRow =>
  ({
    id: '0199f4b2-0000-7000-8000-000000000001',
    brandId: BRAND,
    departmentId: '0199f4b2-0000-7000-8000-0000000000d1',
    number: 1042,
    prefix: 'HD',
    subject: 'Refund for order 42',
    statusId: OPEN.id,
    priority: 'medium',
    channel: 'email',
    teamId: null,
    assigneeId: null,
    contactId: null,
    parentId: null,
    mergedIntoId: null,
    splitFromId: null,
    firstResponseDueAt: null,
    resolutionDueAt: null,
    slaBreached: false,
    closedAt: null,
    deletedAt: null,
    custom: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as TicketRow;

const ACTOR: ActivityActor = { actorType: 'staff', actorId: 'ada', via: 'ui' };

/** Every insert the service made, so a test can ask what it wrote without a database. */
interface Recorder {
  readonly inserts: { table: string; values: unknown }[];
}

const settingsOf = (policy: ReopenPolicy, autoAwait = true): BrandSettings => ({
  autoAwaitOnAgentReply: autoAwait,
  reopenPolicy: policy,
  // M1-10 nested the brand's content policy in `settings`. The lifecycle never
  // reads it; it is here because the whole object is what the column holds.
  contentPolicy: DEFAULT_CONTENT_POLICY,
  csatEnabled: true,
  timeTrackingEnabled: false,
  timerStartsWithComposer: false,
});

const harness = (options: {
  readonly statuses?: readonly TicketStatusRow[];
  readonly settings?: BrandSettings;
}) => {
  const recorder: Recorder = { inserts: [] };

  // Enough of Drizzle's builder for the three statements the service makes:
  // an activity row, an outbox row (which reads its id back) and a message.
  const tx = {
    insert: (table: object) => ({
      values: (values: unknown) => {
        recorder.inserts.push({ table: tableNameOf(table), values });
        const rows = [{ id: '0199f4b2-0000-7000-8000-00000000000f' }];

        return Object.assign(Promise.resolve(rows), { returning: async () => rows });
      },
    }),
  } as unknown as DbTransaction;

  const statuses = options.statuses ?? [OPEN, AWAITING, CLOSED, SPAM];

  const lifecycleRepo = {
    defaultOpenStatus: vi.fn(async () => statuses.find((row) => row.isDefault)),
    awaitingCustomerStatus: vi.fn(async () => statuses.find((row) => row.awaitingCustomer)),
    brandSettings: vi.fn(
      async () => options.settings ?? settingsOf({ kind: 'within_days', days: 7 }),
    ),
    localeForContact: vi.fn(async () => 'en' as const),
    writeAudit: vi.fn(async () => undefined),
  } as unknown as TicketLifecycleRepository;

  const created: TicketRow[] = [];
  const updates: { id: string; values: Record<string, unknown> }[] = [];

  const tickets = {
    updateTicket: vi.fn(async (_tx: DbTransaction, id: string, values: Record<string, unknown>) => {
      updates.push({ id, values });
      return { ...ticket(), id, ...values };
    }),
    insertTicket: vi.fn(async (_tx: DbTransaction, values: Record<string, unknown>) => {
      const row = {
        ...ticket(),
        id: `0199f4b2-0000-7000-8000-00000000010${created.length}`,
        ...values,
      } as TicketRow;
      created.push(row);
      return row;
    }),
    insertMessage: vi.fn(async (_tx: DbTransaction, values: Record<string, unknown>) => {
      recorder.inserts.push({ table: 'ticket_messages', values });
      return values;
    }),
    nextNumber: vi.fn(async () => 1101),
    nextSeq: vi.fn(async () => 1),
  };

  const hooks = new TicketLifecycleHooks();
  const onResolved = vi.spyOn(hooks, 'onResolved');
  const onClosedForCsat = vi.spyOn(hooks, 'onClosedForCsat');
  const onReopened = vi.spyOn(hooks, 'onReopened');

  const service = new TicketLifecycleService(lifecycleRepo, tickets as never, hooks);

  const context: LifecycleContext = { tx, brandId: BRAND, actor: ACTOR, now: NOW };

  return {
    service,
    context,
    recorder,
    updates,
    created,
    tickets,
    hooks: { onResolved, onClosedForCsat, onReopened },
  };
};

/**
 * Which table an insert went to. Drizzle keeps the name behind a symbol, so
 * this reads it the way the ORM's own helpers do rather than guessing from the
 * values — a message and an activity row would otherwise be hard to tell apart.
 */
const tableNameOf = (table: object): string => {
  for (const symbol of Object.getOwnPropertySymbols(table)) {
    const value = (table as Record<symbol, unknown>)[symbol];
    if (typeof value === 'string' && value.length > 0 && !value.startsWith('drizzle')) {
      return value;
    }
  }

  return 'unknown';
};

const messages = (recorder: Recorder): { bodyText: string }[] =>
  recorder.inserts
    .filter((row) => row.table === 'ticket_messages')
    .map((row) => row.values as { bodyText: string });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a customer reply to an open-like ticket (§2.2 row 1)', () => {
  it('moves it to the brand’s default open status', async () => {
    const { service, context, updates } = harness({});

    const landing = await service.onCustomerReply(context, ticket(), AWAITING);

    expect(landing.continued).toBe(false);
    expect(landing.status.id).toBe(OPEN.id);
    expect(updates[0]?.values).toMatchObject({ statusId: OPEN.id, closedAt: null });
  });

  it('writes nothing when the ticket is already in that status', async () => {
    const { service, context, updates } = harness({});

    const landing = await service.onCustomerReply(context, ticket(), OPEN);

    expect(landing.status.id).toBe(OPEN.id);
    expect(updates).toHaveLength(0);
  });

  it('refuses on a ticket that was merged away', async () => {
    const { service, context } = harness({});

    await expect(
      service.onCustomerReply(context, ticket({ mergedIntoId: 'primary' }), OPEN),
    ).rejects.toBeInstanceOf(TicketLifecycleFailure);
  });
});

describe('a customer reply to a closed ticket (§2.2 row 5, §2.3)', () => {
  it('reopens it inside the window, and restarts the clocks', async () => {
    const { service, context, hooks, updates } = harness({
      settings: settingsOf({ kind: 'within_days', days: 7 }),
    });

    const landing = await service.onCustomerReply(
      context,
      ticket({ closedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) }),
      CLOSED,
    );

    expect(landing.continued).toBe(false);
    expect(updates[0]?.values).toMatchObject({ statusId: OPEN.id, closedAt: null });
    expect(hooks.onReopened).toHaveBeenCalledTimes(1);
  });

  it('creates a linked ticket past the window, with a system message on each side', async () => {
    const { service, context, created, recorder, hooks } = harness({
      settings: settingsOf({ kind: 'within_days', days: 7 }),
    });

    const closed = ticket({ closedAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000) });
    const landing = await service.onCustomerReply(context, closed, CLOSED);

    expect(landing.continued).toBe(true);
    expect(created[0]).toMatchObject({ parentId: closed.id, statusId: OPEN.id });
    // Neither clock restarts: the old ticket stays closed and the new one is new.
    expect(hooks.onReopened).not.toHaveBeenCalled();

    const written = messages(recorder).map((row) => row.bodyText);
    expect(written).toEqual(['Continued from HD-1042', 'Continued in HD-1101']);
  });

  it('never reopens under `never`', async () => {
    const { service, context } = harness({ settings: settingsOf({ kind: 'never' }) });

    const landing = await service.onCustomerReply(context, ticket({ closedAt: NOW }), CLOSED);

    expect(landing.continued).toBe(true);
  });

  it('always reopens under `always`, however old the ticket is', async () => {
    const { service, context } = harness({ settings: settingsOf({ kind: 'always' }) });

    const landing = await service.onCustomerReply(
      context,
      ticket({ closedAt: new Date('2020-01-01T00:00:00.000Z') }),
      CLOSED,
    );

    expect(landing.continued).toBe(false);
  });

  it('writes both halves of the pair, and only those two', async () => {
    const { service, context, recorder } = harness({ settings: settingsOf({ kind: 'never' }) });

    await service.onCustomerReply(context, ticket({ closedAt: NOW }), CLOSED);

    // The customer's own message is written by the message path afterwards, so
    // the lifecycle leaves exactly the two system rows §2.3 names.
    expect(messages(recorder)).toHaveLength(2);
  });
});

describe('an agent public reply (§2.2 row 2)', () => {
  it('moves an open ticket to Awaiting customer when the toggle is on', async () => {
    const { service, context, updates } = harness({});

    const next = await service.onAgentPublicReply(context, ticket(), OPEN);

    expect(next.id).toBe(AWAITING.id);
    expect(updates[0]?.values).toMatchObject({ statusId: AWAITING.id });
  });

  it('leaves the ticket alone when the toggle is off', async () => {
    const { service, context, updates } = harness({
      settings: settingsOf({ kind: 'within_days', days: 7 }, false),
    });

    const next = await service.onAgentPublicReply(context, ticket(), OPEN);

    expect(next.id).toBe(OPEN.id);
    expect(updates).toHaveLength(0);
  });

  // §2.2 gives the row to `open` alone: a ticket on hold or escalated is
  // somewhere deliberate, and a reply does not move it.
  it.each([AWAITING, CLOSED])('leaves a %s ticket alone', async (current) => {
    const { service, context, updates } = harness({});

    const next = await service.onAgentPublicReply(context, ticket(), current);

    expect(next.id).toBe(current.id);
    expect(updates).toHaveLength(0);
  });

  it('leaves the ticket alone when the brand has no awaiting-customer status', async () => {
    const { service, context, updates } = harness({ statuses: [OPEN, CLOSED] });

    const next = await service.onAgentPublicReply(context, ticket(), OPEN);

    expect(next.id).toBe(OPEN.id);
    expect(updates).toHaveLength(0);
  });
});

describe('closing (§2.2 row 4)', () => {
  it('fires the resolution hook and schedules a survey', async () => {
    const { service, context, hooks } = harness({});

    await service.onClosed(context, ticket({ closedAt: NOW }), CLOSED);

    expect(hooks.onResolved).toHaveBeenCalledTimes(1);
    expect(hooks.onClosedForCsat).toHaveBeenCalledTimes(1);
  });

  it('skips the survey for a status excluded from reports, such as Spam', async () => {
    const { service, context, hooks } = harness({});

    await service.onClosed(context, ticket({ closedAt: NOW }), SPAM);

    expect(hooks.onResolved).toHaveBeenCalledTimes(1);
    expect(hooks.onClosedForCsat).not.toHaveBeenCalled();
  });

  it('skips the survey for a ticket merged into another', async () => {
    const { service, context, hooks } = harness({});

    await service.onClosed(context, ticket({ closedAt: NOW, mergedIntoId: 'primary' }), CLOSED);

    expect(hooks.onResolved).toHaveBeenCalledTimes(1);
    expect(hooks.onClosedForCsat).not.toHaveBeenCalled();
  });
});

describe('soft deletion (§2.2 row 9)', () => {
  it('stamps deleted_at and audits it', async () => {
    const { service, context, updates } = harness({});

    await service.softDelete(context, ticket(), OPEN);

    expect(updates[0]?.values).toMatchObject({ deletedAt: NOW });
  });

  it('refuses to delete a ticket that is already deleted', async () => {
    const { service, context } = harness({});

    await expect(
      service.softDelete(context, ticket({ deletedAt: NOW }), OPEN),
    ).rejects.toBeInstanceOf(TicketLifecycleFailure);
  });
});
