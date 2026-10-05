import type { Db } from '@helpdock/db';
import { silentLogger, statsRollupJob, statsRollupScheduleJob } from '@helpdock/jobs';
import { type Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { createStatsProcessor, scheduleStatsRollup } from './rollup.job.js';

const BRAND_A = '01924f00-0000-7000-8000-0000000000aa';
const BRAND_B = '01924f00-0000-7000-8000-0000000000bb';

/** `select … from brands where …`: the active brands, and nothing else asked of it. */
const brandsDb = (ids: readonly string[]): Db =>
  ({
    select: () => ({ from: () => ({ where: async () => ids.map((id) => ({ id })) }) }),
  }) as unknown as Db;

const job = (name: string, data: unknown): Job => ({ name, data, id: 'job-1' }) as Job;

describe('scheduleStatsRollup', () => {
  it('adds one job per active brand, keyed by the brand and the hour', async () => {
    const added: { payload: unknown; jobId: string }[] = [];
    const count = await scheduleStatsRollup({
      db: brandsDb([BRAND_A, BRAND_B]),
      queue: { add: async (payload, jobId) => void added.push({ payload, jobId }) },
      now: new Date('2026-10-05T09:07:31.000Z'),
    });

    const tick = '2026-10-05T09:00:00.000Z';
    expect(count).toBe(2);
    expect(added).toEqual([
      { payload: { brandId: BRAND_A, tick }, jobId: `stats.rollup.${BRAND_A}.${Date.parse(tick)}` },
      { payload: { brandId: BRAND_B, tick }, jobId: `stats.rollup.${BRAND_B}.${Date.parse(tick)}` },
    ]);
  });
});

describe('createStatsProcessor', () => {
  const processor = createStatsProcessor({
    db: brandsDb([BRAND_A]),
    log: silentLogger,
    queue: { add: async () => undefined },
  });

  it('handles the schedule and the per-brand job, and nothing else on the queue', async () => {
    await expect(processor(job(statsRollupScheduleJob.name, {}))).resolves.toBeUndefined();
    expect(processor(job('maintenance.retention', {}))).toBeUndefined();
  });

  it('fails a malformed payload for good, since a retry would fail the same way', () => {
    expect(() => processor(job(statsRollupJob.name, { brandId: 'nope' }))).toThrow(
      UnrecoverableError,
    );
  });
});
