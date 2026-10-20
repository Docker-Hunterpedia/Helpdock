import { brands, type Db } from '@helpdock/db';
import {
  type JobLogger,
  notifyDigestTickJob,
  notifyDigestTickJobId,
  notifyEmailBatchJob,
  notifyEmailBatchJobId,
  notifyEmailRebuildJob,
  notifyEmailScheduleJob,
  parseJobPayloadOrFail,
} from '@helpdock/jobs';
import { DelayedError, type Job, type Queue } from 'bullmq';
import { ne } from 'drizzle-orm';
import { withSystemJob } from '../tenant/system-job.js';
import {
  NotificationEmailDeliveryError,
  type NotificationEmailEngine,
  type Placement,
  type SendOutcome,
} from './email-engine.js';

/**
 * The `notify` queue's four M14-10 jobs around {@link NotificationEmailEngine}:
 * parse, open the brand's system transaction, let the engine decide, and only
 * after that commits touch BullMQ. A cron or boot tick without a brand fans
 * out one job per brand (DOMAIN-RULES §1.4), as `sla.rebuild` does.
 */

/** What the jobs ask of BullMQ. The worker passes {@link bullEmailQueue}; tests may pass a recorder. */
export interface NotifyEmailQueue {
  /** Adds the batch's job to run at `at`, or moves the one already there. */
  place(brandId: string, placement: Placement, now: Date): Promise<void>;
  addDigestTick(brandId: string, hour: string): Promise<void>;
  addRebuild(brandId: string, jobId: string): Promise<void>;
}

/**
 * The BullMQ adapter. A delayed job under the batch's id is moved with
 * `changeDelay`; a running one is left alone, because after it moves itself
 * it re-reads the batch and pulls itself earlier if a cut landed meanwhile;
 * anything else under the id (finished, failed, waiting) is replaced.
 */
export const bullEmailQueue = (queue: Queue): NotifyEmailQueue => ({
  place: async (brandId, { batchId, at }, now) => {
    const jobId = notifyEmailBatchJobId(batchId);
    const delay = Math.max(0, at.getTime() - now.getTime());
    const existing = await queue.getJob(jobId);
    if (existing !== undefined) {
      const state = await existing.getState();
      if (state === 'active') {
        return;
      }
      if (state === 'delayed') {
        await existing.changeDelay(delay);
        return;
      }
      await existing.remove();
    }

    await queue.add(
      notifyEmailBatchJob.name,
      { brandId, batchId },
      { ...notifyEmailBatchJob.options, jobId, delay },
    );
  },
  addDigestTick: async (brandId, hour) => {
    await queue.add(
      notifyDigestTickJob.name,
      { brandId, hour },
      { ...notifyDigestTickJob.options, jobId: notifyDigestTickJobId({ brandId, hour }) },
    );
  },
  addRebuild: async (brandId, jobId) => {
    await queue.add(
      notifyEmailRebuildJob.name,
      { brandId },
      { ...notifyEmailRebuildJob.options, jobId },
    );
  },
});

export interface EmailJobOptions {
  readonly db: Db;
  readonly engine: NotificationEmailEngine;
  readonly queue: NotifyEmailQueue;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

const HOUR_MS = 3_600_000;

/** The top of the hour `at` falls in, which is what a digest tick stands for. */
export const topOfHour = (at: Date): Date => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);

const liveBrandIds = async (db: Db): Promise<string[]> =>
  // `brands` is global and carries no policy; each brand's own work runs in
  // its own system transaction (DOMAIN-RULES §1.4).
  (await db.select({ id: brands.id }).from(brands).where(ne(brands.status, 'deleted'))).map(
    (row) => row.id,
  );

