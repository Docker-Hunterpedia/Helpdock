import type { DbTransaction } from '@helpdock/db';
import { silentLogger, ticketUnsnoozeJobId } from '@helpdock/jobs';
import { describe, expect, it } from 'vitest';
import {
  createTicketSnoozedHandler,
  registerSnoozeEventHandlers,
  type SnoozeTimer,
  type SnoozeTimerQueue,
} from './snooze-worker.js';

const BRAND = '01937f5e-7e53-7000-8000-0000000000b1';
const TICKET = '01937f5e-7e53-7000-8000-0000000000a1';
const DEPARTMENT = '01937f5e-7e53-7000-8000-0000000000d1';
const NOW = new Date('2026-10-21T12:00:00.000Z');

/** A queue that remembers what it was asked, so the planning rule can be read off it. */
const fakeQueue = () => {
  const upserts: { timer: SnoozeTimer; now: Date }[] = [];
  const removed: string[] = [];
  const queue: SnoozeTimerQueue = {
    upsert: async (timer, now) => {
      upserts.push({ timer, now });
    },
    remove: async (jobId) => {
      removed.push(jobId);
    },
  };

  return { queue, upserts, removed };
};

const run = (
  handler: ReturnType<typeof createTicketSnoozedHandler>,
  payload: Record<string, unknown>,
) =>
  handler({
    outboxId: 'outbox-1',
    brandId: BRAND,
    event: 'ticket.snoozed',
    payload,
    tx: {} as DbTransaction,
    log: silentLogger,
  });

describe('the ticket.snoozed handler', () => {
  it('adds the wake timer under the ticket and version, at the time the snooze names', async () => {
    const { queue, upserts, removed } = fakeQueue();
    const handler = createTicketSnoozedHandler({ snoozeTimers: queue, now: () => NOW });

    await run(handler, {
      ticketId: TICKET,
      departmentId: DEPARTMENT,
      version: 1,
      snoozedUntil: '2026-10-25T09:00:00.000Z',
    });

    expect(upserts).toEqual([
      {
        now: NOW,
        timer: {
          jobId: ticketUnsnoozeJobId({ ticketId: TICKET, version: 1 }),
          fireAt: new Date('2026-10-25T09:00:00.000Z'),
          payload: { brandId: BRAND, ticketId: TICKET, version: 1 },
        },
      },
    ]);
    // A first snooze has no version before it to supersede.
    expect(removed).toEqual([]);
  });

  it('removes the timer of the version before when a snooze is moved', async () => {
    const { queue, upserts, removed } = fakeQueue();
    const handler = createTicketSnoozedHandler({ snoozeTimers: queue, now: () => NOW });

    await run(handler, {
      ticketId: TICKET,
      departmentId: DEPARTMENT,
      version: 3,
      snoozedUntil: '2026-10-25T09:00:00.000Z',
    });

    expect(removed).toEqual([ticketUnsnoozeJobId({ ticketId: TICKET, version: 2 })]);
    expect(upserts).toHaveLength(1);
  });

  it('refuses a payload without a version or with a time that is not one, and adds nothing', async () => {
    const { queue, upserts } = fakeQueue();
    const handler = createTicketSnoozedHandler({ snoozeTimers: queue, now: () => NOW });

    await expect(
      run(handler, { ticketId: TICKET, departmentId: DEPARTMENT, snoozedUntil: NOW.toISOString() }),
    ).rejects.toThrow();
    await expect(
      run(handler, {
        ticketId: TICKET,
        departmentId: DEPARTMENT,
        version: 1,
        snoozedUntil: 'soon',
      }),
    ).rejects.toThrow();
    expect(upserts).toEqual([]);
  });

  it('registers itself for ticket.snoozed and nothing else', () => {
    const registered: string[] = [];
    registerSnoozeEventHandlers({ snoozeTimers: fakeQueue().queue }, {
      register: (event: string) => void registered.push(event),
    } as never);

    expect(registered).toEqual(['ticket.snoozed']);
  });
});
