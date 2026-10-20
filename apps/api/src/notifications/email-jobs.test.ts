import type { Db } from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import { DelayedError, type Job, type Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationEmailEngine } from './email-engine.js';
import {
  bullEmailQueue,
  createEmailJobProcessors,
  type NotifyEmailQueue,
  topOfHour,
} from './email-jobs.js';

vi.mock('../tenant/system-job.js', () => ({
  withSystemJob: async (_db: unknown, _brand: string, _job: string, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

const BRAND_A = '0199f4b2-0000-7000-8000-0000000000a1';
const BRAND_B = '0199f4b2-0000-7000-8000-0000000000b1';
const BATCH = '0199f4b2-5555-7000-8000-000000000001';
const NOW = new Date('2026-10-20T09:17:42.000Z');

/** `db.select().from(brands).where(…)`, answering two live brands. */
const db = {
  select: () => ({
    from: () => ({ where: async () => [{ id: BRAND_A }, { id: BRAND_B }] }),
  }),
} as unknown as Db;

const recorder = () => {
  const calls: string[] = [];
  const queue: NotifyEmailQueue = {
    place: async (brandId, { batchId, at }) =>
      void calls.push(`place ${brandId} ${batchId} ${at.toISOString()}`),
    addDigestTick: async (brandId, hour) => void calls.push(`tick ${brandId} ${hour}`),
    addRebuild: async (brandId, jobId) => void calls.push(`rebuild ${brandId} ${jobId}`),
  };
  return { calls, queue };
};

const processors = (queue: NotifyEmailQueue) =>
  createEmailJobProcessors({
    db,
    queue,
    engine: {} as NotificationEmailEngine,
    log: silentLogger,
    now: () => NOW,
  });

describe('the notify email jobs (M14-10)', () => {
  it('fans the hourly digest tick out per brand, for the top of the hour it stands for', async () => {
    const { calls, queue } = recorder();

    await processors(queue)['notify.digest.tick']({
      id: 'repeat:1',
      name: 'notify.digest.tick',
      data: {},
    } as Job);

    expect(calls).toEqual([
      `tick ${BRAND_A} 2026-10-20T09:00:00.000Z`,
      `tick ${BRAND_B} 2026-10-20T09:00:00.000Z`,
    ]);
  });

  it('fans the rebuild out per brand, with ids BullMQ accepts', async () => {
    const { calls, queue } = recorder();

    await processors(queue)['notify.email_rebuild']({
      id: 'repeat:abc:1',
      name: 'notify.email_rebuild',
      data: {},
    } as Job);

    expect(calls).toEqual([
      `rebuild ${BRAND_A} notify.email_rebuild.${BRAND_A}.repeat.abc.1`,
      `rebuild ${BRAND_B} notify.email_rebuild.${BRAND_B}.repeat.abc.1`,
    ]);
  });

  it('refuses a tick that names a brand without an hour', async () => {
    const { queue } = recorder();

    await expect(
      processors(queue)['notify.digest.tick']({
        id: '1',
        name: 'notify.digest.tick',
        data: { brandId: BRAND_A },
      } as Job),
    ).rejects.toThrow(/brandId and hour/);
  });

  it('takes the top of the hour', () => {
    expect(topOfHour(NOW)).toEqual(new Date('2026-10-20T09:00:00.000Z'));
  });
});

describe('bullEmailQueue', () => {
  const fakeQueue = (state: string | null) => {
    const calls: string[] = [];
    const job =
      state === null
        ? undefined
        : {
            getState: async () => state,
            changeDelay: async (delay: number) => void calls.push(`changeDelay ${delay}`),
            remove: async () => void calls.push('remove'),
          };
    const queue = {
      getJob: async (id: string) => {
        calls.push(`getJob ${id}`);
        return job;
      },
      add: async (name: string, data: unknown, options: { jobId: string; delay: number }) =>
        void calls.push(`add ${name} ${JSON.stringify(data)} ${options.jobId} ${options.delay}`),
    } as unknown as Queue;
    return { calls, queue };
  };
  const placement = { batchId: BATCH, at: new Date(NOW.getTime() + 120_000) };

  it('adds the batch job, delayed to its time, under notify.batch.<id>', async () => {
    const { calls, queue } = fakeQueue(null);
    await bullEmailQueue(queue).place(BRAND_A, placement, NOW);

    expect(calls).toEqual([
      `getJob notify.batch.${BATCH}`,
      `add notify.email_batch {"brandId":"${BRAND_A}","batchId":"${BATCH}"} notify.batch.${BATCH} 120000`,
    ]);
  });

  it('moves a delayed one, leaves a running one, and replaces a finished one', async () => {
    const delayed = fakeQueue('delayed');
    await bullEmailQueue(delayed.queue).place(BRAND_A, placement, NOW);
    expect(delayed.calls.slice(1)).toEqual(['changeDelay 120000']);

    const active = fakeQueue('active');
    await bullEmailQueue(active.queue).place(BRAND_A, placement, NOW);
    expect(active.calls.slice(1)).toEqual([]);

    const failed = fakeQueue('failed');
    await bullEmailQueue(failed.queue).place(BRAND_A, { batchId: BATCH, at: NOW }, NOW);
    expect(failed.calls.slice(1)).toEqual([
      'remove',
      `add notify.email_batch {"brandId":"${BRAND_A}","batchId":"${BATCH}"} notify.batch.${BATCH} 0`,
    ]);
  });

  describe('after the batch job moved itself', () => {
    const LATER = new Date(NOW.getTime() + 3_600_000);
    const EARLIER = new Date(NOW.getTime() + 60_000);
    const run = async (
      engine: Partial<NotificationEmailEngine>,
      changeDelay: () => Promise<void>,
    ) => {
      const warnings: unknown[] = [];
      const p = createEmailJobProcessors({
        db,
        queue: recorder().queue,
        engine: {
          send: async () => ({ kind: 'later', at: LATER }),
          ...engine,
        } as unknown as NotificationEmailEngine,
        log: { ...silentLogger, warn: (...args: unknown[]) => void warnings.push(args) },
        now: () => NOW,
      });
      const job = {
        id: `notify.batch.${BATCH}`,
        name: 'notify.email_batch',
        data: { brandId: BRAND_A, batchId: BATCH },
        attemptsMade: 0,
        opts: {},
        moveToDelayed: async () => undefined,
        changeDelay,
      } as unknown as Job;
      await expect(p['notify.email_batch'](job, 't')).rejects.toBeInstanceOf(DelayedError);
      return warnings;
    };

    it('still ends delayed, with a warning, when changeDelay throws', async () => {
      const warnings = await run({ dueAt: async () => EARLIER }, async () => {
        throw new Error('JobNotInState');
      });
      expect(warnings).toHaveLength(1);
    });

    it('still ends delayed, with a warning, when the re-read throws', async () => {
      const changed: boolean[] = [];
      const warnings = await run(
        {
          dueAt: async () => {
            throw new Error('connection lost');
          },
        },
        async () => void changed.push(true),
      );
      expect(warnings).toHaveLength(1);
      expect(changed).toEqual([]);
    });
  });
});
