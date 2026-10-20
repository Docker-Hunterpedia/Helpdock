import type { DbTransaction } from '@helpdock/db';
import {
  createOutboxDispatcher,
  type RulesEvaluatePayload,
  silentLogger,
  UnknownOutboxEventError,
} from '@helpdock/jobs';
import { SLA_EVENTS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { registerRulesEventHandlers } from '../rules/rules-jobs.js';
import type { SlaWorkerDeps } from './sla-worker.js';
import { createSlaStatusResyncHandler, registerSlaEventHandlers } from './sla-worker.js';

const brandId = '01924f00-0000-7000-8000-00000000000a';
const ticketId = '01924f00-0000-7000-8000-0000000000b1';
const outboxId = '01924f00-0000-7000-8000-0000000000c1';

// Neither handler under test touches the SLA engine or the transaction.
const deps = {} as SlaWorkerDeps;
const tx = {} as DbTransaction;

const dispatch = (
  dispatcher: ReturnType<typeof createOutboxDispatcher>,
  event: string,
): Promise<void> =>
  dispatcher.dispatch({ outboxId, brandId, event, payload: { ticketId }, tx, log: silentLogger });

describe('registerSlaEventHandlers', () => {
  it('registers `sla.schedule` and no stand-in for the events it writes', async () => {
    const dispatcher = createOutboxDispatcher();
    registerSlaEventHandlers(deps, dispatcher);

    expect(dispatcher.events).toContain('sla.schedule');
    expect(dispatcher.events).toContain('sla.status_resync');
    // M3-07 consumes all three for real; an unconsumed one fails loudly.
    for (const event of Object.values(SLA_EVENTS)) {
      await expect(dispatch(dispatcher, event)).rejects.toThrow(UnknownOutboxEventError);
    }
  });

  it('lets the rules and the notifications both subscribe to `sla.breached`', async () => {
    const dispatcher = createOutboxDispatcher();
    const heard: string[] = [];
    const evaluations: RulesEvaluatePayload[] = [];
    registerRulesEventHandlers(
      {
        add: async (payload) => {
          evaluations.push(payload);
          heard.push('rules');
          await Promise.resolve();
        },
      },
      dispatcher,
    );
    registerSlaEventHandlers(deps, dispatcher);
    dispatcher.register(
      SLA_EVENTS.breached,
      async () => {
        heard.push('notifications');
        await Promise.resolve();
      },
      'notifications',
    );

    await dispatch(dispatcher, SLA_EVENTS.breached);

    expect(heard).toEqual(['rules', 'notifications']);
    expect(evaluations.map((evaluation) => evaluation.triggers)).toEqual([['sla_breached']]);
  });
});

describe('createSlaStatusResyncHandler', () => {
  const statusId = '01924f00-0000-7000-8000-0000000000d1';
  const at = new Date('2026-10-20T10:00:00.000Z');
  const ids = ['01924f00-0000-7000-8000-0000000000e1', '01924f00-0000-7000-8000-0000000000e2'];

  const harness = (found: string[], statusResyncBatch: number) => {
    const synced: string[] = [];
    const asked: (string | undefined)[] = [];
    const inserted: unknown[] = [];
    const handler = createSlaStatusResyncHandler({
      statusResyncBatch,
      repository: {
        openTicketIdsInStatus: async (_tx: unknown, _status: string, after?: string) => {
          asked.push(after);
          return found;
        },
      },
      sla: {
        syncMany: async (
          _tx: unknown,
          _brand: string,
          ticketIds: string[],
          change: { at: Date; notBeforeCheckpoint?: boolean },
        ) => {
          expect(change).toEqual({ at, notBeforeCheckpoint: true });
          synced.push(...ticketIds);
        },
      },
    } as unknown as SlaWorkerDeps);
    const run = (payload: Record<string, unknown>) =>
      handler({
        outboxId,
        brandId,
        event: 'sla.status_resync',
        payload,
        tx: {
          insert: () => ({
            values: (row: unknown) => {
              inserted.push(row);
              return { returning: async () => [{ id: outboxId }] };
            },
          }),
        } as unknown as DbTransaction,
        log: silentLogger,
      });
    return { run, synced, asked, inserted };
  };

  it('syncs every ticket of the batch and stops when the batch is short', async () => {
    const { run, synced, inserted } = harness(ids, 5);
    await run({ statusId, at: at.toISOString() });
    expect(synced).toEqual(ids);
    expect(inserted).toEqual([]);
  });

  it('writes the next batch after the last ticket when the batch is full', async () => {
    const { run, synced, inserted } = harness(ids, 2);
    await run({ statusId, at: at.toISOString(), afterId: ids[0] });
    expect(synced).toEqual(ids);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      brandId,
      event: 'sla.status_resync',
      payload: { statusId, at: at.toISOString(), afterId: ids[1] },
    });
  });

  it('refuses a payload that is not a status id and a time', async () => {
    const { run, synced } = harness(ids, 2);
    await expect(run({ statusId: 'nope', at: at.toISOString() })).rejects.toThrow();
    expect(synced).toEqual([]);
  });
});