export const createEmailJobProcessors = ({
  db,
  engine,
  queue,
  log,
  now = () => new Date(),
}: EmailJobOptions) => {
  const placeAll = async (brandId: string, placements: readonly Placement[]): Promise<void> => {
    for (const placement of placements) {
      await queue.place(brandId, placement, now());
    }
  };
  const jobIdOf = (job: Job): string => job.id ?? job.name;

  const schedule = async (job: Job): Promise<void> => {
    const { brandId, notificationId } = parseJobPayloadOrFail(notifyEmailScheduleJob, job.data);
    const placement = await withSystemJob(db, brandId, jobIdOf(job), (tx) =>
      engine.schedule(tx, brandId, notificationId),
    );
    await placeAll(brandId, placement === null ? [] : [placement]);
  };

  return {
    // Upgrade hand-off: the retired payload names the same brand and notification.
    'notify.email': schedule,
    [notifyEmailScheduleJob.name]: schedule,

    [notifyEmailBatchJob.name]: async (job: Job, token?: string): Promise<void> => {
      const { brandId, batchId } = parseJobPayloadOrFail(notifyEmailBatchJob, job.data);
      let outcome: SendOutcome;
      try {
        outcome = await withSystemJob(db, brandId, jobIdOf(job), (tx) =>
          engine.send(tx, brandId, batchId),
        );
      } catch (error) {
        const lastAttempt =
          job.attemptsMade + 1 >= (job.opts.attempts ?? notifyEmailBatchJob.options.attempts ?? 1);
        if (!(error instanceof NotificationEmailDeliveryError) || !lastAttempt) throw error;
        const failed = await withSystemJob(db, brandId, jobIdOf(job), (tx) =>
          engine.recordFailure(tx, brandId, batchId),
        );
        if (failed) {
          log.warn(
            { brandId, batchId },
            'Notification email batch failed after 5 exhausted send jobs; rows skipped.',
          );
          return;
        }
        throw error;
      }
      if (outcome.kind === 'later') {
        // Early, over a cap, or held while its recipient is online: the
        // reason is committed with the batch, so the job only has to wait.
        await job.moveToDelayed(outcome.at.getTime(), token);
        // An urgent cut that committed after the hold found this job active
        // and could not move it, so look again now that it is delayed.
        try {
          const due = await withSystemJob(db, brandId, jobIdOf(job), (tx) =>
            engine.dueAt(tx, batchId),
          );
          if (due !== null && due < outcome.at) {
            await job.changeDelay(Math.max(0, due.getTime() - now().getTime()));
          }
        } catch (error) {
          // The job is already delayed and its lock released: failing it here
          // would only raise a spurious worker error. The hourly rebuild
          // places the earlier time instead.
          log.warn({ brandId, batchId, err: error }, 'Could not re-read the batch due time.');
        }
        throw new DelayedError();
      }
    },

    [notifyDigestTickJob.name]: async (job: Job): Promise<void> => {
      const payload = parseJobPayloadOrFail(notifyDigestTickJob, job.data);
      if (payload.brandId === undefined || payload.hour === undefined) {
        const hour = topOfHour(now()).toISOString();
        for (const brandId of await liveBrandIds(db)) {
          await queue.addDigestTick(brandId, hour);
        }
        return;
      }

      const { brandId } = payload;
      const hour = new Date(payload.hour);
      const placements = await withSystemJob(db, brandId, jobIdOf(job), (tx) =>
        engine.digestTick(tx, brandId, hour),
      );
      await placeAll(brandId, placements);
      log.info(
        { job: job.name, brandId, digests: placements.length },
        'notification digests opened',
      );
    },

    [notifyEmailRebuildJob.name]: async (job: Job): Promise<void> => {
      const payload = parseJobPayloadOrFail(notifyEmailRebuildJob, job.data);
      if (payload.brandId === undefined) {
        const tick = jobIdOf(job).replaceAll(':', '.');
        for (const brandId of await liveBrandIds(db)) {
          await queue.addRebuild(brandId, `${notifyEmailRebuildJob.name}.${brandId}.${tick}`);
        }
        return;
      }

      const { brandId } = payload;
      const placements = await withSystemJob(db, brandId, jobIdOf(job), (tx) =>
        engine.rebuild(tx, brandId),
      );
      await placeAll(brandId, placements);
      log.info(
        { job: job.name, brandId, batches: placements.length },
        'notification email rebuilt',
      );
    },
  } as const;
};
