import { brands, type Db } from '@helpdock/db';
import {
  createJobProcessor,
  type HelpCenterPublishDuePayload,
  helpCenterPublishDueJob,
  helpCenterPublishDueJobId,
  helpCenterPublishDueSweepJob,
  type JobLogger,
} from '@helpdock/jobs';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { HelpCenterRepository } from './help-center.repository.js';
import { publishDue } from './publish.js';

/**
 * How M5-01's scheduled publish runs in the worker.
 *
 * ```
 * schedule an article → outbox(help_center.article_changed, scheduled)  (request transaction)
 * handler             → delayed help_center.publish_due for that minute (events.ts)
 * publish_due         → publish every due version, outbox each           (brand's system transaction)
 * hourly sweep        → one publish_due per active brand                 (the safety net)
 * ```
 *
 * The `knowledge` queue carries both, and from M7 its ingest jobs too, so its
 * processor dispatches on the job name as the `rules` queue's does.
 */

export interface PublishDueQueue {
  add(payload: HelpCenterPublishDuePayload, jobId: string): Promise<void>;
}

/** The hour this sweep belongs to, so two firings in one hour add one job per brand. */
export const hourOf = (now: Date): string => {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
};

/** One `help_center.publish_due` per active brand. `brands` is global and read for ids alone. */
export const sweepPublishDue = async ({
  db,
  queue,
  now,
}: {
  readonly db: Db;
  readonly queue: PublishDueQueue;
  readonly now: Date;
}): Promise<number> => {
  const active = await db.select({ id: brands.id }).from(brands).where(eq(brands.status, 'active'));
  const tick = hourOf(now);
  for (const { id: brandId } of active) {
    const payload = { brandId, tick };
    await queue.add(payload, helpCenterPublishDueJobId(payload));
  }
  return active.length;
};

export interface HelpCenterProcessorOptions {
  readonly db: Db;
  readonly log: JobLogger;
  readonly queue: PublishDueQueue;
  readonly now?: () => Date;
}

export const createHelpCenterKnowledgeProcessor = ({
  db,
  log,
  queue,
  now = () => new Date(),
}: HelpCenterProcessorOptions): ((job: Job) => Promise<void>) => {
  const repository = new HelpCenterRepository();
  const publish = createJobProcessor(
    helpCenterPublishDueJob,
    async ({ payload, tx, job }) => {
      const published = await publishDue(tx, repository, {
        actor: { type: 'system', id: job.id ?? helpCenterPublishDueJob.name },
        now: now(),
      });
      log.info(
        { job: helpCenterPublishDueJob.name, brandId: payload.brandId, published },
        'scheduled help center articles published',
      );
    },
    { db, log },
  );

  return async (job) => {
    switch (job.name) {
      case helpCenterPublishDueJob.name:
        return publish(job);
      case helpCenterPublishDueSweepJob.name: {
        const brandsSwept = await sweepPublishDue({ db, queue, now: now() });
        log.info({ job: job.name, brands: brandsSwept }, 'help center publish sweep');
        return;
      }
      default:
        throw new UnrecoverableError(`No consumer for ${job.name} on the knowledge queue`);
    }
  };
};
