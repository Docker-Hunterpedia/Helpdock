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
import { registerSlaEventHandlers } from './sla-worker.js';

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
