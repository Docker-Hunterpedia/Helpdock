import type { DbTransaction } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStatusStateResyncHandler } from './status-state-worker.js';

vi.mock('../ticket-activity.js', () => ({ writeTicketActivity: vi.fn(async () => undefined) }));
vi.mock('../ticket-events.js', () => ({
  TICKET_EVENTS: { closed: 'ticket.closed' },
  enqueueTicketEvent: vi.fn(async () => undefined),
}));
vi.mock('../close-requirements.js', () => ({
  requiredToCloseRules: vi.fn(async () => [
    { key: 'order_id', type: 'text', requiredToClose: true },
  ]),
}));
vi.mock('@helpdock/jobs', () => ({ enqueueOutbox: vi.fn(async () => 'outbox-id') }));

const { writeTicketActivity } = await import('../ticket-activity.js');
const { enqueueTicketEvent } = await import('../ticket-events.js');
const { enqueueOutbox } = await import('@helpdock/jobs');

const STATUS = '0192c3f0-1a2b-7c3d-8e4f-0000000000e7';
const AT = '2026-10-23T10:00:00.000Z';
const ids = ['0192c3f0-0000-7000-8000-000000000001', '0192c3f0-0000-7000-8000-000000000002'];

const row = (id: string, custom: Record<string, unknown> = {}) => ({
  id,
  departmentId: 'dept',
  custom,
});
const tx = {} as DbTransaction;
const log = { info: vi.fn() };

const run = (
  deps: Parameters<typeof createStatusStateResyncHandler>[0],
  payload: Record<string, unknown> = {},
) =>
  createStatusStateResyncHandler(deps)({
    outboxId: 'o1',
    brandId: 'brand',
    event: 'ticket.status_state_resync',
    payload: { statusId: STATUS, at: AT, actorType: 'staff', actorId: 'ada', ...payload },
    tx,
    // biome-ignore lint/suspicious/noExplicitAny: a logger double with the one method the handler calls.
    log: log as any,
  });

const deps = (over: {
  state?: string;
  status?: undefined | null;
  batch?: { id: string }[];
  close?: (id: string) => ReturnType<typeof row> | undefined;
  limit?: number;
}) => {
  const onClosed = vi.fn(async () => undefined);
  const liveTicketsToClose = vi.fn(async () => over.batch ?? []);
  const closeTicketInStatus = vi.fn(async (_tx: unknown, id: string) =>
    over.close === undefined ? row(id) : over.close(id),
  );
  return {
    onClosed,
    liveTicketsToClose,
    closeTicketInStatus,
    deps: {
      repository: {
        findStatus: vi.fn(async () =>
          over.status === null ? undefined : { id: STATUS, systemState: over.state ?? 'closed' },
        ),
        liveTicketsToClose,
        closeTicketInStatus,
        // biome-ignore lint/suspicious/noExplicitAny: a repository double with the three calls the handler makes.
      } as any,
      lifecycle: { onClosed },
      ...(over.limit === undefined ? {} : { batch: over.limit }),
    },
  };
};

describe('ticket.status_state_resync handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes each ticket of the batch, without a survey, and tells the queue per ticket', async () => {
    const d = deps({ batch: ids.map((id) => ({ id })) });
    await run(d.deps);

    expect(d.closeTicketInStatus).toHaveBeenCalledTimes(2);
    expect(d.onClosed).toHaveBeenCalledTimes(2);
    const context = (d.onClosed.mock.calls[0] as unknown as [{ withoutSurvey?: boolean }])[0];
    expect(context.withoutSurvey).toBe(true);
    expect(writeTicketActivity).toHaveBeenCalledTimes(2);
    expect(enqueueTicketEvent).toHaveBeenCalledTimes(2);
  });

  it('leaves a ticket that moved out of the status mid-batch alone', async () => {
    const d = deps({
      batch: ids.map((id) => ({ id })),
      close: (id) => (id === ids[0] ? undefined : row(id)),
    });
    await run(d.deps);

    expect(d.onClosed).toHaveBeenCalledTimes(1);
    expect(writeTicketActivity).toHaveBeenCalledTimes(1);
    expect(enqueueTicketEvent).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the status is no longer closed or is gone', async () => {
    const reopened = deps({ state: 'open', batch: [{ id: ids[0] ?? '' }] });
    await run(reopened.deps);
    expect(reopened.liveTicketsToClose).not.toHaveBeenCalled();

    const gone = deps({ status: null });
    await run(gone.deps);
    expect(gone.liveTicketsToClose).not.toHaveBeenCalled();
  });

  it('hands on from the last ticket when the batch was full, and stops when it was not', async () => {
    const full = deps({ batch: ids.map((id) => ({ id })), limit: 2 });
    await run(full.deps, { afterId: ids[0] });
    expect(full.liveTicketsToClose).toHaveBeenCalledWith(tx, STATUS, {
      limit: 2,
      afterId: ids[0],
    });
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(enqueueOutbox).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ payload: expect.objectContaining({ afterId: ids[1] }) }),
    );

    vi.clearAllMocks();
    const partial = deps({ batch: [{ id: ids[0] ?? '' }], limit: 2 });
    await run(partial.deps);
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it('closes through an empty required-to-close field and notes it, never refusing (M14-17)', async () => {
    const d = deps({
      batch: ids.map((id) => ({ id })),
      close: (id) => row(id, id === ids[0] ? {} : { order_id: 'A-1' }),
    });
    await run(d.deps);

    expect(d.onClosed).toHaveBeenCalledTimes(2);
    const entries = vi
      .mocked(writeTicketActivity)
      .mock.calls.map(([, entry]) => entry.to as Record<string, unknown>);
    expect(entries[0]).toMatchObject({ reason: 'status-state', closedWithout: ['order_id'] });
    expect(entries[1]).not.toHaveProperty('closedWithout');
  });
});
