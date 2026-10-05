import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import {
  createOutboxDispatcher,
  createOutboxEventHandler,
  type OutboxEventContext,
  SETTINGS_CHANGED_EVENT,
  UnknownOutboxEventError,
} from './dispatcher.js';
import type { JobLogger } from './logger.js';

interface LogLine {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

const recordingLogger = (): JobLogger & { readonly lines: LogLine[] } => {
  const lines: LogLine[] = [];
  const record = (fields: Record<string, unknown>, message: string): void => {
    lines.push({ fields, message });
  };
  return { lines, info: record, warn: record, error: record };
};

// The dispatcher never touches the transaction; it only hands it to the handler,
// so a marker object is enough to prove it arrives unchanged.
const tx = { marker: 'tenant transaction' } as unknown as DbTransaction;

const contextFor = (event: string, log: JobLogger): OutboxEventContext => ({
  outboxId: '01924f00-0000-7000-8000-000000000001',
  brandId: '01924f00-0000-7000-8000-0000000000aa',
  event,
  payload: { key: 'smtp.host' },
  tx,
  log,
});

describe('createOutboxDispatcher', () => {
  it('starts with the built-in settings.changed handler', () => {
    expect(createOutboxDispatcher().events).toEqual([SETTINGS_CHANGED_EVENT]);
  });

  it('calls the registered handler with the tenant transaction', async () => {
    const dispatcher = createOutboxDispatcher();
    const handler = vi.fn().mockResolvedValue(undefined);
    dispatcher.register('ticket.replied', handler);

    const log = recordingLogger();
    await dispatcher.dispatch(contextFor('ticket.replied', log));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ event: 'ticket.replied', tx });
  });

  it('fails an unknown event with the registered names, so the gap is obvious', async () => {
    const dispatcher = createOutboxDispatcher();
    const log = recordingLogger();

    await expect(dispatcher.dispatch(contextFor('ticket.replied', log))).rejects.toThrow(
      UnknownOutboxEventError,
    );
    await expect(dispatcher.dispatch(contextFor('ticket.replied', log))).rejects.toThrow(
      /Registered events: settings\.changed/,
    );
  });

  it('refuses the same handler twice for one event, even under another name', () => {
    const dispatcher = createOutboxDispatcher();
    const handler = () => Promise.resolve();
    dispatcher.register('ticket.replied', handler);

    expect(() => dispatcher.register('ticket.replied', handler, 'rules')).toThrow(
      /already registered/,
    );
  });

  it('refuses a second handler in the default slot', () => {
    const dispatcher = createOutboxDispatcher();
    dispatcher.register('ticket.replied', () => Promise.resolve());

    expect(() => dispatcher.register('ticket.replied', () => Promise.resolve())).toThrow(
      /An outbox handler for ticket\.replied is already registered\./,
    );
  });

  it('stops at the first handler that throws, so the whole job is retried', async () => {
    const dispatcher = createOutboxDispatcher();
    const later = vi.fn().mockResolvedValue(undefined);
    dispatcher.register('ticket.replied', () => Promise.reject(new Error('redis is down')));
    dispatcher.register('ticket.replied', later, 'rules');

    await expect(
      dispatcher.dispatch(contextFor('ticket.replied', recordingLogger())),
    ).rejects.toThrow('redis is down');
    expect(later).not.toHaveBeenCalled();
  });

  it('refuses a second handler from the same named subscriber', () => {
    const dispatcher = createOutboxDispatcher();
    dispatcher.register('ticket.replied', () => Promise.resolve(), 'notifications');

    expect(() =>
      dispatcher.register('ticket.replied', () => Promise.resolve(), 'notifications'),
    ).toThrow(/already registered by notifications/);
  });

  it('runs every subscriber of an event, in the order they registered', async () => {
    const dispatcher = createOutboxDispatcher();
    const calls: string[] = [];
    const recordAs = (name: string) => async () => {
      calls.push(name);
    };
    dispatcher.register('ticket.replied', recordAs('rules'), 'rules');
    dispatcher.register('ticket.replied', recordAs('sockets'));
    dispatcher.register('ticket.replied', recordAs('notifications'), 'notifications');

    await dispatcher.dispatch(contextFor('ticket.replied', recordingLogger()));

    expect(calls).toEqual(['rules', 'sockets', 'notifications']);
    expect(dispatcher.events).toEqual([SETTINGS_CHANGED_EVENT, 'ticket.replied']);
  });

  it('refuses an event name the outbox could never hold', () => {
    expect(() =>
      createOutboxDispatcher().register('TicketReplied', () => Promise.resolve()),
    ).toThrow(/Invalid outbox event name/);
  });

  it('propagates what a handler throws, so BullMQ retries it', async () => {
    const dispatcher = createOutboxDispatcher();
    dispatcher.register('ticket.replied', () => Promise.reject(new Error('smtp is down')));

    await expect(
      dispatcher.dispatch(contextFor('ticket.replied', recordingLogger())),
    ).rejects.toThrow('smtp is down');
  });
});

describe('the built-in settings.changed handler', () => {
  it('logs the key and never the value', async () => {
    const log = recordingLogger();
    const dispatcher = createOutboxDispatcher();

    await dispatcher.dispatch({
      ...contextFor(SETTINGS_CHANGED_EVENT, log),
      payload: { key: 'smtp.password', value: 'hunter2' },
    });

    expect(log.lines[0]?.fields).toMatchObject({ key: 'smtp.password' });
    expect(JSON.stringify(log.lines[0])).not.toContain('hunter2');
  });

  it('leaves the key out when it is not a string', async () => {
    const log = recordingLogger();

    await createOutboxDispatcher().dispatch({
      ...contextFor(SETTINGS_CHANGED_EVENT, log),
      payload: { key: { nested: true } },
    });

    expect(log.lines[0]?.fields.key).toBeUndefined();
  });
});

describe('createOutboxEventHandler', () => {
  it('takes the ordering lock, then unpacks the job payload into a dispatch', async () => {
    const dispatcher = createOutboxDispatcher();
    const steps: string[] = [];
    const handler = vi.fn().mockImplementation(() => {
      steps.push('dispatch');
      return Promise.resolve();
    });
    dispatcher.register('ticket.replied', handler);
    const lockingTx = {
      execute: vi.fn().mockImplementation(() => {
        steps.push('lock');
        return Promise.resolve([]);
      }),
    } as unknown as DbTransaction;

    const log = recordingLogger();
    await createOutboxEventHandler(dispatcher)({
      payload: {
        outboxId: '01924f00-0000-7000-8000-000000000001',
        brandId: '01924f00-0000-7000-8000-0000000000aa',
        event: 'ticket.replied',
        payload: { ticketId: 7 },
      },
      brandId: '01924f00-0000-7000-8000-0000000000aa',
      tx: lockingTx,
      job: { id: 'job-1' } as never,
      log,
    });

    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      event: 'ticket.replied',
      payload: { ticketId: 7 },
      outboxId: '01924f00-0000-7000-8000-000000000001',
    });
    expect(steps).toEqual(['lock', 'dispatch']);
  });
});
