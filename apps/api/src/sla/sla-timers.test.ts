import { slaTimerJobId } from '@helpdock/jobs';
import { alwaysOpenCalendar } from '@helpdock/schemas';
import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { breach, type Clock, markFired, pause, startClock } from './clock.js';
import { applyTimers, bullTimerQueue, planTimers, type SlaTimer } from './sla-timers.js';

const utc = alwaysOpenCalendar('UTC');
const BRAND = '01937f5e-7e53-7000-8000-00000000000b';
const TICKET = '01937f5e-7e53-7000-8000-00000000000c';
const DEPARTMENT = '01937f5e-7e53-7000-8000-0000000000d1';
const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 1, 9, minutes));

const resolution: Clock = startClock(
  { kind: 'resolution', cycle: 0, policyId: 'p', targetMinutes: 100, timeMode: 'calendar' },
  utc,
  at(0),
);

const plan = (clocks: Clock[], stepPercents = [50, 150]) =>
  planTimers({
    brandId: BRAND,
    ticketId: TICKET,
    departmentId: DEPARTMENT,
    clocks,
    stepPercents,
    calendarFor: () => utc,
  });

describe('planTimers', () => {
  it('wants every step and the breach of a counting clock, keyed per clock and step', () => {
    const { wanted, unwanted } = plan([resolution]);

    expect(wanted.map((timer) => [timer.jobId, timer.fireAt])).toEqual([
      [`sla.${TICKET}.resolution.50`, at(50)],
      [`sla.${TICKET}.resolution.100`, at(100)],
      [`sla.${TICKET}.resolution.150`, at(150)],
    ]);
    expect(unwanted).toContain(`sla.${TICKET}.first_response.100`);
    expect(unwanted).not.toContain(`sla.${TICKET}.resolution.100`);
  });

  it('never wants a fired step or a recorded breach again', () => {
    const fired = breach(markFired(resolution, 50, at(50)), at(100));

    expect(plan([fired]).wanted.map((timer) => timer.payload.stepPercent)).toEqual([150]);
  });

  it('wants nothing of a paused clock, so a pause removes its timers', () => {
    const { wanted, unwanted } = plan([pause(resolution, utc, at(10))]);

    expect(wanted).toEqual([]);
    expect(unwanted).toContain(
      slaTimerJobId({ ticketId: TICKET, clock: 'resolution', stepPercent: 50 }),
    );
  });
});

describe('applyTimers', () => {
  it('removes what is unwanted before adding what is wanted', async () => {
    const calls: string[] = [];
    await applyTimers(
      {
        upsert: async (timer: SlaTimer) => void calls.push(`upsert ${timer.jobId}`),
        remove: async (jobId: string) => void calls.push(`remove ${jobId}`),
      },
      { wanted: plan([resolution], []).wanted, unwanted: ['stale'] },
      at(0),
    );

    expect(calls).toEqual(['remove stale', `upsert sla.${TICKET}.resolution.100`]);
  });
});

describe('bullTimerQueue', () => {
  const timer = plan([resolution], []).wanted[0] as SlaTimer;

  const fakeQueue = (state: string | undefined) => {
    const calls: unknown[][] = [];
    const job =
      state === undefined
        ? undefined
        : {
            getState: async () => state,
            changeDelay: async (delay: number) => void calls.push(['changeDelay', delay]),
            remove: async () => void calls.push(['remove']),
          };
    const queue = {
      getJob: async () => job,
      add: async (...args: unknown[]) => void calls.push(['add', ...args]),
    } as unknown as Queue;

    return { queue: bullTimerQueue(queue), calls };
  };

  it('adds a missing timer with its delay and id', async () => {
    const { queue, calls } = fakeQueue(undefined);
    await queue.upsert(timer, at(40));

    expect(calls[0]?.[0]).toBe('add');
    expect(calls[0]?.[3]).toMatchObject({ jobId: timer.jobId, delay: 60 * 60_000 });
  });

  it('moves a delayed timer, leaves a running one, and replaces anything else', async () => {
    const delayed = fakeQueue('delayed');
    await delayed.queue.upsert(timer, at(40));
    expect(delayed.calls).toEqual([['changeDelay', 60 * 60_000]]);

    const active = fakeQueue('active');
    await active.queue.upsert(timer, at(40));
    await active.queue.remove(timer.jobId);
    expect(active.calls).toEqual([]);

    const failed = fakeQueue('failed');
    await failed.queue.upsert(timer, at(40));
    expect(failed.calls.map((call) => call[0])).toEqual(['remove', 'add']);

    const waiting = fakeQueue('waiting');
    await waiting.queue.remove(timer.jobId);
    expect(waiting.calls).toEqual([['remove']]);
  });
});
