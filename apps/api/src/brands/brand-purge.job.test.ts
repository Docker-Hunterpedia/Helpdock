import type { Db } from '@helpdock/db';
import { brandPurgeJob, brandPurgeScheduleJob, silentLogger } from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { deletionOf } from './brand-deletion.service.js';
import { createBrandPurgeProcessor, runBrandPurge } from './brand-purge.job.js';

const BRAND = '01924f00-0000-7000-8000-0000000000aa';
const REQUESTED = new Date('2026-09-01T10:00:00.000Z');

/** `select … from brands where … [limit]` answering `rows`. */
const brandsDb = (rows: readonly Record<string, unknown>[]): Db => {
  const where = () => Object.assign(Promise.resolve(rows), { limit: async () => rows });
  return { select: () => ({ from: () => ({ where }) }) } as unknown as Db;
};

const untouched = {
  objects: {
    usage: async () => ({ bytes: 0, objects: 0 }),
    removeAll: async () => {
      throw new Error('nothing should be removed');
    },
  },
  redis: {} as Redis,
};

describe('runBrandPurge', () => {
  it.each([
    ['missing', [], new Date()],
    ['restored', [{ status: 'active', deletedAt: null }], new Date()],
    ['not_due', [{ status: 'deleting', deletedAt: REQUESTED }], new Date('2026-09-30T10:00:00Z')],
  ] as const)('skips a brand that is %s', async (reason, rows, now) => {
    const result = await runBrandPurge({
      db: brandsDb(rows),
      ...untouched,
      brandId: BRAND,
      jobId: 'job-1',
      now,
    });

    expect(result).toEqual({ outcome: 'skipped', reason });
  });
});

describe('createBrandPurgeProcessor', () => {
  const processor = createBrandPurgeProcessor({
    db: brandsDb([{ id: BRAND }]),
    ...untouched,
    log: silentLogger,
    queue: { add: async () => undefined },
  });
  const job = (name: string, data: unknown): Job => ({ name, data, id: 'job-1' }) as Job;

  it('handles the nightly tick and the purge, and nothing else on the queue', async () => {
    await expect(processor(job(brandPurgeScheduleJob.name, {}))).resolves.toBeUndefined();
    expect(processor(job('stats.rollup', {}))).toBeUndefined();
  });

  it('fails a malformed payload for good', () => {
    expect(() => processor(job(brandPurgeJob.name, { brandId: 'nope' }))).toThrow(
      UnrecoverableError,
    );
  });
});

describe('deletionOf', () => {
  const row = { id: BRAND, name: 'Acme', prefix: 'AC' };

  it('has no dates for an active brand', () => {
    expect(deletionOf({ ...row, status: 'active', deletedAt: null })).toEqual({
      brandId: BRAND,
      status: 'active',
      requestedAt: null,
      purgeAfter: null,
    });
  });

  it('ends the grace thirty days after the request', () => {
    expect(deletionOf({ ...row, status: 'deleting', deletedAt: REQUESTED })).toEqual({
      brandId: BRAND,
      status: 'deleting',
      requestedAt: '2026-09-01T10:00:00.000Z',
      purgeAfter: '2026-10-01T10:00:00.000Z',
    });
  });
});
