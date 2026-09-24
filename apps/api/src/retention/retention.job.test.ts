import type { Db } from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import { type Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { createMaintenanceProcessor } from './retention.job.js';

/**
 * The processor's routing, without a database. What each job *does* is proved
 * against a real Postgres in `retention.integration.test.ts`.
 */

const processor = createMaintenanceProcessor({
  db: {} as Db,
  queue: { add: async () => {} },
  log: silentLogger,
});

const job = (name: string, data: unknown = {}): Job =>
  ({ name, data, id: 'job-1' }) as unknown as Job;

describe('the maintenance processor', () => {
  it('refuses a job name it does not handle, for good', async () => {
    await expect(processor(job('stats.rollup'))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('refuses a retention payload that can never become valid, for good', async () => {
    await expect(
      processor(job('maintenance.retention', { brandId: 'not-a-uuid', runDate: 'tonight' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
