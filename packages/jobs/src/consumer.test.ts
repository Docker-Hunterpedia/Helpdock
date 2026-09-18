import type { Db } from '@helpdock/db';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { createJobProcessor } from './consumer.js';
import { outboxEventJob } from './jobs.js';

/**
 * Everything the processor refuses is refused before it opens a transaction, so
 * a database that throws on use proves both the refusal and that nothing was
 * claimed on the way there.
 */
const unusableDb = {
  transaction: () => {
    throw new Error('the processor must not open a transaction for a job it refuses');
  },
} as unknown as Db;

const jobOf = (overrides: {
  readonly id?: string | undefined;
  readonly name?: string;
  readonly data?: unknown;
}): Job =>
  ({
    id: '01924f00-0000-7000-8000-000000000001',
    name: outboxEventJob.name,
    data: {
      outboxId: '01924f00-0000-7000-8000-000000000001',
      brandId: '01924f00-0000-7000-8000-0000000000aa',
      event: 'settings.changed',
      payload: {},
    },
    ...overrides,
  }) as Job;

const process = (job: Job) =>
  createJobProcessor(outboxEventJob, () => Promise.resolve(), { db: unusableDb })(job);

describe('createJobProcessor', () => {
  it('refuses a job of another name on the same queue', async () => {
    await expect(process(jobOf({ name: 'outbox.relay' }))).rejects.toThrow(UnrecoverableError);
    await expect(process(jobOf({ name: 'outbox.relay' }))).rejects.toThrow(
      /only handles outbox\.event/,
    );
  });

  it('refuses a job with no id, because no delivery of it could be deduplicated', async () => {
    await expect(process(jobOf({ id: undefined }))).rejects.toThrow(/without an id/);
  });

  it('fails an invalid payload with its Zod issues instead of retrying it', async () => {
    const job = jobOf({ data: { outboxId: 'not-a-uuid', brandId: 'neither', event: 'nope' } });

    // Without the remaining attempts there would be nothing for
    // `UnrecoverableError` to skip, and the assertion below would be vacuous.
    expect(outboxEventJob.options.attempts).toBeGreaterThan(1);

    await expect(process(job)).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(process(job)).rejects.toThrow(/outboxId: .*brandId: .*event: /s);
  });

  it('lets an error that is not a validation failure through untouched', async () => {
    const handler = vi.fn();
    const db = {
      transaction: () => Promise.reject(new Error('connection terminated')),
    } as unknown as Db;

    await expect(createJobProcessor(outboxEventJob, handler, { db })(jobOf({}))).rejects.toThrow(
      'connection terminated',
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
