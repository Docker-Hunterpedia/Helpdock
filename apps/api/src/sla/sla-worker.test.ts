import type { DbTransaction } from '@helpdock/db';
import { createOutboxDispatcher, type JobLogger, type RulesEvaluatePayload } from '@helpdock/jobs';
import { SLA_EVENTS } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { registerRulesEventHandlers } from '../rules/rules-jobs.js';
import type { SlaWorkerDeps } from './sla-worker.js';
import { registerSlaEventHandlers } from './sla-worker.js';

const brandId = '01924f00-0000-7000-8000-00000000000a';
const ticketId = '01924f00-0000-7000-8000-0000000000b1';
const outboxId = '01924f00-0000-7000-8000-0000000000c1';

const FALLBACK = 'SLA event recorded; no consumer registered for it yet';

const logger = () => {
  const info = vi.fn();
  const log = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as JobLogger;
  return { log, info };
};

// Neither handler under test touches the SLA engine or the transaction.
const deps = {} as SlaWorkerDeps;
const tx = {} as DbTransaction;

const dispatch = (
  dispatcher: ReturnType<typeof createOutboxDispatcher>,
  event: string,
  log: JobLogger,
): Promise<void> =>
  dispatcher.dispatch({ outboxId, brandId, event, payload: { ticketId }, tx, log });

describe('the SLA events’ log-only fallback (M3-02 beside M3-03)', () => {
  it('logs every SLA event when nothing else consumes them', async () => {
    const dispatcher = createOutboxDispatcher();
    const { log, info } = logger();
    registerSlaEventHandlers(deps, log, dispatcher);

    for (const event of Object.values(SLA_EVENTS)) {
      await dispatch(dispatcher, event, log);
    }

    expect(info.mock.calls.filter(([, message]) => message === FALLBACK)).toHaveLength(3);
  });

  it('leaves `sla.warning` and `sla.breached` to the rules registered before it, and still logs `ticket.escalated`', async () => {
    const dispatcher = createOutboxDispatcher();
    const { log, info } = logger();
    const evaluations: RulesEvaluatePayload[] = [];
    registerRulesEventHandlers(
      {
        add: async (payload) => {
          evaluations.push(payload);
          await Promise.resolve();
        },
      },
      dispatcher,
    );
    registerSlaEventHandlers(deps, log, dispatcher);

    await dispatch(dispatcher, SLA_EVENTS.warning, log);
    await dispatch(dispatcher, SLA_EVENTS.breached, log);
    expect(evaluations.map((evaluation) => evaluation.triggers)).toEqual([
      ['sla_warning'],
      ['sla_breached'],
    ]);
    expect(info.mock.calls.some(([, message]) => message === FALLBACK)).toBe(false);

    await dispatch(dispatcher, SLA_EVENTS.escalated, log);
    expect(info.mock.calls.filter(([, message]) => message === FALLBACK)).toHaveLength(1);
    expect(evaluations).toHaveLength(2);
  });
});
